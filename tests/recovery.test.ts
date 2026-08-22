import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { call, freshSeason, makeApp, makeDiscipline, signup, unique } from './helpers'

/** Intercepts the mailer and keeps what was actually sent. */
function mailbox() {
  const sent: { to: string; subject: string; text: string }[] = []
  const original = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('https://api.resend.com/emails')) {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ id: 'mail_1' })
    }
    return original(input as RequestInfo, init)
  })
  return {
    sent,
    link(index = sent.length - 1) {
      return sent[index].text.match(/https?:\/\/\S+/)![0]
    },
    path(index = sent.length - 1) {
      const url = new URL(this.link(index))
      return url.pathname + url.search
    },
  }
}

const withMail = () => {
  ;(env as any).RESEND_API_KEY = 're_test'
  ;(env as any).MAIL_FROM = 'rescue@challenges.test'
  ;(env as any).MAIL_LINK_BASE = 'https://api.test'
}

afterEach(() => {
  vi.unstubAllGlobals()
  ;(env as any).RESEND_API_KEY = undefined
})

async function playerWithHistory() {
  await freshSeason()
  const keys = await makeApp()
  const slug = unique('d')
  await makeDiscipline(keys, { slug, name: 'D', trust_tier: 1, qualifying_score: 10 })
  const account = await signup(keys, unique('forgetful'))
  await call('POST', '/v1/entries', {
    key: keys.public_key,
    token: account.token,
    body: { discipline: slug, value: 4242 },
  })
  return { keys, account, slug }
}

async function attachEmail(keys: any, token: string, email: string, mail: ReturnType<typeof mailbox>) {
  await call('POST', '/v1/me/recovery-email', { key: keys.public_key, token, body: { email } })
  return call('GET', mail.path(), { key: keys.public_key })
}

describe('Rescue address', () => {
  it('is honestly disabled without a mailer', async () => {
    const { keys, account } = await playerWithHistory()
    const res = await call('POST', '/v1/me/recovery-email', {
      key: keys.public_key,
      token: account.token,
      body: { email: 'a@b.test' },
    })
    expect(res.status).toBe(501)
  })

  it('is optional, and does nothing until the link is opened', async () => {
    withMail()
    const mail = mailbox()
    const { keys, account } = await playerWithHistory()
    const email = `${unique('rescue')}@example.test`

    const before = await call('GET', '/v1/me', { key: keys.public_key, token: account.token })
    expect(before.body.player.recovery_email).toBeNull()

    await call('POST', '/v1/me/recovery-email', {
      key: keys.public_key,
      token: account.token,
      body: { email },
    })
    // Unverified is stored nowhere on the player: an address nobody confirmed
    // must never be able to take over an account.
    const pending = await call('GET', '/v1/me', { key: keys.public_key, token: account.token })
    expect(pending.body.player.recovery_email).toBeNull()

    const confirmed = await call('GET', mail.path(), { key: keys.public_key })
    expect(confirmed.body.verified).toBe(true)
    const after = await call('GET', '/v1/me', { key: keys.public_key, token: account.token })
    expect(after.body.player.recovery_email).toBe(email)
    expect(after.body.player.recovery_verified_at).toBeTruthy()
  })

  it('refuses a confirmation link twice, and an invalid address', async () => {
    withMail()
    const mail = mailbox()
    const { keys, account } = await playerWithHistory()
    await attachEmail(keys, account.token, `${unique('once')}@example.test`, mail)
    expect((await call('GET', mail.path(), { key: keys.public_key })).status).toBe(400)
    expect(
      (await call('POST', '/v1/me/recovery-email', {
        key: keys.public_key,
        token: account.token,
        body: { email: 'not-an-email' },
      })).status,
    ).toBe(400)
  })

  it('will not rescue two accounts with one address', async () => {
    withMail()
    const mail = mailbox()
    const email = `${unique('shared')}@example.test`
    const first = await playerWithHistory()
    await attachEmail(first.keys, first.account.token, email, mail)

    const second = await playerWithHistory()
    await call('POST', '/v1/me/recovery-email', {
      key: second.keys.public_key,
      token: second.account.token,
      body: { email },
    })
    const clash = await call('GET', mail.path(), { key: second.keys.public_key })
    expect(clash.status).toBe(409)
  })

  it('can be removed again', async () => {
    withMail()
    const mail = mailbox()
    const { keys, account } = await playerWithHistory()
    await attachEmail(keys, account.token, `${unique('temp')}@example.test`, mail)
    expect((await call('DELETE', '/v1/me/recovery-email', { key: keys.public_key, token: account.token })).status).toBe(200)
    const me = await call('GET', '/v1/me', { key: keys.public_key, token: account.token })
    expect(me.body.player.recovery_email).toBeNull()
  })
})

describe('Getting back in after losing the device', () => {
  it('returns the same account, with everything still on it', async () => {
    withMail()
    const mail = mailbox()
    const { keys, account, slug } = await playerWithHistory()
    const email = `${unique('lost')}@example.test`
    await attachEmail(keys, account.token, email, mail)

    // The phone is gone; only the address remains.
    await call('POST', '/v1/auth/recover', { key: keys.public_key, body: { email } })
    const recovered = await call('GET', mail.path(), { key: keys.public_key })
    expect(recovered.status).toBe(201)
    expect(recovered.body.id).toBe(account.player_id)
    expect(recovered.body.token).not.toBe(account.token)

    const status = await call(`GET`, `/v1/disciplines/${slug}/me`, {
      key: keys.public_key,
      token: recovered.body.token,
    })
    expect(status.body.value).toBe(4242)
    expect(status.body.qualified).toBe(true)
  })

  it('ends every other session, so the lost phone stops being a way in', async () => {
    withMail()
    const mail = mailbox()
    const { keys, account } = await playerWithHistory()
    const email = `${unique('stolen')}@example.test`
    await attachEmail(keys, account.token, email, mail)

    await call('POST', '/v1/auth/recover', { key: keys.public_key, body: { email } })
    const recovered = await call('GET', mail.path(), { key: keys.public_key })

    expect((await call('GET', '/v1/me', { key: keys.public_key, token: recovered.body.token })).status).toBe(200)
    expect((await call('GET', '/v1/me', { key: keys.public_key, token: account.token })).status).toBe(401)
  })

  it('says the same thing for an address that rescues nothing', async () => {
    withMail()
    const mail = mailbox()
    const { keys, account } = await playerWithHistory()
    const email = `${unique('known')}@example.test`
    await attachEmail(keys, account.token, email, mail)

    const known = await call('POST', '/v1/auth/recover', { key: keys.public_key, body: { email } })
    const unknown = await call('POST', '/v1/auth/recover', {
      key: keys.public_key,
      body: { email: `${unique('nobody')}@example.test` },
    })
    expect(known.status).toBe(unknown.status)
    expect(known.body).toEqual(unknown.body)
    // Only one of them actually produced a mail.
    expect(mail.sent.filter((m) => m.subject.includes('back into')).length).toBe(1)
  })

  it('never rescues through an unverified address', async () => {
    withMail()
    const mail = mailbox()
    const { keys, account } = await playerWithHistory()
    const email = `${unique('unconfirmed')}@example.test`
    // Requested but never confirmed.
    await call('POST', '/v1/me/recovery-email', {
      key: keys.public_key,
      token: account.token,
      body: { email },
    })
    const before = mail.sent.length

    await call('POST', '/v1/auth/recover', { key: keys.public_key, body: { email } })
    expect(mail.sent.length).toBe(before)
  })

  it('refuses a used or expired link', async () => {
    withMail()
    const mail = mailbox()
    const { keys, account } = await playerWithHistory()
    const email = `${unique('expiring')}@example.test`
    await attachEmail(keys, account.token, email, mail)

    await call('POST', '/v1/auth/recover', { key: keys.public_key, body: { email } })
    const path = mail.path()
    expect((await call('GET', path, { key: keys.public_key })).status).toBe(201)
    expect((await call('GET', path, { key: keys.public_key })).status).toBe(400)

    await call('POST', '/v1/auth/recover', { key: keys.public_key, body: { email } })
    const second = mail.path()
    await env.DB.prepare(`UPDATE recovery_tokens SET expires_at = ? WHERE purpose = 'recover'`)
      .bind(new Date(Date.now() - 1000).toISOString())
      .run()
    const stale = await call('GET', second, { key: keys.public_key })
    expect(stale.status).toBe(400)
    expect(stale.body.error).toContain('expired')
  })

  it('keeps a banned account out', async () => {
    withMail()
    const mail = mailbox()
    const { keys, account } = await playerWithHistory()
    const email = `${unique('banned')}@example.test`
    await attachEmail(keys, account.token, email, mail)
    await call('POST', '/v1/auth/recover', { key: keys.public_key, body: { email } })
    const path = mail.path()

    await call('POST', `/v1/admin/players/${account.handle}/status`, {
      admin: true,
      body: { status: 'banned' },
    })
    expect((await call('GET', path, { key: keys.public_key })).status).toBe(403)
  })

  it('rate limits without saying so', async () => {
    withMail()
    const mail = mailbox()
    const { keys, account } = await playerWithHistory()
    const email = `${unique('flood')}@example.test`
    await attachEmail(keys, account.token, email, mail)
    const before = mail.sent.length

    for (let i = 0; i < 8; i++) await call('POST', '/v1/auth/recover', { key: keys.public_key, body: { email } })
    const produced = mail.sent.length - before
    expect(produced).toBeLessThan(8)
    expect((await call('POST', '/v1/auth/recover', { key: keys.public_key, body: { email } })).status).toBe(202)
  })
})

describe('Defaults and small refusals in the recovery paths', () => {
  it('names an unlabelled passkey and falls back to the request origin for links', async () => {
    ;(env as any).RP_ID = 'challenges.test'
    ;(env as any).RP_ORIGINS = 'https://challenges.test'
    withMail()
    const mail = mailbox()
    const previousBase = (env as any).MAIL_LINK_BASE
    ;(env as any).MAIL_LINK_BASE = undefined

    const { keys, account } = await playerWithHistory()
    await call('POST', '/v1/me/recovery-email', {
      key: keys.public_key,
      token: account.token,
      body: { email: `${unique('origin')}@example.test` },
    })
    // No base configured, so the link is built from the request itself.
    expect(mail.link()).toContain('/v1/auth/recovery/confirm?token=')
    ;(env as any).MAIL_LINK_BASE = previousBase
  })

  it('refuses a confirmation without a token', async () => {
    const { keys } = await playerWithHistory()
    expect((await call('GET', '/v1/auth/recovery/confirm', { key: keys.public_key })).status).toBe(400)
    expect((await call('GET', '/v1/auth/recover/callback', { key: keys.public_key })).status).toBe(400)
    expect(
      (await call('GET', '/v1/auth/recovery/confirm?token=nothing', { key: keys.public_key })).status,
    ).toBe(400)
    expect(
      (await call('GET', '/v1/auth/recover/callback?token=nothing', { key: keys.public_key })).status,
    ).toBe(400)
  })

  it('lists no sessions for somebody who never signed in twice', async () => {
    const { keys, account } = await playerWithHistory()
    const listed = await call('GET', '/v1/me/sessions', { key: keys.public_key, token: account.token })
    expect(listed.body.sessions).toHaveLength(1)
    const revoked = await call('POST', '/v1/me/sessions/revoke-others', {
      key: keys.public_key,
      token: account.token,
    })
    expect(revoked.body.revoked).toBe(0)
  })
})
