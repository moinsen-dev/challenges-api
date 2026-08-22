import { describe, expect, it } from 'vitest'
import { call, makeApp, makeDiscipline, signup, unique } from './helpers'

describe('Keys and authority', () => {
  it('shows both keys exactly once and stores only hashes', async () => {
    const keys = await makeApp()
    expect(keys.public_key).toMatch(/^chapi_pk_[0-9a-f]{64}$/)
    expect(keys.secret_key).toMatch(/^chapi_sk_[0-9a-f]{64}$/)
    const listed = await call('GET', '/v1/admin/apps', { admin: true })
    const row = listed.body.apps.find((a: any) => a.slug === keys.slug)
    expect(JSON.stringify(row)).not.toContain(keys.secret_key)
    expect(JSON.stringify(row)).not.toContain(keys.public_key)
  })

  it('rejects the public key on calls that need authority', async () => {
    const keys = await makeApp()
    for (const [path, body] of [
      ['/v1/disciplines', { slug: 'x', name: 'X' }],
      ['/v1/collections', { slug: 'x', name: 'X' }],
      ['/v1/matches', { discipline: 'x', placements: [] }],
      ['/v1/badges', { id: 'x', name: 'X', description: 'x', rule: {} }],
    ] as const) {
      const res = await call('POST', path, { key: keys.public_key, body })
      expect(res.status, path).toBe(403)
    }
  })

  it('lets the secret key make public calls too', async () => {
    const keys = await makeApp()
    const res = await call('GET', '/v1/catalog', { key: keys.secret_key })
    expect(res.status).toBe(200)
  })

  it('rejects unknown and missing keys', async () => {
    expect((await call('GET', '/v1/catalog', { key: 'chapi_pk_wrong' })).status).toBe(401)
    expect((await call('GET', '/v1/catalog')).status).toBe(401)
  })

  it('separates tenants: a foreign discipline is invisible', async () => {
    const a = await makeApp()
    const b = await makeApp()
    await makeDiscipline(a, { slug: 'geheim', name: 'Geheim', trust_tier: 1 })
    const player = await signup(b)
    const res = await call('POST', '/v1/entries', {
      key: b.public_key,
      token: player.token,
      body: { discipline: 'geheim', value: 1 },
    })
    expect(res.status).toBe(404)
  })
})

describe('Player sign-up', () => {
  it('creates an account without any details', async () => {
    const keys = await makeApp()
    const res = await call('POST', '/v1/auth/anonymous', { key: keys.public_key })
    expect(res.status).toBe(201)
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/)
    expect(res.body.handle.length).toBeGreaterThan(2)
  })

  it('rejects taken and too-short handles', async () => {
    const keys = await makeApp()
    const handle = unique('doppelt')
    await signup(keys, handle)
    expect((await call('POST', '/v1/auth/anonymous', { key: keys.public_key, body: { handle } })).status).toBe(409)
    expect((await call('POST', '/v1/auth/anonymous', { key: keys.public_key, body: { handle: 'ab' } })).status).toBe(400)
  })

  it('rejects invalid and missing tokens', async () => {
    const keys = await makeApp()
    expect((await call('GET', '/v1/me', { key: keys.public_key })).status).toBe(401)
    expect((await call('GET', '/v1/me', { key: keys.public_key, token: 'quatsch' })).status).toBe(401)
  })

  it('limits new accounts per app and hour', async () => {
    const keys = await makeApp()
    let limited = 0
    for (let i = 0; i < 62; i++) {
      const res = await call('POST', '/v1/auth/anonymous', { key: keys.public_key })
      if (res.status === 429) limited++
    }
    expect(limited).toBeGreaterThan(0)
  })

  it('leaves other apps untouched by that limit', async () => {
    const a = await makeApp()
    const b = await makeApp()
    for (let i = 0; i < 61; i++) await call('POST', '/v1/auth/anonymous', { key: a.public_key })
    expect((await call('POST', '/v1/auth/anonymous', { key: b.public_key })).status).toBe(201)
  })
})

describe('Identity across app boundaries', () => {
  it('carries the same identity into another app via one-time code', async () => {
    const a = await makeApp()
    const b = await makeApp()
    const player = await signup(a)
    const code = await call('POST', '/v1/me/link-code', { key: a.public_key, token: player.token })
    expect(code.body.code).toMatch(/^\d{6}$/)
    const redeemed = await call('POST', '/v1/auth/redeem', {
      key: b.public_key,
      body: { code: code.body.code },
    })
    expect(redeemed.body.id).toBe(player.player_id)
    expect(redeemed.body.token).not.toBe(player.token)
    // Beide Token gelten weiter: das alte Geraet wird nicht abgemeldet.
    expect((await call('GET', '/v1/me', { key: a.public_key, token: player.token })).status).toBe(200)
    expect((await call('GET', '/v1/me', { key: b.public_key, token: redeemed.body.token })).status).toBe(200)
  })

  it('redeems a code only once', async () => {
    const a = await makeApp()
    const player = await signup(a)
    const code = (await call('POST', '/v1/me/link-code', { key: a.public_key, token: player.token })).body.code
    expect((await call('POST', '/v1/auth/redeem', { key: a.public_key, body: { code } })).status).toBe(201)
    expect((await call('POST', '/v1/auth/redeem', { key: a.public_key, body: { code } })).status).toBe(409)
  })

  it('rejects unknown codes', async () => {
    const a = await makeApp()
    expect((await call('POST', '/v1/auth/redeem', { key: a.public_key, body: { code: '000000' } })).status).toBe(404)
  })

  it('makes the token valid platform-wide, even without a code', async () => {
    const a = await makeApp()
    const b = await makeApp()
    const player = await signup(a)
    // Die Identitaet haengt an der Plattform, nicht an der App.
    expect((await call('GET', '/v1/me', { key: b.public_key, token: player.token })).status).toBe(200)
  })
})

describe('Admin access', () => {
  it('requires the admin key', async () => {
    for (const path of ['/v1/admin/apps', '/v1/admin/events', '/v1/admin/regions/density']) {
      expect((await call('GET', path)).status, path).toBe(401)
    }
    expect((await call('POST', '/v1/admin/apps', { body: { slug: 'x', name: 'x' } })).status).toBe(401)
  })

  it('rejects a wrong admin key', async () => {
    const res = await call('GET', '/v1/admin/apps', { admin: false })
    expect(res.status).toBe(401)
  })
})
