import { describe, expect, it } from 'vitest'
import { call, makeApp, makeDiscipline, signup } from './helpers'

const dayShift = (n: number) => new Date(Date.now() + n * 86400000).toISOString()

async function setup(body: Record<string, unknown>) {
  const keys = await makeApp()
  await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1, ...body })
  const player = await signup(keys)
  const submit = (value: number, extra: Record<string, unknown> = {}) =>
    call('POST', '/v1/entries', {
      key: keys.public_key,
      token: player.token,
      body: { discipline: 'd', value, ...extra },
    })
  const status = () =>
    call('GET', '/v1/disciplines/d/me', { key: keys.public_key, token: player.token })
  return { keys, player, submit, status }
}

describe('Aggregation: best', () => {
  it('takes the highest value for desc', async () => {
    const { submit, status } = await setup({ aggregation: 'best' })
    await submit(10)
    await submit(30)
    await submit(20)
    expect((await status()).body.value).toBe(30)
  })

  it('takes the lowest value for asc', async () => {
    const { submit, status } = await setup({ aggregation: 'best', score_direction: 'asc' })
    await submit(90)
    await submit(42)
    await submit(55)
    expect((await status()).body.value).toBe(42)
  })

  it('handles negative values', async () => {
    const { submit, status } = await setup({ aggregation: 'best' })
    await submit(-50)
    await submit(-10)
    expect((await status()).body.value).toBe(-10)
  })
})

describe('Aggregation: sum', () => {
  it('sums every entry', async () => {
    const { submit, status } = await setup({ aggregation: 'sum' })
    for (const v of [30, 45, 20]) await submit(v)
    expect((await status()).body.value).toBe(95)
  })

  it('sums upwards even with score_direction asc', async () => {
    // Bei sum/count/streak ist mehr immer besser, die Richtung gilt nur fuer best.
    const { submit, status } = await setup({ aggregation: 'sum', score_direction: 'asc' })
    await submit(10)
    await submit(5)
    expect((await status()).body.value).toBe(15)
  })

  it('handles fractional values', async () => {
    const { submit, status } = await setup({ aggregation: 'sum' })
    await submit(7.2)
    await submit(3.8)
    expect((await status()).body.value).toBeCloseTo(11, 6)
  })
})

describe('Aggregation: count', () => {
  it('counts entries instead of values', async () => {
    const { submit, status } = await setup({ aggregation: 'count' })
    for (const v of [1, 999, 0]) await submit(v)
    expect((await status()).body.value).toBe(3)
  })
})

describe('Aggregation: streak', () => {
  it('counts consecutive days', async () => {
    const { submit, status } = await setup({ aggregation: 'streak' })
    for (let i = 4; i >= 0; i--) await submit(1, { occurred_at: dayShift(-i) })
    const body = (await status()).body
    expect(body.value).toBe(5)
    expect(body.streak_days).toBe(5)
  })

  it('counts several entries on one day only once', async () => {
    const { submit, status } = await setup({ aggregation: 'streak' })
    await submit(1, { occurred_at: dayShift(-1) })
    await submit(1, { occurred_at: dayShift(-1) })
    await submit(1, { occurred_at: dayShift(0) })
    expect((await status()).body.value).toBe(2)
  })

  it('breaks the streak on a gap and reports the longest', async () => {
    const { submit, status } = await setup({ aggregation: 'streak' })
    for (const d of [-9, -8, -7, -5, -4]) await submit(1, { occurred_at: dayShift(d) })
    const body = (await status()).body
    expect(body.value).toBe(3) // laengste Serie
    expect(body.streak_days).toBe(0) // laufende Serie ist gerissen
  })

  it('keeps a streak ending yesterday alive', async () => {
    const { submit, status } = await setup({ aggregation: 'streak' })
    await submit(1, { occurred_at: dayShift(-2) })
    await submit(1, { occurred_at: dayShift(-1) })
    expect((await status()).body.streak_days).toBe(2)
  })

  it('counts across a month boundary', async () => {
    const { submit, status } = await setup({ aggregation: 'streak' })
    for (const day of ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']) {
      await submit(1, { occurred_at: `${day}T12:00:00Z` })
    }
    expect((await status()).body.value).toBe(4)
  })

  it('reports null without any entry', async () => {
    const { status } = await setup({ aggregation: 'streak' })
    const body = (await status()).body
    expect(body.value).toBe(null)
    expect(body.streak_days).toBe(0)
  })
})

describe('Qualification', () => {
  it('checks the aggregate, not the single entry', async () => {
    const { submit } = await setup({ aggregation: 'sum', qualifying_score: 100 })
    expect((await submit(60)).body.qualified).toBe(false)
    const second = await submit(50)
    expect(second.body.aggregate).toBe(110)
    expect(second.body.qualified_now).toBe(true)
  })

  it('qualifies on asc when the value is small enough', async () => {
    const { submit } = await setup({
      aggregation: 'best',
      score_direction: 'asc',
      qualifying_score: 60,
    })
    expect((await submit(90)).body.qualified).toBe(false)
    expect((await submit(42)).body.qualified_now).toBe(true)
  })

  it('qualifies exactly on the bar', async () => {
    const { submit } = await setup({ aggregation: 'best', qualifying_score: 100 })
    expect((await submit(100)).body.qualified_now).toBe(true)
  })

  it('qualifies everyone when no bar is set', async () => {
    const { submit } = await setup({ aggregation: 'best' })
    const res = await submit(1)
    expect(res.body.qualified).toBe(true)
    expect(res.body.rank.global.rank).toBe(1)
  })

  it('stays qualified even when later entries are weaker', async () => {
    const { submit } = await setup({ aggregation: 'best', qualifying_score: 50 })
    await submit(80)
    expect((await submit(1)).body.qualified).toBe(true)
  })
})

describe('Leaderboards', () => {
  it('shows qualified players only', async () => {
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1, qualifying_score: 100 })
    const stark = await signup(keys)
    const schwach = await signup(keys)
    await call('POST', '/v1/entries', { key: keys.public_key, token: stark.token, body: { discipline: 'd', value: 500 } })
    await call('POST', '/v1/entries', { key: keys.public_key, token: schwach.token, body: { discipline: 'd', value: 10 } })
    const board = await call('GET', '/v1/leaderboards/d', { key: keys.public_key })
    expect(board.body.entries.map((e: any) => e.handle)).toEqual([stark.handle])
  })

  it('puts the earlier player first on a tie', async () => {
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1 })
    const erster = await signup(keys)
    const zweiter = await signup(keys)
    await call('POST', '/v1/entries', { key: keys.public_key, token: erster.token, body: { discipline: 'd', value: 100 } })
    await call('POST', '/v1/entries', { key: keys.public_key, token: zweiter.token, body: { discipline: 'd', value: 100 } })
    const board = await call('GET', '/v1/leaderboards/d', { key: keys.public_key })
    expect(board.body.entries[0].handle).toBe(erster.handle)
  })

  it('rolls districts up into the city and leaves other districts empty', async () => {
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1 })
    const eims = await signup(keys)
    const altona = await signup(keys)
    await call('PATCH', '/v1/me/region', { key: keys.public_key, token: eims.token, body: { region_id: 'hh-eimsbuettel' } })
    await call('PATCH', '/v1/me/region', { key: keys.public_key, token: altona.token, body: { region_id: 'hh-altona' } })
    await call('POST', '/v1/entries', { key: keys.public_key, token: eims.token, body: { discipline: 'd', value: 10 } })
    await call('POST', '/v1/entries', { key: keys.public_key, token: altona.token, body: { discipline: 'd', value: 20 } })

    const city = await call('GET', '/v1/leaderboards/d?region=hh-city', { key: keys.public_key })
    expect(city.body.entries).toHaveLength(2)
    const world = await call('GET', '/v1/leaderboards/d?region=world', { key: keys.public_key })
    expect(world.body.entries).toHaveLength(2)
    const harburg = await call('GET', '/v1/leaderboards/d?region=hh-harburg', { key: keys.public_key })
    expect(harburg.body.entries).toHaveLength(0)
  })

  it('shows players without a region globally but in no regional board', async () => {
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1 })
    const heimatlos = await signup(keys)
    await call('POST', '/v1/entries', { key: keys.public_key, token: heimatlos.token, body: { discipline: 'd', value: 10 } })
    expect((await call('GET', '/v1/leaderboards/d', { key: keys.public_key })).body.entries).toHaveLength(1)
    expect((await call('GET', '/v1/leaderboards/d?region=world', { key: keys.public_key })).body.entries).toHaveLength(0)
  })

  it('reports title eligibility only from the minimum contenders on', async () => {
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1, max_title_level: 2, title_min_players: 2 })
    const a = await signup(keys)
    await call('PATCH', '/v1/me/region', { key: keys.public_key, token: a.token, body: { region_id: 'hh-altona' } })
    await call('POST', '/v1/entries', { key: keys.public_key, token: a.token, body: { discipline: 'd', value: 1 } })
    expect((await call('GET', '/v1/leaderboards/d?region=hh-altona', { key: keys.public_key })).body.title_eligible).toBe(false)
    const b = await signup(keys)
    await call('PATCH', '/v1/me/region', { key: keys.public_key, token: b.token, body: { region_id: 'hh-altona' } })
    await call('POST', '/v1/entries', { key: keys.public_key, token: b.token, body: { discipline: 'd', value: 2 } })
    expect((await call('GET', '/v1/leaderboards/d?region=hh-altona', { key: keys.public_key })).body.title_eligible).toBe(true)
  })

  it('honours the limit cap', async () => {
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1 })
    for (let i = 0; i < 3; i++) {
      const p = await signup(keys)
      await call('POST', '/v1/entries', { key: keys.public_key, token: p.token, body: { discipline: 'd', value: i } })
    }
    const board = await call('GET', '/v1/leaderboards/d?limit=2', { key: keys.public_key })
    expect(board.body.entries).toHaveLength(2)
    expect(board.body.contenders).toBe(3)
  })

  it('does not know unknown disciplines', async () => {
    const keys = await makeApp()
    expect((await call('GET', '/v1/leaderboards/gibtsnicht', { key: keys.public_key })).status).toBe(404)
  })
})
