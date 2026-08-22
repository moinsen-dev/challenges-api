import { describe, expect, it } from 'vitest'
import { call, makeApp, makeDiscipline, signup } from './helpers'

async function setup(body: Record<string, unknown> = {}) {
  const keys = await makeApp()
  await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1, ...body })
  const player = await signup(keys)
  return { keys, player }
}

const submit = (keys: any, token: string, body: Record<string, unknown>, key = keys.public_key) =>
  call('POST', '/v1/entries', { key, token, body: { discipline: 'd', ...body } })

describe('Entries validate their input', () => {
  it('rejects non-numeric values', async () => {
    const { keys, player } = await setup()
    for (const value of ['zwoelf', null, undefined, {}, [], NaN, Infinity]) {
      const res = await submit(keys, player.token, { value })
      expect(res.status, String(value)).toBe(400)
    }
  })

  it('accepts very large and very small numbers', async () => {
    const { keys, player } = await setup()
    expect((await submit(keys, player.token, { value: 1e15 })).status).toBe(201)
    expect((await submit(keys, player.token, { value: -1e15 })).status).toBe(201)
    expect((await submit(keys, player.token, { value: 0 })).status).toBe(201)
  })

  it('rejects timestamps far in the future', async () => {
    const { keys, player } = await setup()
    const future = new Date(Date.now() + 5 * 86400000).toISOString()
    expect((await submit(keys, player.token, { value: 1, occurred_at: future })).status).toBe(400)
  })

  it('limits meta to 4 KB', async () => {
    const { keys, player } = await setup()
    expect((await submit(keys, player.token, { value: 1, meta: { x: 'a'.repeat(3000) } })).status).toBe(201)
    expect((await submit(keys, player.token, { value: 1, meta: { x: 'a'.repeat(5000) } })).status).toBe(413)
  })

  it('holds values above the plausibility limit for review', async () => {
    const { keys, player } = await setup({ max_value: 1000 })
    const res = await submit(keys, player.token, { value: 5000 })
    expect(res.status).toBe(202)
    expect(res.body.status).toBe('review')
    const board = await call('GET', '/v1/leaderboards/d', { key: keys.public_key })
    expect(board.body.entries).toHaveLength(0)
  })

  it('applies the limit to negative outliers too', async () => {
    const { keys, player } = await setup({ max_value: 1000 })
    expect((await submit(keys, player.token, { value: -5000 })).status).toBe(202)
  })

  it('requires the secret key from trust tier 2 on', async () => {
    const { keys, player } = await setup({ trust_tier: 2, max_title_level: 2 })
    expect((await submit(keys, player.token, { value: 1 })).status).toBe(403)
    expect((await submit(keys, player.token, { value: 1 }, keys.secret_key)).status).toBe(201)
  })

  it('reads the day slice from local client time', async () => {
    const { keys, player } = await setup({ aggregation: 'streak' })
    await submit(keys, player.token, { value: 1, occurred_at: '2026-03-10T23:30:00+02:00' })
    await submit(keys, player.token, { value: 1, occurred_at: '2026-03-11T00:30:00+02:00' })
    const exported = await call('GET', '/v1/me/export', { key: keys.public_key, token: player.token })
    expect(exported.body.entries.map((e: any) => e.day).sort()).toEqual(['2026-03-10', '2026-03-11'])
  })
})

describe('Idempotency', () => {
  it('books the same key only once', async () => {
    const { keys, player } = await setup({ aggregation: 'sum' })
    const first = await submit(keys, player.token, { value: 10, idem_key: 'a' })
    const second = await submit(keys, player.token, { value: 10, idem_key: 'a' })
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBe(true)
    const status = await call('GET', '/v1/disciplines/d/me', { key: keys.public_key, token: player.token })
    expect(status.body.value).toBe(10)
  })

  it('separates idempotency keys per player', async () => {
    const { keys, player } = await setup({ aggregation: 'sum' })
    const other = await signup(keys)
    await submit(keys, player.token, { value: 10, idem_key: 'geteilt' })
    const res = await submit(keys, other.token, { value: 10, idem_key: 'geteilt' })
    expect(res.status).toBe(201)
  })

  it('holds under concurrent submissions', async () => {
    const { keys, player } = await setup({ aggregation: 'sum' })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => submit(keys, player.token, { value: 10, idem_key: 'parallel' })),
    )
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true)
    const status = await call('GET', '/v1/disciplines/d/me', { key: keys.public_key, token: player.token })
    expect(status.body.value).toBe(10)
  })
})

describe('Home region', () => {
  it('locks the region for the season', async () => {
    const { keys, player } = await setup()
    expect((await call('PATCH', '/v1/me/region', { key: keys.public_key, token: player.token, body: { region_id: 'hh-altona' } })).status).toBe(200)
    const again = await call('PATCH', '/v1/me/region', { key: keys.public_key, token: player.token, body: { region_id: 'hh-nord' } })
    expect(again.status).toBe(409)
    expect(again.body.region_id).toBe('hh-altona')
  })

  it('allows districts only', async () => {
    const { keys, player } = await setup()
    for (const region of ['hh-city', 'de', 'world']) {
      const res = await call('PATCH', '/v1/me/region', { key: keys.public_key, token: player.token, body: { region_id: region } })
      expect(res.status, region).toBe(400)
    }
  })

  it('rejects unknown regions', async () => {
    const { keys, player } = await setup()
    expect((await call('PATCH', '/v1/me/region', { key: keys.public_key, token: player.token, body: { region_id: 'atlantis' } })).status).toBe(404)
  })

  it('attaches the region to the entry, not to the player', async () => {
    const { keys, player } = await setup()
    await submit(keys, player.token, { value: 1 })
    await call('PATCH', '/v1/me/region', { key: keys.public_key, token: player.token, body: { region_id: 'hh-altona' } })
    await submit(keys, player.token, { value: 2 })
    // Der erste Eintrag entstand ohne Region und zaehlt regional nicht mit.
    const board = await call('GET', '/v1/leaderboards/d?region=hh-altona', { key: keys.public_key })
    expect(board.body.entries[0].value).toBe(2)
  })
})

describe('Daily challenge', () => {
  it('returns the same seed for the same day', async () => {
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1 })
    const a = await call('GET', '/v1/daily/d?date=2026-09-01', { key: keys.public_key })
    const b = await call('GET', '/v1/daily/d?date=2026-09-01', { key: keys.public_key })
    const c = await call('GET', '/v1/daily/d?date=2026-09-02', { key: keys.public_key })
    expect(a.body.seed).toBe(b.body.seed)
    expect(a.body.seed).not.toBe(c.body.seed)
    expect(Number.isInteger(a.body.seed)).toBe(true)
  })

  it('returns different seeds for different disciplines', async () => {
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1 })
    await makeDiscipline(keys, { slug: 'e', name: 'E', trust_tier: 1 })
    const d = await call('GET', '/v1/daily/d?date=2026-09-01', { key: keys.public_key })
    const e = await call('GET', '/v1/daily/e?date=2026-09-01', { key: keys.public_key })
    expect(d.body.seed).not.toBe(e.body.seed)
  })
})

describe('Creating disciplines', () => {
  it('couples title reach to the trust tier', async () => {
    const keys = await makeApp()
    expect((await call('POST', '/v1/disciplines', { key: keys.secret_key, body: { slug: 'a', name: 'A', trust_tier: 0, max_title_level: 1 } })).status).toBe(400)
    expect((await call('POST', '/v1/disciplines', { key: keys.secret_key, body: { slug: 'b', name: 'B', trust_tier: 1, max_title_level: 3 } })).status).toBe(400)
    expect((await call('POST', '/v1/disciplines', { key: keys.secret_key, body: { slug: 'c', name: 'C', trust_tier: 1, max_title_level: 2 } })).status).toBe(201)
    expect((await call('POST', '/v1/disciplines', { key: keys.secret_key, body: { slug: 'e', name: 'E', trust_tier: 2, max_title_level: 6 } })).status).toBe(201)
  })

  it('rejects unknown aggregations', async () => {
    const keys = await makeApp()
    const res = await call('POST', '/v1/disciplines', { key: keys.secret_key, body: { slug: 'x', name: 'X', aggregation: 'median' } })
    expect(res.status).toBe(400)
  })
})
