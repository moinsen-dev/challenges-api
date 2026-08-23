import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, makeApp, signup, unique } from './helpers'

/**
 * The boundaries themselves are not in this repository — they are imported by
 * scripts/geo-import.mjs from Eurostat and OpenStreetMap. These tests build
 * their own small world instead, because what has to hold is the arithmetic
 * and the rules around it, not whether Bavaria has the right outline.
 *
 * The world: one open district inside an open city, and one closed district
 * next to it that has an exclave far away — the shape that broke the first
 * version of the resolver.
 */
const box = (west: number, south: number, east: number, north: number) => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
]

async function place(
  id: string,
  parent: string | null,
  level: number,
  rings: number[][][],
  { active = 1, threshold = 0 } = {},
) {
  await env.DB.prepare(
    `INSERT INTO regions (id, parent_id, level, name, active, unlock_threshold, source)
     VALUES (?, ?, ?, ?, ?, ?, 'test')
     ON CONFLICT(id) DO UPDATE SET active = excluded.active`,
  )
    .bind(id, parent, level, id, active ? 1 : 0, threshold)
    .run()
  await env.DB.prepare(`DELETE FROM region_shapes WHERE region_id = ?`).bind(id).run()
  for (const [part, ring] of rings.entries()) {
    const lats = ring.map(([, lat]) => lat)
    const lons = ring.map(([lon]) => lon)
    const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)]
    const [minLon, maxLon] = [Math.min(...lons), Math.max(...lons)]
    await env.DB.prepare(
      `INSERT INTO region_shapes (region_id, part, min_lat, min_lon, max_lat, max_lon, area, ring)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, part, minLat, minLon, maxLat, maxLon, (maxLat - minLat) * (maxLon - minLon), JSON.stringify(ring))
      .run()
  }
}

const IN_OPEN = { lat: 1, lon: 1 }
const IN_CLOSED = { lat: 1, lon: 3 }
const NOWHERE = { lat: 40, lon: 40 }

beforeAll(async () => {
  // A city covering both districts, and a country covering everything.
  await place('t-land', null, 4, [box(-1, -1, 11, 11)])
  await place('t-city', 't-land', 2, [box(0, 0, 4, 2)])
  await place('t-open', 't-city', 1, [box(0, 0, 2, 2)])
  // The closed district also owns a speck at the far corner of the country,
  // so its bounding box is wider than the city it sits in.
  await place('t-closed', 't-city', 1, [box(2, 0, 4, 2), box(9.9, 9.9, 10, 10)], {
    active: 0,
    threshold: 3,
  })
})

const resolve = (key: string, at: { lat: number; lon: number }) =>
  call('GET', `/v1/regions/resolve?lat=${at.lat}&lon=${at.lon}`, { key })

describe('Resolving a position', () => {
  it('answers with the finest region that contains it', async () => {
    const keys = await makeApp()
    const res = await resolve(keys.public_key, IN_OPEN)
    expect(res.status).toBe(200)
    expect(res.body.region.id).toBe('t-open')
    expect(res.body.open).toBe(true)
  })

  it('is not fooled by a district whose exclave widens its bounding box', async () => {
    // t-closed spans a box larger than t-city; ordering regions rather than
    // rings would answer with the city here.
    const keys = await makeApp()
    expect((await resolve(keys.public_key, IN_CLOSED)).body.region.id).toBe('t-closed')
  })

  it('names the chain up to the world', async () => {
    const keys = await makeApp()
    const chain = (await resolve(keys.public_key, IN_OPEN)).body.chain.map((r: any) => r.id)
    expect(chain).toEqual(['t-open', 't-city', 't-land'])
  })

  it('says what is missing when the district is closed, and where to compete meanwhile', async () => {
    const keys = await makeApp()
    const body = (await resolve(keys.public_key, IN_CLOSED)).body
    expect(body.open).toBe(false)
    expect(body.threshold).toBe(3)
    expect(body.missing).toBe(3)
    expect(body.competes_in).toBe('t-city')
  })

  it('refuses a position that is not one', async () => {
    const keys = await makeApp()
    expect((await call('GET', '/v1/regions/resolve', { key: keys.public_key })).status).toBe(400)
    expect((await resolve(keys.public_key, { lat: 91, lon: 0 })).status).toBe(400)
    expect((await resolve(keys.public_key, { lat: 0, lon: 181 })).status).toBe(400)
  })

  /**
   * The bounding box is a filter, not an answer. A district shaped like a C has
   * a box covering its own notch, and someone standing in that notch lives in
   * the region around it. Without the ray cast they would be filed in a district
   * they are demonstrably not in.
   */
  it('walks past a candidate whose box contains the point but whose boundary does not', async () => {
    await place('t-notched', 't-land', 1, [
      [
        [5, 0],
        [8, 0],
        [8, 1],
        [6, 1],
        [6, 2],
        [8, 2],
        [8, 3],
        [5, 3],
        [5, 0],
      ],
    ])
    const keys = await makeApp()
    // Inside the arms of the C.
    expect((await resolve(keys.public_key, { lat: 1.5, lon: 5.5 })).body.region.id).toBe('t-notched')
    // In the notch: inside the box of t-notched, outside its boundary.
    expect((await resolve(keys.public_key, { lat: 1.5, lon: 7 })).body.region.id).toBe('t-land')
  })

  it('answers 404 where the ladder does not reach', async () => {
    const keys = await makeApp()
    expect((await resolve(keys.public_key, NOWHERE)).status).toBe(404)
  })

  it('needs an app key', async () => {
    expect((await call('GET', '/v1/regions/resolve?lat=1&lon=1')).status).toBe(401)
  })
})

describe('A closed district opening itself', () => {
  it('turns the waitlist into an open region at its threshold', async () => {
    const keys = await makeApp()
    await env.DB.prepare(`UPDATE regions SET active = 0 WHERE id = 't-closed'`).run()
    await env.DB.prepare(`DELETE FROM region_waitlist WHERE region_id = 't-closed'`).run()

    const joins = []
    for (let i = 0; i < 3; i++) {
      const player = await signup(keys, unique('wartend'))
      joins.push(
        (await call('POST', '/v1/waitlist/t-closed', { key: keys.public_key, token: player.token })).body,
      )
    }
    expect(joins.map((j) => j.opened)).toEqual([false, false, true])
    expect(joins.at(-1).waiting).toBe(3)

    const after = await resolve(keys.public_key, IN_CLOSED)
    expect(after.body.open).toBe(true)

    // Everyone who waited is told, once.
    const events = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE type = 'region.opened'`,
    ).first<{ n: number }>()
    expect(events!.n).toBeGreaterThanOrEqual(3)
  })
})

describe('Choosing a home region', () => {
  it('refuses a region that has a finer open one inside it', async () => {
    const keys = await makeApp()
    await env.DB.prepare(`UPDATE regions SET active = 1 WHERE id = 't-open'`).run()
    const player = await signup(keys, unique('heimat'))
    const res = await call('PATCH', '/v1/me/region', {
      key: keys.public_key,
      token: player.token,
      body: { region_id: 't-city' },
    })
    expect(res.status).toBe(400)
    expect(res.body.finer).toBe('t-open')
  })

  it('accepts the finest open region', async () => {
    const keys = await makeApp()
    const player = await signup(keys, unique('heimat'))
    const res = await call('PATCH', '/v1/me/region', {
      key: keys.public_key,
      token: player.token,
      body: { region_id: 't-open' },
    })
    expect(res.status).toBe(200)
    expect(res.body.region.id).toBe('t-open')
  })
})

describe('The list of closed regions', () => {
  it('caps what it returns and says how many there are', async () => {
    const keys = await makeApp()
    for (let i = 0; i < 4; i++) await place(`t-shut-${i}`, 't-land', 1, [box(30 + i, 30, 30.5 + i, 30.5)], { active: 0, threshold: 5 })
    const all = await call('GET', '/v1/waitlist', { key: keys.public_key })
    expect(all.body.closed).toBeGreaterThanOrEqual(4)
    const capped = await call('GET', '/v1/waitlist?limit=2', { key: keys.public_key })
    expect(capped.body.regions).toHaveLength(2)
    expect(capped.body.closed).toBe(all.body.closed)
  })
})
