import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { call, makeApp, makeDiscipline, signup, unique } from './helpers'

/** Drive the worker while keeping cookies, the way a browser would. */
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
        if (value === '' ) jar.delete(name)
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
    get cookies() {
      return jar
    },
  }
}

/** A GitHub that answers exactly as GitHub does, without a network. */
function stubGitHub(
  profile: Record<string, unknown>,
  emails?: { email: string; primary: boolean; verified: boolean }[],
  token = 'gho_test',
) {
  const original = globalThis.fetch
  const inbox = emails ?? [
    { email: `${profile.login}@example.test`, primary: true, verified: true },
  ]
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('https://github.com/login/oauth/access_token'))
      return Response.json({ access_token: token, token_type: 'bearer' })
    // Order matters: /user/emails is a prefix match on /user too.
    if (url.startsWith('https://api.github.com/user/emails')) return Response.json(inbox)
    if (url.startsWith('https://api.github.com/user')) return Response.json(profile)
    return original(input as RequestInfo, init)
  })
}

async function signIn(
  profile: Record<string, unknown> = {},
  emails?: { email: string; primary: boolean; verified: boolean }[],
) {
  const b = browser()
  const full = {
    id: Math.floor(Math.random() * 1e9),
    login: unique('dev'),
    name: 'A Developer',
    email: 'dev@example.com',
    avatar_url: 'https://example.com/a.png',
    two_factor_authentication: true,
    ...profile,
  }
  stubGitHub(full, emails)
  const start = await b.go('GET', '/v1/dev/auth/github')
  const state = new URL(start.location!).searchParams.get('state')!
  const done = await b.go('GET', `/v1/dev/auth/github/callback?code=abc&state=${state}`)
  return { b, state, done, profile: full }
}

const withGitHub = () => {
  ;(env as any).GITHUB_CLIENT_ID = 'client-id'
  ;(env as any).GITHUB_CLIENT_SECRET = 'client-secret'
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GitHub sign-in', () => {
  it('is honestly disabled when not configured', async () => {
    ;(env as any).GITHUB_CLIENT_ID = undefined
    const b = browser()
    const res = await b.go('GET', '/v1/dev/auth/github')
    expect(res.status).toBe(501)
    expect(res.body.error).toContain('not configured')
  })

  it('redirects to GitHub with a state we minted', async () => {
    withGitHub()
    const b = browser()
    const res = await b.go('GET', '/v1/dev/auth/github')
    expect(res.status).toBe(302)
    const url = new URL(res.location!)
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('scope')).toContain('read:user')
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('creates a developer and an http-only session', async () => {
    withGitHub()
    const { b, done, profile } = await signIn()
    expect(done.setCookie).toContain('HttpOnly')
    expect(done.setCookie).toContain('Secure')
    expect(done.setCookie).toContain('SameSite=Lax')

    const me = await b.go('GET', '/v1/dev/me')
    expect(me.status).toBe(200)
    expect(me.body.login).toBe(profile.login)
    expect(me.body.two_factor).toBe(true)
    expect(me.body.app_quota).toBeGreaterThan(0)
  })

  it('recognises a returning developer instead of duplicating them', async () => {
    withGitHub()
    const first = await signIn({ id: 4242, login: 'stable-login' })
    const second = await signIn({ id: 4242, login: 'renamed-login' })
    const me = await second.b.go('GET', '/v1/dev/me')
    expect(me.body.login).toBe('renamed-login')
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM developers WHERE provider_id = '4242'`,
    ).first<{ n: number }>()
    expect(count!.n).toBe(1)
    expect(first.done.body.signed_in).toBe(true)
  })

  it('refuses a replayed or forged state', async () => {
    withGitHub()
    const { b, state } = await signIn()
    // The state was consumed by the successful callback.
    const replay = await b.go('GET', `/v1/dev/auth/github/callback?code=abc&state=${state}`)
    expect(replay.status).toBe(400)
    const forged = await b.go('GET', '/v1/dev/auth/github/callback?code=abc&state=deadbeef')
    expect(forged.status).toBe(400)
  })

  it('returns to the console when a redirect was requested', async () => {
    withGitHub()
    const b = browser()
    stubGitHub({ id: 5150, login: 'redirected', two_factor_authentication: true })
    const start = await b.go('GET', '/v1/dev/auth/github?redirect=https://console.test/apps')
    const state = new URL(start.location!).searchParams.get('state')!
    const done = await b.go('GET', `/v1/dev/auth/github/callback?code=abc&state=${state}`)
    expect(done.status).toBe(302)
    expect(done.location).toBe('https://console.test/apps')
  })

  it('refuses a callback without code or state', async () => {
    withGitHub()
    const b = browser()
    expect((await b.go('GET', '/v1/dev/auth/github/callback?code=abc')).status).toBe(400)
  })

  it('lists sessions and can end the others', async () => {
    withGitHub()
    const one = await signIn({ id: 777, login: 'two-devices' })
    const two = await signIn({ id: 777, login: 'two-devices' })

    expect((await two.b.go('GET', '/v1/dev/sessions')).body.sessions).toHaveLength(2)
    const revoked = await two.b.go('POST', '/v1/dev/sessions/revoke-others')
    expect(revoked.body.revoked).toBe(1)
    expect((await two.b.go('GET', '/v1/dev/me')).status).toBe(200)
    expect((await one.b.go('GET', '/v1/dev/me')).status).toBe(401)
  })

  it('signs out', async () => {
    withGitHub()
    const { b } = await signIn()
    expect((await b.go('POST', '/v1/dev/logout')).status).toBe(200)
    expect((await b.go('GET', '/v1/dev/me')).status).toBe(401)
  })

  it('keeps everything behind the session closed without one', async () => {
    const b = browser()
    for (const path of ['/v1/dev/me', '/v1/dev/apps', '/v1/dev/sessions', '/v1/dev/audit']) {
      expect((await b.go('GET', path)).status, path).toBe(401)
    }
  })
})

describe('Self-service apps', () => {
  it('creates an app with a key pair and lists it', async () => {
    withGitHub()
    const { b } = await signIn()
    const slug = unique('game')
    const created = await b.go('POST', '/v1/dev/apps', { slug, name: 'My Game' })
    expect(created.status).toBe(201)
    expect(created.body.public_key).toMatch(/^chapi_pk_[0-9a-f]{64}$/)
    expect(created.body.secret_key).toMatch(/^chapi_sk_[0-9a-f]{64}$/)

    const mine = await b.go('GET', '/v1/dev/apps')
    const row = mine.body.apps.find((a: any) => a.slug === slug)
    expect(row.live_keys).toBe(2)

    // The keys work immediately.
    const catalog = await call('GET', '/v1/catalog', { key: created.body.public_key })
    expect(catalog.status).toBe(200)
  })

  it('validates the slug and refuses a taken one', async () => {
    withGitHub()
    const { b } = await signIn()
    expect((await b.go('POST', '/v1/dev/apps', { slug: 'no', name: 'x' })).status).toBe(400)
    expect((await b.go('POST', '/v1/dev/apps', { slug: 'Not Lower', name: 'x' })).status).toBe(400)
    const slug = unique('taken')
    await b.go('POST', '/v1/dev/apps', { slug, name: 'x' })
    expect((await b.go('POST', '/v1/dev/apps', { slug, name: 'x' })).status).toBe(409)
  })

  it('enforces the app quota', async () => {
    withGitHub()
    const { b } = await signIn()
    await env.DB.prepare(`UPDATE developers SET app_quota = 1 WHERE login = ?`)
      .bind((await b.go('GET', '/v1/dev/me')).body.login)
      .run()
    expect((await b.go('POST', '/v1/dev/apps', { slug: unique('one'), name: 'x' })).status).toBe(201)
    const second = await b.go('POST', '/v1/dev/apps', { slug: unique('two'), name: 'x' })
    expect(second.status).toBe(409)
    expect(second.body.error).toContain('quota')
  })

  it('shows a developer only their own apps', async () => {
    withGitHub()
    const mine = await signIn({ id: 1001 })
    const theirs = await signIn({ id: 1002 })
    const slug = unique('private')
    await mine.b.go('POST', '/v1/dev/apps', { slug, name: 'x' })

    expect((await theirs.b.go('GET', '/v1/dev/apps')).body.apps.some((a: any) => a.slug === slug)).toBe(false)
    expect((await theirs.b.go('GET', `/v1/dev/apps/${slug}/keys`)).status).toBe(404)
  })
})

describe('Key lifecycle', () => {
  async function appWithKeys() {
    withGitHub()
    const { b } = await signIn()
    const slug = unique('keys')
    const created = await b.go('POST', '/v1/dev/apps', { slug, name: 'Keys' })
    return { b, slug, keys: created.body }
  }

  it('never shows a key again, only what you need to retire it', async () => {
    const { b, slug, keys } = await appWithKeys()
    const listed = await b.go('GET', `/v1/dev/apps/${slug}/keys`)
    expect(listed.body.keys).toHaveLength(2)
    expect(JSON.stringify(listed.body)).not.toContain(keys.secret_key)
    expect(JSON.stringify(listed.body)).not.toContain(keys.public_key)
    expect(listed.body.keys[0].prefix).toMatch(/^chapi_(pk|sk)$/)
  })

  it('records when a key was last used', async () => {
    const { b, slug, keys } = await appWithKeys()
    const before = (await b.go('GET', `/v1/dev/apps/${slug}/keys`)).body.keys
    expect(before.every((k: any) => k.last_used_at === null)).toBe(true)

    await call('GET', '/v1/catalog', { key: keys.public_key })
    const after = (await b.go('GET', `/v1/dev/apps/${slug}/keys`)).body.keys
    const used = after.find((k: any) => k.kind === 'public')
    expect(used.last_used_at).not.toBeNull()
    expect(after.find((k: any) => k.kind === 'secret').last_used_at).toBeNull()
  })

  it('rotates without a gap: both keys work until the old one is revoked', async () => {
    const { b, slug, keys } = await appWithKeys()
    const fresh = await b.go('POST', `/v1/dev/apps/${slug}/keys`, { kind: 'public', name: 'rotation' })
    expect(fresh.status).toBe(201)

    // Overlap is the point of rotation.
    expect((await call('GET', '/v1/catalog', { key: keys.public_key })).status).toBe(200)
    expect((await call('GET', '/v1/catalog', { key: fresh.body.key })).status).toBe(200)

    const old = (await b.go('GET', `/v1/dev/apps/${slug}/keys`)).body.keys.find(
      (k: any) => k.kind === 'public' && k.name === 'initial',
    )
    const revoked = await b.go('POST', `/v1/dev/keys/${old.id}/revoke`, { reason: 'rotated out' })
    expect(revoked.status).toBe(200)

    const refused = await call('GET', '/v1/catalog', { key: keys.public_key })
    expect(refused.status).toBe(401)
    expect(refused.body.error).toContain('revoked')
    expect((await call('GET', '/v1/catalog', { key: fresh.body.key })).status).toBe(200)
  })

  it('refuses to revoke the last live key of a kind', async () => {
    const { b, slug } = await appWithKeys()
    const only = (await b.go('GET', `/v1/dev/apps/${slug}/keys`)).body.keys.find((k: any) => k.kind === 'secret')
    const res = await b.go('POST', `/v1/dev/keys/${only.id}/revoke`, {})
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('replacement')
  })

  it('refuses to revoke twice and refuses foreign keys', async () => {
    const { b, slug } = await appWithKeys()
    await b.go('POST', `/v1/dev/apps/${slug}/keys`, { kind: 'public', name: 'second' })
    const old = (await b.go('GET', `/v1/dev/apps/${slug}/keys`)).body.keys.find(
      (k: any) => k.kind === 'public' && k.name === 'initial',
    )
    expect((await b.go('POST', `/v1/dev/keys/${old.id}/revoke`, {})).status).toBe(200)
    expect((await b.go('POST', `/v1/dev/keys/${old.id}/revoke`, {})).status).toBe(409)

    const stranger = await signIn({ id: 999001 })
    expect((await stranger.b.go('POST', `/v1/dev/keys/${old.id}/revoke`, {})).status).toBe(404)
  })

  it('honours an expiry date', async () => {
    const { b, slug } = await appWithKeys()
    const temp = await b.go('POST', `/v1/dev/apps/${slug}/keys`, {
      kind: 'public',
      name: 'temporary',
      expires_in_days: -1,
    })
    const res = await call('GET', '/v1/catalog', { key: temp.body.key })
    expect(res.status).toBe(401)
    expect(res.body.error).toContain('expired')
  })

  it('requires two-factor at the provider for a secret key', async () => {
    withGitHub()
    const { b } = await signIn({ two_factor_authentication: false })
    const slug = unique('no2fa')
    await b.go('POST', '/v1/dev/apps', { slug, name: 'x' })

    const refused = await b.go('POST', `/v1/dev/apps/${slug}/keys`, { kind: 'secret' })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toContain('two-factor')
    // A public key stays possible, so nobody is locked out of their own app.
    expect((await b.go('POST', `/v1/dev/apps/${slug}/keys`, { kind: 'public' })).status).toBe(201)
  })

  it('rejects an unknown kind', async () => {
    const { b, slug } = await appWithKeys()
    expect((await b.go('POST', `/v1/dev/apps/${slug}/keys`, { kind: 'master' })).status).toBe(400)
  })
})

describe('Audit trail', () => {
  it('records what a developer did, in order', async () => {
    withGitHub()
    const { b } = await signIn()
    const slug = unique('audited')
    await b.go('POST', '/v1/dev/apps', { slug, name: 'x' })
    await b.go('POST', `/v1/dev/apps/${slug}/keys`, { kind: 'public', name: 'second' })

    const log = await b.go('GET', '/v1/dev/audit')
    const actions = log.body.entries.map((e: any) => e.action)
    expect(actions).toContain('app.created')
    expect(actions).toContain('key.created')
    expect(actions).toContain('developer.signed_in')
    expect(log.body.entries[0].detail).toBeTruthy()
  })

  it('keeps one developer out of the log of another', async () => {
    withGitHub()
    const mine = await signIn({ id: 2001 })
    const theirs = await signIn({ id: 2002 })
    await mine.b.go('POST', '/v1/dev/apps', { slug: unique('secretive'), name: 'x' })
    const log = await theirs.b.go('GET', '/v1/dev/audit')
    expect(log.body.entries.every((e: any) => e.action !== 'app.created')).toBe(true)
  })
})

describe('The developer console', () => {
  it('is served as a page by the API itself', async () => {
    const res = await app.fetch(
      new Request('https://api.test/dashboard'),
      env as any,
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    // The page must not carry a key, a token or an origin of its own: it talks
    // to the API it was served by, using the cookie it was given.
    expect(html).not.toMatch(/chapi_(pk|sk)_/)
    expect(html).toContain('/v1/dev/auth/github')
    expect(html).toContain('noindex')
  })
})
