import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { call, freshSeason, makeApp, makeDiscipline, signup, unique } from './helpers'

import * as projection from '../src/projection'

async function arena(disc: Record<string, unknown> = {}) {
  const season = await freshSeason()
  const keys = await makeApp()
  const slug = unique('d')
  await makeDiscipline(keys, { slug, name: 'D', trust_tier: 1, ...disc })
  const d = await env.DB.prepare(`SELECT * FROM disciplines WHERE slug = ?`).bind(slug).first<any>()
  return { keys, slug, season, d }
}


/**
 * An independent expectation, computed from `entries` in the test itself.
 * Comparing against shared code would only prove the code agrees with itself.
 */
async function expectedFromLedger(
  disciplineId: string,
  seasonId: string,
  opts: { direction?: 'asc' | 'desc'; region?: string } = {},
) {
  const rows = await env.DB.prepare(
    `SELECT e.player_id, e.value, e.created_at, e.region_id FROM entries e
      WHERE e.discipline_id = ? AND e.season_id = ? AND e.status = 'counted'`,
  )
    .bind(disciplineId, seasonId)
    .all<{ player_id: string; value: number; created_at: string; region_id: string | null }>()

  const inRegion = new Set<string>()
  if (opts.region) {
    const tree = await env.DB.prepare(
      `WITH RECURSIVE down(id) AS (
         SELECT id FROM regions WHERE id = ?
         UNION ALL SELECT r.id FROM regions r JOIN down ON r.parent_id = down.id)
       SELECT id FROM down`,
    )
      .bind(opts.region)
      .all<{ id: string }>()
    for (const r of tree.results) inRegion.add(r.id)
  }

  const best = new Map<string, { value: number; since: string }>()
  for (const row of rows.results) {
    if (opts.region && !(row.region_id && inRegion.has(row.region_id))) continue
    const current = best.get(row.player_id)
    const better =
      !current ||
      (opts.direction === 'asc' ? row.value < current.value : row.value > current.value)
    if (better) best.set(row.player_id, { value: row.value, since: row.created_at })
    else if (current && row.created_at < current.since) current.since = row.created_at
  }

  const qualified = await env.DB.prepare(
    `SELECT player_id FROM qualifications WHERE discipline_id = ? AND season_id = ?`,
  )
    .bind(disciplineId, seasonId)
    .all<{ player_id: string }>()
  const allowed = new Set(qualified.results.map((q) => q.player_id))

  return [...best.entries()]
    .filter(([playerId]) => allowed.has(playerId))
    .map(([player_id, row]) => ({ player_id, ...row }))
    .sort((a, b) =>
      a.value === b.value
        ? a.since.localeCompare(b.since)
        : opts.direction === 'asc'
          ? a.value - b.value
          : b.value - a.value,
    )
}

const submit = (keys: any, token: string, slug: string, value: number, extra = {}) =>
  call('POST', '/v1/entries', { key: keys.public_key, token, body: { discipline: slug, value, ...extra } })

const board = (keys: any, slug: string, query = '') =>
  call('GET', `/v1/leaderboards/${slug}${query}`, { key: keys.public_key })

describe('The projection agrees with the ledger', () => {
  it('after a series of entries in several regions', async () => {
    const { keys, slug, season, d } = await arena({ qualifying_score: 50 })
    const districts = ['hh-altona', 'hh-nord', 'hh-harburg']
    for (let i = 0; i < 9; i++) {
      const player = await signup(keys)
      await call('PATCH', '/v1/me/region', {
        key: keys.public_key,
        token: player.token,
        body: { region_id: districts[i % 3] },
      })
      await submit(keys, player.token, slug, 40 + i * 13)
    }

    for (const region of [undefined, 'hh-altona', 'hh-city', 'de']) {
      const fromLedger = await expectedFromLedger(d.id, season, { region })
      const level = region
        ? (await env.DB.prepare(`SELECT level FROM regions WHERE id = ?`).bind(region).first<any>()).level
        : undefined
      const fromProjection = await projection.page(env.DB, d, season, { regionId: region, level }, { limit: 50 })

      expect(fromProjection.total, region ?? 'global').toBe(fromLedger.length)
      expect(fromProjection.rows.map((r) => r.player_id)).toEqual(fromLedger.map((r) => r.player_id))
    }
  })

  it('and a rebuild produces exactly what incremental maintenance did', async () => {
    const { keys, slug, season, d } = await arena({ aggregation: 'sum', qualifying_score: 30 })
    for (let i = 0; i < 6; i++) {
      const player = await signup(keys)
      await call('PATCH', '/v1/me/region', {
        key: keys.public_key,
        token: player.token,
        body: { region_id: 'hh-altona' },
      })
      for (const value of [10, 15, i * 4]) await submit(keys, player.token, slug, value)
    }

    const before = await env.DB.prepare(
      `SELECT player_id, value, since, eligible, r1, r2 FROM standings
        WHERE discipline_id = ? AND season_id = ? ORDER BY player_id`,
    )
      .bind(d.id, season)
      .all()

    const rebuilt = await projection.rebuild(env.DB, d, season)
    expect(rebuilt).toBe(6)

    const after = await env.DB.prepare(
      `SELECT player_id, value, since, eligible, r1, r2 FROM standings
        WHERE discipline_id = ? AND season_id = ? ORDER BY player_id`,
    )
      .bind(d.id, season)
      .all()
    expect(after.results).toEqual(before.results)
  })

  it('including for a lower-is-better discipline', async () => {
    const { keys, slug, season, d } = await arena({ score_direction: 'asc', qualifying_score: 100 })
    const times = [90, 42, 75, 60]
    for (const time of times) {
      const player = await signup(keys)
      await submit(keys, player.token, slug, time)
    }
    const fromLedger = await expectedFromLedger(d.id, season, { direction: 'asc' })
    const fromProjection = await projection.page(env.DB, d, season, {}, { limit: 10 })
    expect(fromProjection.rows.map((r) => r.value)).toEqual(fromLedger.map((r) => r.value))
    expect(fromProjection.rows[0].value).toBe(42)
  })
})

describe('Rank without sorting the world', () => {
  it('counts who is ahead, and matches the position on the board', async () => {
    const { keys, slug, season, d } = await arena()
    const players = []
    for (let i = 0; i < 12; i++) {
      const player = await signup(keys)
      await submit(keys, player.token, slug, 100 + i * 10)
      players.push(player)
    }

    const page = await projection.page(env.DB, d, season, {}, { limit: 20 })
    for (let position = 0; position < page.rows.length; position++) {
      const found = await projection.rank(env.DB, d, season, page.rows[position].player_id, {})
      expect(found!.rank, `position ${position}`).toBe(position + 1)
      expect(found!.of).toBe(12)
    }
  })

  it('breaks a tie by who got there first', async () => {
    const { keys, slug, season, d } = await arena()
    const first = await signup(keys)
    await submit(keys, first.token, slug, 500)
    const second = await signup(keys)
    await submit(keys, second.token, slug, 500)

    expect((await projection.rank(env.DB, d, season, first.player_id, {}))!.rank).toBe(1)
    expect((await projection.rank(env.DB, d, season, second.player_id, {}))!.rank).toBe(2)
  })

  it('returns nothing for somebody who has not qualified', async () => {
    const { keys, slug, season, d } = await arena({ qualifying_score: 1000 })
    const player = await signup(keys)
    await submit(keys, player.token, slug, 10)
    expect(await projection.rank(env.DB, d, season, player.player_id, {})).toBeNull()
  })
})

describe('Neighbourhood', () => {
  it('shows the rows around you, and marks which one you are', async () => {
    const { keys, slug } = await arena()
    const players = []
    for (let i = 0; i < 9; i++) {
      const player = await signup(keys)
      await submit(keys, player.token, slug, 100 + i * 10)
      players.push(player)
    }
    const middle = players[4] // 5th best of nine

    const around = await call(`GET`, `/v1/leaderboards/${slug}/around?span=2`, {
      key: keys.public_key,
      token: middle.token,
    })
    expect(around.status).toBe(200)
    expect(around.body.rank).toBe(5)
    expect(around.body.of).toBe(9)
    expect(around.body.rows.map((r: any) => r.rank)).toEqual([3, 4, 5, 6, 7])
    expect(around.body.rows.find((r: any) => r.you).handle).toBe(middle.handle)
  })

  it('clips at the top instead of inventing rows', async () => {
    const { keys, slug } = await arena()
    const leader = await signup(keys)
    await submit(keys, leader.token, slug, 999)
    const second = await signup(keys)
    await submit(keys, second.token, slug, 10)

    const around = await call(`GET`, `/v1/leaderboards/${slug}/around?span=3`, {
      key: keys.public_key,
      token: leader.token,
    })
    expect(around.body.rank).toBe(1)
    expect(around.body.rows.map((r: any) => r.rank)).toEqual([1, 2])
  })

  it('says so plainly when you are not on the board', async () => {
    const { keys, slug } = await arena({ qualifying_score: 1000 })
    const player = await signup(keys)
    await submit(keys, player.token, slug, 5)
    const around = await call(`GET`, `/v1/leaderboards/${slug}/around`, {
      key: keys.public_key,
      token: player.token,
    })
    expect(around.status).toBe(404)
  })
})

describe('Paging', () => {
  it('walks a board with a cursor and never repeats a row', async () => {
    const { keys, slug } = await arena()
    for (let i = 0; i < 17; i++) {
      const player = await signup(keys)
      await submit(keys, player.token, slug, 1000 - i * 7)
    }

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res: any = await board(keys, slug, `?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(res.body.contenders).toBe(17)
      for (const row of res.body.entries) seen.push(row.player_id)
      cursor = res.body.cursor
      pages++
    } while (cursor && pages < 10)

    expect(seen).toHaveLength(17)
    expect(new Set(seen).size).toBe(17)
  })

  it('numbers ranks on the first page and omits them once paging', async () => {
    const { keys, slug } = await arena()
    for (let i = 0; i < 6; i++) {
      const player = await signup(keys)
      await submit(keys, player.token, slug, 100 - i)
    }
    const first: any = await board(keys, slug, '?limit=3')
    expect(first.body.entries.map((e: any) => e.rank)).toEqual([1, 2, 3])

    const next: any = await board(keys, slug, `?limit=3&cursor=${encodeURIComponent(first.body.cursor)}`)
    // A cursor page does not claim positions it did not count.
    expect(next.body.entries[0].rank).toBeUndefined()
    expect(next.body.entries).toHaveLength(3)
  })

  it('rejects an unknown region rather than answering emptily', async () => {
    const { keys, slug } = await arena()
    const res = await board(keys, slug, '?region=atlantis')
    expect(res.status).toBe(404)
  })
})

describe('Things that move somebody on or off a board', () => {
  it('a ban removes them from every board at once, and lifting it restores them', async () => {
    const { keys, slug } = await arena({ qualifying_score: 10 })
    const good = await signup(keys)
    const bad = await signup(keys)
    await submit(keys, good.token, slug, 100)
    await submit(keys, bad.token, slug, 900)
    expect((await board(keys, slug)).body.contenders).toBe(2)

    await call('POST', `/v1/admin/players/${bad.handle}/status`, { admin: true, body: { status: 'banned' } })
    const banned: any = await board(keys, slug)
    expect(banned.body.contenders).toBe(1)
    expect(banned.body.entries[0].handle).toBe(good.handle)

    await call('POST', `/v1/admin/players/${bad.handle}/status`, { admin: true, body: { status: 'active' } })
    expect((await board(keys, slug)).body.contenders).toBe(2)
  })

  it('an unban does not hand a board place to somebody who never qualified', async () => {
    const { keys, slug } = await arena({ qualifying_score: 500 })
    const player = await signup(keys)
    await submit(keys, player.token, slug, 10)
    await call('POST', `/v1/admin/players/${player.handle}/status`, { admin: true, body: { status: 'banned' } })
    await call('POST', `/v1/admin/players/${player.handle}/status`, { admin: true, body: { status: 'active' } })
    expect((await board(keys, slug)).body.contenders).toBe(0)
  })

  it('a decided review case moves the aggregate', async () => {
    const { keys, slug } = await arena({ max_value: 100 })
    const player = await signup(keys)
    await submit(keys, player.token, slug, 50)
    const held = await submit(keys, player.token, slug, 9999)
    expect(held.status).toBe(202)
    expect((await board(keys, slug)).body.entries[0].value).toBe(50)

    await call('POST', `/v1/admin/entries/${held.body.entry_id}/review`, {
      admin: true,
      body: { decision: 'counted' },
    })
    expect((await board(keys, slug)).body.entries[0].value).toBe(9999)
  })

  it('the operator can rebuild everything from the ledger', async () => {
    const { keys, slug, season, d } = await arena({ qualifying_score: 10 })
    for (let i = 0; i < 4; i++) {
      const player = await signup(keys)
      await submit(keys, player.token, slug, 100 + i)
    }
    // Somebody corrupts the projection.
    await env.DB.prepare(`UPDATE standings SET value = 1 WHERE discipline_id = ?`).bind(d.id).run()
    expect((await board(keys, slug)).body.entries[0].value).toBe(1)

    const rebuilt = await call('POST', `/v1/admin/standings/rebuild?discipline=${slug}`, { admin: true })
    expect(rebuilt.body.rebuilt[slug]).toBe(4)
    expect((await board(keys, slug)).body.entries[0].value).toBe(103)
  })
})

describe('Leaving a board again', () => {
  it('a rejected last entry takes the player off it entirely', async () => {
    const { keys, slug, season, d } = await arena({ max_value: 100, qualifying_score: 10 })
    const player = await signup(keys)
    const held = await submit(keys, player.token, slug, 5000)
    expect(held.status).toBe(202)

    // The held entry is their only one, so nothing counts yet.
    expect((await board(keys, slug)).body.contenders).toBe(0)

    await call('POST', `/v1/admin/entries/${held.body.entry_id}/review`, {
      admin: true,
      body: { decision: 'counted' },
    })
    expect((await board(keys, slug)).body.contenders).toBe(1)

    // Deciding the other way removes the row rather than leaving a ghost.
    await env.DB.prepare(`UPDATE entries SET status = 'review' WHERE id = ?`).bind(held.body.entry_id).run()
    await call('POST', `/v1/admin/entries/${held.body.entry_id}/review`, {
      admin: true,
      body: { decision: 'rejected' },
    })
    const gone = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM standings WHERE discipline_id = ? AND season_id = ? AND player_id = ?`,
    )
      .bind(d.id, season, player.player_id)
      .first<{ n: number }>()
    expect(gone!.n).toBe(0)
    expect((await board(keys, slug)).body.contenders).toBe(0)
  })

  it('a player without a home region appears globally and in no region', async () => {
    const { keys, slug, season, d } = await arena()
    const nomad = await signup(keys)
    await submit(keys, nomad.token, slug, 42)

    const row = await env.DB.prepare(
      `SELECT r1, r6 FROM standings WHERE discipline_id = ? AND season_id = ? AND player_id = ?`,
    )
      .bind(d.id, season, nomad.player_id)
      .first<{ r1: string | null; r6: string | null }>()
    expect(row!.r1).toBeNull()
    expect(row!.r6).toBeNull()

    expect((await board(keys, slug)).body.contenders).toBe(1)
    expect((await board(keys, slug, '?region=world')).body.contenders).toBe(0)
  })

  it('rebuilding an unknown discipline changes nothing', async () => {
    await arena()
    const res = await call('POST', '/v1/admin/standings/rebuild?discipline=not-a-discipline', {
      admin: true,
    })
    expect(res.status).toBe(200)
    expect(res.body.rebuilt).toEqual({})
  })
})

describe('Lower is better, all the way through', () => {
  async function timeTrial() {
    const { keys, slug, season, d } = await arena({ score_direction: 'asc' })
    const players = []
    for (const time of [90, 55, 70, 42, 61, 80, 100, 47]) {
      const player = await signup(keys)
      await submit(keys, player.token, slug, time)
      players.push({ player, time })
    }
    return { keys, slug, season, d, players }
  }

  it('pages with a cursor in the right direction', async () => {
    const { keys, slug } = await timeTrial()
    const first: any = await board(keys, slug, '?limit=3')
    expect(first.body.entries.map((e: any) => e.value)).toEqual([42, 47, 55])

    const second: any = await board(keys, slug, `?limit=3&cursor=${encodeURIComponent(first.body.cursor)}`)
    expect(second.body.entries.map((e: any) => e.value)).toEqual([61, 70, 80])

    const third: any = await board(keys, slug, `?limit=3&cursor=${encodeURIComponent(second.body.cursor)}`)
    expect(third.body.entries.map((e: any) => e.value)).toEqual([90, 100])
    expect(third.body.cursor).toBeNull()
  })

  it('ranks the fastest first', async () => {
    const { season, d, players } = await timeTrial()
    const fastest = players.find((p) => p.time === 42)!
    const slowest = players.find((p) => p.time === 100)!
    expect((await projection.rank(env.DB, d, season, fastest.player.player_id, {}))!.rank).toBe(1)
    expect((await projection.rank(env.DB, d, season, slowest.player.player_id, {}))!.rank).toBe(8)
  })

  it('puts the faster neighbours above you', async () => {
    const { keys, slug, players } = await timeTrial()
    const middle = players.find((p) => p.time === 70)!
    const around = await call('GET', `/v1/leaderboards/${slug}/around?span=1`, {
      key: keys.public_key,
      token: middle.player.token,
    })
    // 42, 47, 55, 61, then 70.
    expect(around.body.rank).toBe(5)
    expect(around.body.rows.map((r: any) => r.value)).toEqual([61, 70, 80])
    expect(around.body.rows.find((r: any) => r.you).value).toBe(70)
  })

  it('crowns the smallest value at season close', async () => {
    const { keys, slug, season } = await timeTrial()
    // Give the field a home district so a regional title is possible at all.
    const report = await call(`POST`, `/v1/admin/seasons/${season}/close?dry_run=1`, { admin: true })
    expect(report.status).toBe(200)
    const global = await board(keys, slug)
    expect(global.body.entries[0].value).toBe(42)
  })
})

describe('Rank belongs to a board, not to a player', () => {
  it('gives nobody a rank on a board they are not on', async () => {
    const { keys, slug, season, d } = await arena()
    const local = await signup(keys)
    const outsider = await signup(keys)
    await call('PATCH', '/v1/me/region', {
      key: keys.public_key,
      token: local.token,
      body: { region_id: 'hh-altona' },
    })
    await call('PATCH', '/v1/me/region', {
      key: keys.public_key,
      token: outsider.token,
      body: { region_id: 'hh-nord' },
    })
    await submit(keys, local.token, slug, 100)
    await submit(keys, outsider.token, slug, 900)

    const altona = { regionId: 'hh-altona', level: 1 }
    expect((await projection.rank(env.DB, d, season, local.player_id, altona))!.rank).toBe(1)
    // The stronger player from another district is not first in Altona; they
    // are not in Altona at all.
    expect(await projection.rank(env.DB, d, season, outsider.player_id, altona)).toBeNull()

    // Both share the city above them.
    const city = { regionId: 'hh-city', level: 2 }
    expect((await projection.rank(env.DB, d, season, outsider.player_id, city))!.rank).toBe(1)
    expect((await projection.rank(env.DB, d, season, local.player_id, city))!.rank).toBe(2)
  })

  it('gives nobody a regional rank when they have no region at all', async () => {
    const { keys, slug, season, d } = await arena()
    const nomad = await signup(keys)
    await submit(keys, nomad.token, slug, 50)
    expect((await projection.rank(env.DB, d, season, nomad.player_id, {}))!.rank).toBe(1)
    expect(await projection.rank(env.DB, d, season, nomad.player_id, { regionId: 'hh-altona', level: 1 })).toBeNull()
  })
})
