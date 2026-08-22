import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'
import { CATALOGUE, buildDocument, registeredRoutes } from '../src/openapi'
import { call } from './helpers'

const ctx = { waitUntil() {}, passThroughOnException() {} } as ExecutionContext

describe('The description matches the thing described', () => {
  const described = CATALOGUE.map(([method, path]) => `${method} ${path}`).sort()
  const registered = registeredRoutes()

  it('describes every route the service actually has', () => {
    const missing = registered.filter((route) => !described.includes(route))
    // A specification that silently drifts is worse than none, because people
    // build against it. This is the test that keeps it honest.
    expect(missing, `undocumented routes:\n${missing.join('\n')}`).toEqual([])
  })

  it('describes nothing the service does not have', () => {
    const phantom = described.filter((route) => !registered.includes(route))
    expect(phantom, `documented but absent:\n${phantom.join('\n')}`).toEqual([])
  })

  it('gives every operation a summary that says something', () => {
    for (const [method, path, , , summary] of CATALOGUE) {
      expect(summary.length, `${method} ${path}`).toBeGreaterThan(15)
      expect(summary.endsWith('.'), `${method} ${path} should not end in a full stop`).toBe(false)
    }
  })

  it('never puts a secret-key route behind the public key', () => {
    for (const [method, path, auth] of CATALOGUE) {
      const writesAuthority =
        path.startsWith('/v1/verifier/modules') ||
        path === '/v1/matches' ||
        path === '/v1/disciplines' ||
        path.startsWith('/v1/webhooks')
      if (writesAuthority && method !== 'GET')
        expect(auth, `${method} ${path}`).toBe('secret')
    }
  })
})

describe('The OpenAPI document', () => {
  it('is served, and is a valid-looking 3.1 document', async () => {
    const res = await worker.fetch(
      new Request('https://api.test/v1/openapi.json'),
      env as any,
      ctx,
    )
    expect(res.status).toBe(200)
    const doc: any = await res.json()

    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info.title).toBe('Challenges API')
    expect(doc.info.license.name).toBe('CC0-1.0')
    expect(doc.servers[0].url).toBe('https://api.test')
    expect(Object.keys(doc.paths).length).toBeGreaterThan(80)
  })

  it('turns Hono parameters into OpenAPI parameters', () => {
    const doc: any = buildDocument('https://api.test')
    const board = doc.paths['/v1/leaderboards/{discipline}'].get
    expect(board.parameters[0]).toEqual({
      name: 'discipline',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    })
    expect(doc.paths['/v1/leaderboards/:discipline']).toBeUndefined()
  })

  it('marks each operation with the credential it needs', () => {
    const doc: any = buildDocument('https://api.test')
    expect(doc.paths['/v1/entries'].post.security).toEqual([{ appKey: [], playerToken: [] }])
    expect(doc.paths['/v1/disciplines'].post.security).toEqual([{ appSecret: [] }])
    expect(doc.paths['/v1/admin/apps'].post.security).toEqual([{ adminKey: [] }])
    // A title card is public on purpose: an image nobody can embed is not one.
    expect(doc.paths['/v1/titles/{id}/card.svg'].get.security).toEqual([])
  })

  it('gives every operation a unique id, which is what code generators need', () => {
    const doc: any = buildDocument('https://api.test')
    const ids: string[] = []
    for (const operations of Object.values(doc.paths) as any[])
      for (const operation of Object.values(operations) as any[]) ids.push(operation.operationId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('Health', () => {
  it('reports the checks it actually performed', async () => {
    const res = await worker.fetch(new Request('https://api.test/v1/health'), env as any, ctx)
    expect(res.status).toBe(200)
    const body: any = await res.json()

    expect(body.status).toBe('ok')
    expect(body.checks.database.ok).toBe(true)
    expect(body.checks.blobs.ok).toBe(true)
    expect(typeof body.checks.database.ms).toBe('number')
    expect(body.queues).toHaveProperty('verification')
    expect(body.queues).toHaveProperty('webhooks')
    expect(body.queues).toHaveProperty('review')
    expect(body.queues).toHaveProperty('reports')
  })

  it('shows the open season, and needs no credential to answer', async () => {
    const res = await worker.fetch(new Request('https://api.test/v1/health'), env as any, ctx)
    const body: any = await res.json()
    expect(body.season).toBeTruthy()
    expect(body.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
