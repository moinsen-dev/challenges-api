import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { unique } from './helpers'

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
      return { status: res.status, body: parsed, location: res.headers.get('location') }
    },
  }
}

function stubGitHub(
  profile: Record<string, unknown>,
  emails: { email: string; primary: boolean; verified: boolean }[],
) {
  const original = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('https://github.com/login/oauth/access_token'))
      return Response.json({ access_token: 'gho_test' })
    if (url.startsWith('https://api.github.com/user/emails')) return Response.json(emails)
    if (url.startsWith('https://api.github.com/user')) return Response.json(profile)
    return original(input as RequestInfo, init)
  })
}

function mailbox() {
  const sent: { to: string; text: string }[] = []
  const original = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('https://api.resend.com/emails')) {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ id: 'mail_1' })
    }
    return original(input as RequestInfo, init)
  })
  return sent
}

async function githubSignIn(login: string, emails: { email: string; primary: boolean; verified: boolean }[]) {
  const b = browser()
  stubGitHub({ id: Math.floor(Math.random() * 1e9), login, two_factor_authentication: true }, emails)
  const start = await b.go('GET', '/v1/dev/auth/github')
  const state = new URL(start.location!).searchParams.get('state')!
  const done = await b.go('GET', `/v1/dev/auth/github/callback?code=abc&state=${state}`)
  return { b, done }
}

const configure = (allowlist?: string) => {
  ;(env as any).GITHUB_CLIENT_ID = 'client-id'
  ;(env as any).GITHUB_CLIENT_SECRET = 'client-secret'
  ;(env as any).RESEND_API_KEY = 're_test'
  ;(env as any).MAIL_FROM = 'console@challenges.test'
  ;(env as any).MAIL_LINK_BASE = 'https://api.test'
  ;(env as any).DEV_ALLOWLIST = allowlist
}

afterEach(() => {
  vi.unstubAllGlobals()
  ;(env as any).DEV_ALLOWLIST = undefined
  ;(env as any).RESEND_API_KEY = undefined
})

describe('Developer allowlist', () => {
  it('is open when no list is configured', async () => {
    configure(undefined)
    const { done } = await githubSignIn(unique('anyone'), [
      { email: `${unique('a')}@elsewhere.test`, primary: true, verified: true },
    ])
    expect(done.status).not.toBe(403)
  })

  it('lets a listed domain in and keeps everyone else out', async () => {
    configure('@moinsen.dev')
    const inside = await githubSignIn(unique('uli'), [
      { email: `${unique('uli')}@moinsen.dev`, primary: true, verified: true },
    ])
    expect(inside.done.status).not.toBe(403)
    expect((await inside.b.go('GET', '/v1/dev/me')).status).toBe(200)

    const outside = await githubSignIn(unique('stranger'), [
      { email: `${unique('s')}@example.test`, primary: true, verified: true },
    ])
    expect(outside.done.status).toBe(403)
    expect((await outside.b.go('GET', '/v1/dev/me')).status).toBe(401)
  })

  it('ignores an unverified address, however convincing it looks', async () => {
    configure('@moinsen.dev')
    // Anyone can type anything into their public GitHub profile.
    const faker = await githubSignIn(unique('faker'), [
      { email: 'ceo@moinsen.dev', primary: true, verified: false },
      { email: `${unique('f')}@example.test`, primary: false, verified: true },
    ])
    expect(faker.done.status).toBe(403)
  })

  it('accepts a verified non-primary address on the domain', async () => {
    configure('@moinsen.dev')
    const { done } = await githubSignIn(unique('second'), [
      { email: `${unique('x')}@example.test`, primary: true, verified: false },
      { email: `${unique('y')}@moinsen.dev`, primary: false, verified: true },
    ])
    expect(done.status).not.toBe(403)
  })

  it('can list a single address and a single GitHub login', async () => {
    configure(`hello@example.test, github:${'chosen-one'}`)
    const byLogin = await githubSignIn('chosen-one', [
      { email: `${unique('z')}@nowhere.test`, primary: true, verified: true },
    ])
    expect(byLogin.done.status).not.toBe(403)

    const byNothing = await githubSignIn(unique('other'), [
      { email: `${unique('z')}@nowhere.test`, primary: true, verified: true },
    ])
    expect(byNothing.done.status).toBe(403)
  })

  it('locks out an existing developer once they leave the list', async () => {
    configure('@moinsen.dev')
    const login = unique('leaver')
    const emails = [{ email: `${login}@moinsen.dev`, primary: true, verified: true }]
    expect((await githubSignIn(login, emails)).done.status).not.toBe(403)

    // The check runs on every sign-in, not only at first contact.
    configure('@somewhere-else.dev')
    const again = await githubSignIn(login, emails)
    expect(again.done.status).toBe(403)
  })

  it('sends no mail to an address outside the list, and says nothing about it', async () => {
    configure('@moinsen.dev')
    const sent = mailbox()
    const b = browser()

    const outside = await b.go('POST', '/v1/dev/auth/email', { email: `${unique('o')}@example.test` })
    expect(outside.status).toBe(202)
    expect(sent).toHaveLength(0)

    const inside = await b.go('POST', '/v1/dev/auth/email', { email: `${unique('i')}@moinsen.dev` })
    // Identical answer either way: no oracle for who may sign in here.
    expect(inside.status).toBe(202)
    expect(inside.body).toEqual(outside.body)
    expect(sent).toHaveLength(1)
  })

  it('records a rejected sign-in for the operator', async () => {
    configure('@moinsen.dev')
    const login = unique('rejected')
    await githubSignIn(login, [{ email: `${login}@example.test`, primary: true, verified: true }])
    const row = await env.DB.prepare(
      `SELECT detail FROM audit_log WHERE action = 'developer.rejected' ORDER BY id DESC LIMIT 1`,
    ).first<{ detail: string }>()
    expect(JSON.parse(row!.detail).login).toBe(login)
  })
})
