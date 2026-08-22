import { describe, expect, it } from 'vitest'
import { call, makeApp, makeDiscipline, signup } from './helpers'

async function duel() {
  const keys = await makeApp()
  await makeDiscipline(keys, {
    slug: 'duell',
    name: 'Duell',
    trust_tier: 2,
    head_to_head: true,
    max_title_level: 2,
  })
  const a = await signup(keys)
  const b = await signup(keys)
  const report = (placements: unknown[], extra: Record<string, unknown> = {}) =>
    call('POST', '/v1/matches', {
      key: keys.secret_key,
      body: { discipline: 'duell', placements, ...extra },
    })
  return { keys, a, b, report }
}

describe('Duels', () => {
  it('requires the secret key', async () => {
    const { keys, a, b } = await duel()
    const res = await call('POST', '/v1/matches', {
      key: keys.public_key,
      body: { discipline: 'duell', placements: [{ handle: a.handle, placement: 1 }, { handle: b.handle, placement: 2 }] },
    })
    expect(res.status).toBe(403)
  })

  it('accepts head-to-head disciplines only', async () => {
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'punkte', name: 'Punkte', trust_tier: 2 })
    const a = await signup(keys)
    const b = await signup(keys)
    const res = await call('POST', '/v1/matches', {
      key: keys.secret_key,
      body: { discipline: 'punkte', placements: [{ handle: a.handle, placement: 1 }, { handle: b.handle, placement: 2 }] },
    })
    expect(res.status).toBe(400)
  })

  it('requires at least two placements', async () => {
    const { a, report } = await duel()
    expect((await report([{ handle: a.handle, placement: 1 }])).status).toBe(400)
    expect((await report([])).status).toBe(400)
  })

  it('rejects unknown players', async () => {
    const { a, report } = await duel()
    const res = await report([
      { handle: a.handle, placement: 1 },
      { handle: 'niemand', placement: 2 },
    ])
    expect(res.status).toBe(404)
  })

  it('raises the winner and lowers the loser', async () => {
    const { a, b, report } = await duel()
    const res = await report([
      { handle: a.handle, placement: 1 },
      { handle: b.handle, placement: 2 },
    ])
    expect(res.status).toBe(201)
    expect(res.body.ratings[a.player_id].rating).toBeGreaterThan(1500)
    expect(res.body.ratings[b.player_id].rating).toBeLessThan(1500)
  })

  it('computes independently of processing order', async () => {
    const { a, b, report } = await duel()
    const first = await report([
      { handle: a.handle, placement: 1 },
      { handle: b.handle, placement: 2 },
    ])
    // Gewinn und Verlust sind symmetrisch, weil beide Ratings VOR dem Match
    // gelesen werden.
    const gain = first.body.ratings[a.player_id].rating - 1500
    const loss = 1500 - first.body.ratings[b.player_id].rating
    expect(gain).toBeCloseTo(loss, 0)
  })

  it('treats equal placements as a draw', async () => {
    const { a, b, report } = await duel()
    const res = await report([
      { handle: a.handle, placement: 1 },
      { handle: b.handle, placement: 1 },
    ])
    expect(res.body.ratings[a.player_id].rating).toBeCloseTo(res.body.ratings[b.player_id].rating, 0)
  })

  it('handles more than two participants', async () => {
    const { keys, a, b, report } = await duel()
    const c = await signup(keys)
    const res = await report([
      { handle: a.handle, placement: 1 },
      { handle: b.handle, placement: 2 },
      { handle: c.handle, placement: 3 },
    ])
    const [ra, rb, rc] = [a, b, c].map((p) => res.body.ratings[p.player_id].rating)
    expect(ra).toBeGreaterThan(rb)
    expect(rb).toBeGreaterThan(rc)
  })

  it('is idempotent, even under concurrent reports', async () => {
    const { a, b, report } = await duel()
    const placements = [
      { handle: a.handle, placement: 1 },
      { handle: b.handle, placement: 2 },
    ]
    const results = await Promise.all([
      report(placements, { idem_key: 'm1' }),
      report(placements, { idem_key: 'm1' }),
      report(placements, { idem_key: 'm1' }),
    ])
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.filter((r) => r.body.duplicate === true)).toHaveLength(2)
  })

  it('shows the rating list descending and only with matches', async () => {
    const { keys, a, b, report } = await duel()
    const zuschauer = await signup(keys)
    await report([
      { handle: a.handle, placement: 1 },
      { handle: b.handle, placement: 2 },
    ])
    const list = await call('GET', '/v1/ratings/duell', { key: keys.public_key })
    expect(list.body.ratings.map((r: any) => r.handle)).toEqual([a.handle, b.handle])
    expect(list.body.ratings.map((r: any) => r.handle)).not.toContain(zuschauer.handle)
  })
})
