import { env } from 'cloudflare:test'
import app from '../src/index'

export type Keys = { slug: string; public_key: string; secret_key: string }

let counter = 0
export const unique = (prefix: string) => `${prefix}-${++counter}-${Math.floor(Math.random() * 1e6)}`

export async function call(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; key?: string; admin?: boolean } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.key) headers['X-App-Key'] = opts.key
  if (opts.admin) headers['X-Admin-Key'] = 'test-admin-key'
  const res = await app.fetch(
    new Request(`https://test.local${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
  )
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body }
}

export async function makeApp(name = 'App'): Promise<Keys> {
  const created = await call('POST', '/v1/admin/apps', {
    admin: true,
    body: { slug: unique('app'), name },
  })
  return created.body as Keys
}

export async function makeDiscipline(keys: Keys, body: Record<string, unknown>) {
  const created = await call('POST', '/v1/disciplines', { key: keys.secret_key, body })
  return created.body
}

export async function signup(keys: Keys, handle = unique('spieler')) {
  const created = await call('POST', '/v1/auth/anonymous', {
    key: keys.public_key,
    body: { handle },
  })
  return created.body as { player_id: string; handle: string; token: string }
}

/**
 * Frische offene Saison. Der Zustand einer Testdatei bleibt zwischen den Tests
 * bestehen, deshalb darf sich kein Test auf die Saison eines anderen verlassen.
 */
export async function freshSeason() {
  const id = unique('season')
  await env.DB.batch([
    env.DB.prepare(`UPDATE seasons SET status = 'closed' WHERE status = 'open'`),
    env.DB.prepare(
      `INSERT INTO seasons (id, name, starts_at, ends_at, status)
       VALUES (?, 'Test season', '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'open')`,
    ).bind(id),
  ])
  return id
}
