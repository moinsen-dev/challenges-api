import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { call, unique } from './helpers'

function browser() {
  const jar = new Map<string, string>()
  return {
    async go(method: string, path: string, body?: unknown) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
      const res = await app.fetch(
        new Request(`https://api.test${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
        }),
        env,
        { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
      )
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) {
        const [pair] = setCookie.split(';')
        const [name, value] = pair.split('=')
        if (value === '') jar.delete(name)
        else jar.set(name, value)
      }
      const text = await res.text()
      let parsed: any
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { raw: text }
      }
      return { status: res.status, body: parsed, location: res.headers.get('location'), setCookie }
    },
  }
}

/** A mailbox: intercepts the Resend call and keeps what was actually sent. */
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
    get last() {
      return sent[sent.length - 1]
    },
    linkFrom(text = sent[sent.length - 1].text) {
      return text.match(/https?:\/\/\S+/)![0]
    },
    codeFrom(text = sent[sent.length - 1].text) {
      return text.match(/code in the tab you started from:\s+(\d{6})/)![1]
    },
  }
}

const withMail = () => {
  ;(env as any).RESEND_API_KEY = 're_test'
  ;(env as any).MAIL_FROM = 'console@challenges.test'
  ;(env as any).MAIL_LINK_BASE = 'https://api.test'
}

afterEach(() => {
  vi.unstubAllGlobals()
  ;(env as any).RESEND_API_KEY = undefined
})

describe('Email sign-in', () => {
  it('is honestly disabled when no mailer is configured', async () => {
    ;(env as any).RESEND_API_KEY = undefined
    const res = await browser().go('POST', '/v1/dev/auth/email', { email: 'a@b.test' })
    expect(res.status).toBe(501)
  })

  it('sends a link and a code that both work once', async () => {
    withMail()
    const mail = mailbox()
    const b = browser()
    const email = `${unique('dev')}@example.test`

    const asked = await b.go('POST', '/v1/dev/auth/email', { email })
    expect(asked.status).toBe(202)
    expect(asked.body.sent).toBe(true)
    // Nothing secret ever comes back in the response.
    expect(JSON.stringify(asked.body)).not.toContain('token')

    expect(mail.last.to).toBe(email)
    expect(mail.last.subject).toMatch(/\d{6}/)
    const link = mail.linkFrom()

    const done = await b.go('GET', new URL(link).pathname + new URL(link).search)
    expect(done.setCookie).toContain('HttpOnly')
    const me = await b.go('GET', '/v1/dev/me')
    expect(me.body.provider).toBe('email')
    expect(me.body.login).toBe(email.split('@')[0])

    // The same link a second time is dead.
    const replay = await browser().go('GET', new URL(link).pathname + new URL(link).search)
    expect(replay.status).toBe(400)
  })

  it('signs in with the six-digit code, in the tab you started from', async () => {
    withMail()
    const mail = mailbox()
    const b = browser()
    const email = `${unique('dev')}@example.test`
    await b.go('POST', '/v1/dev/auth/email', { email })

    const verified = await b.go('POST', '/v1/dev/auth/email/verify', { email, code: mail.codeFrom() })
    expect(verified.status).toBe(200)
    expect((await b.go('GET', '/v1/dev/me')).body.email).toBe(email)
  })

  it('kills a code after a handful of wrong guesses', async () => {
    withMail()
    const mail = mailbox()
    const b = browser()
    const email = `${unique('dev')}@example.test`
    await b.go('POST', '/v1/dev/auth/email', { email })
    const real = mail.codeFrom()

    for (let i = 1; i <= 4; i++) {
      const wrong = await b.go('POST', '/v1/dev/auth/email/verify', { email, code: '000000' })
      expect(wrong.status).toBe(401)
      expect(wrong.body.attempts_left).toBe(5 - i)
    }
    const last = await b.go('POST', '/v1/dev/auth/email/verify', { email, code: '000000' })
    expect(last.status).toBe(429)
    // Even the correct code is worthless now.
    expect((await b.go('POST', '/v1/dev/auth/email/verify', { email, code: real })).status).toBe(400)
  })

  it('invalidates older links when one is used', async () => {
    withMail()
    const mail = mailbox()
    const b = browser()
    const email = `${unique('dev')}@example.test`
    await b.go('POST', '/v1/dev/auth/email', { email })
    const first = mail.linkFrom()
    await b.go('POST', '/v1/dev/auth/email', { email })
    const second = mail.linkFrom()

    const used = await b.go('GET', new URL(second).pathname + new URL(second).search)
    expect(used.body.signed_in ?? used.status === 302).toBeTruthy()
    // A forwarded older mail is dead.
    expect((await browser().go('GET', new URL(first).pathname + new URL(first).search)).status).toBe(400)
  })

  it('expires a link', async () => {
    withMail()
    const mail = mailbox()
    const b = browser()
    const email = `${unique('dev')}@example.test`
    await b.go('POST', '/v1/dev/auth/email', { email })
    const link = mail.linkFrom()
    await env.DB.prepare(`UPDATE login_tokens SET expires_at = ? WHERE email = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), email)
      .run()
    const res = await browser().go('GET', new URL(link).pathname + new URL(link).search)
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('expired')
  })

  it('answers the same whether the address is known or not', async () => {
    withMail()
    mailbox()
    const b = browser()
    const known = `${unique('dev')}@example.test`
    const first = await b.go('POST', '/v1/dev/auth/email', { email: known })
    const second = await b.go('POST', '/v1/dev/auth/email', { email: `${unique('nobody')}@example.test` })
    // No oracle for "does this person have an account here".
    expect(first.status).toBe(second.status)
    expect(first.body).toEqual(second.body)
  })

  it('rate limits, without telling the caller', async () => {
    withMail()
    const mail = mailbox()
    const b = browser()
    const email = `${unique('flood')}@example.test`
    for (let i = 0; i < 7; i++) await b.go('POST', '/v1/dev/auth/email', { email })
    expect(mail.sent.length).toBe(5)
    const last = await b.go('POST', '/v1/dev/auth/email', { email })
    expect(last.status).toBe(202)
    expect(last.body.sent).toBe(true)
  })

  it('validates the address and the code shape', async () => {
    withMail()
    mailbox()
    const b = browser()
    expect((await b.go('POST', '/v1/dev/auth/email', { email: 'not-an-email' })).status).toBe(400)
    expect((await b.go('POST', '/v1/dev/auth/email', {})).status).toBe(400)
    expect((await b.go('POST', '/v1/dev/auth/email/verify', { email: 'a@b.test', code: '12' })).status).toBe(400)
    expect((await b.go('GET', '/v1/dev/auth/email/callback')).status).toBe(400)
  })

  it('treats an address as one account, however it is typed', async () => {
    withMail()
    const mail = mailbox()
    const raw = `${unique('Mixed')}@Example.TEST`
    await browser().go('POST', '/v1/dev/auth/email', { email: raw })
    const first = mail.linkFrom()
    await browser().go('GET', new URL(first).pathname + new URL(first).search)

    await browser().go('POST', '/v1/dev/auth/email', { email: raw.toLowerCase() })
    const second = mail.linkFrom()
    await browser().go('GET', new URL(second).pathname + new URL(second).search)

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM developers WHERE provider = 'email' AND provider_id = ?`,
    )
      .bind(raw.toLowerCase())
      .first<{ n: number }>()
    expect(count!.n).toBe(1)
  })

  it('keeps an email account separate from a GitHub account', async () => {
    // No automatic linking by address: a provider email is not proof of
    // ownership, and linking on it would be an account takeover waiting.
    withMail()
    const mail = mailbox()
    const email = `${unique('shared')}@example.test`
    await browser().go('POST', '/v1/dev/auth/email', { email })
    await browser().go('GET', new URL(mail.linkFrom()).pathname + new URL(mail.linkFrom()).search)

    await env.DB.prepare(
      `INSERT INTO developers (id, provider, provider_id, login, email, two_factor, created_at, last_seen)
       VALUES (?, 'github', ?, 'gh-user', ?, 1, ?, ?)`,
    )
      .bind(unique('dev'), unique('gh'), email, new Date().toISOString(), new Date().toISOString())
      .run()

    const both = await env.DB.prepare(`SELECT COUNT(*) AS n FROM developers WHERE email = ?`)
      .bind(email)
      .first<{ n: number }>()
    expect(both!.n).toBe(2)
  })
})

describe('Secret keys from an email account', () => {
  async function signedIn() {
    withMail()
    const mail = mailbox()
    const b = browser()
    const email = `${unique('dev')}@example.test`
    await b.go('POST', '/v1/dev/auth/email', { email })
    const link = mail.linkFrom()
    await b.go('GET', new URL(link).pathname + new URL(link).search)
    const slug = unique('app')
    const created = await b.go('POST', '/v1/dev/apps', { slug, name: 'App' })
    return { b, slug, email, created }
  }

  it('is allowed right after signing in', async () => {
    const { b, slug } = await signedIn()
    const key = await b.go('POST', `/v1/dev/apps/${slug}/keys`, { kind: 'secret', name: 'server' })
    expect(key.status).toBe(201)
    expect(key.body.key).toMatch(/^chapi_sk_/)
  })

  it('asks for a fresh sign-in once the session has aged', async () => {
    const { b, slug, email } = await signedIn()
    await env.DB.prepare(
      `UPDATE developer_sessions SET created_at = ?
        WHERE developer_id = (SELECT id FROM developers WHERE provider_id = ?)`,
    )
      .bind(new Date(Date.now() - 60 * 60_000).toISOString(), email)
      .run()

    const refused = await b.go('POST', `/v1/dev/apps/${slug}/keys`, { kind: 'secret' })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toContain('sign in again')
    // A public key stays available, so an app never becomes unusable.
    expect((await b.go('POST', `/v1/dev/apps/${slug}/keys`, { kind: 'public' })).status).toBe(201)
  })

  it('works again after signing in once more', async () => {
    const { b, slug, email } = await signedIn()
    await env.DB.prepare(
      `UPDATE developer_sessions SET created_at = ?
        WHERE developer_id = (SELECT id FROM developers WHERE provider_id = ?)`,
    )
      .bind(new Date(Date.now() - 60 * 60_000).toISOString(), email)
      .run()
    expect((await b.go('POST', `/v1/dev/apps/${slug}/keys`, { kind: 'secret' })).status).toBe(403)

    const mail = mailbox()
    await b.go('POST', '/v1/dev/auth/email', { email })
    const link = mail.linkFrom()
    await b.go('GET', new URL(link).pathname + new URL(link).search)

    const key = await b.go('POST', `/v1/dev/apps/${slug}/keys`, { kind: 'secret' })
    expect(key.status).toBe(201)
    const usable = await call('POST', '/v1/disciplines', {
      key: key.body.key,
      body: { slug: 'd', name: 'D', trust_tier: 1 },
    })
    expect(usable.status).toBe(201)
  })
})
