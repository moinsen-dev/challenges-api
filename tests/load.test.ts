import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { freshSeason, makeApp, makeDiscipline, unique } from './helpers'
import * as projection from '../src/projection'

/**
 * The point of phase 4, as a test rather than a claim.
 *
 * Rows are inserted straight into the projection because the question here is
 * not whether entries work — 295 other tests answer that — but whether a board
 * with a real population still answers from an index instead of by sorting the
 * world.
 */
const POPULATION = 20_000
const CHUNK = 500

async function populate(disciplineId: string, seasonId: string) {
  const values: number[] = []
  for (let i = 0; i < POPULATION; i++) values.push(i)

  for (let start = 0; start < POPULATION; start += CHUNK) {
    const slice = values.slice(start, start + CHUNK)
    const players = slice
      .map((i) => `('plr_load_${i}', 'load-${i}', '2026-01-01T00:00:00Z')`)
      .join(',')
    await env.DB.prepare(`INSERT INTO players (id, handle, created_at) VALUES ${players}`).run()

    // Score descends with the index, so player i sits at rank i + 1. Half of
    // them are in one district, which is the shape a city rollout produces.
    const rows = slice
      .map(
        (i) =>
          `('${disciplineId}', '${seasonId}', 'plr_load_${i}', ${POPULATION - i}, ` +
          `'2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z', 1, ` +
          `${i % 2 === 0 ? "'hh-altona'" : "'hh-nord'"}, 'hh-city', 'hh', 'de', 'eu', 'world', '2026-01-01T00:00:00Z')`,
      )
      .join(',')
    await env.DB.prepare(
      `INSERT INTO standings
         (discipline_id, season_id, player_id, value, since, eligible, r1, r2, r3, r4, r5, r6, updated_at)
       VALUES ${rows}`,
    ).run()
  }
}

describe(`A board with ${POPULATION.toLocaleString('en')} players`, () => {
  it('answers pages and ranks from an index, wherever you stand', async () => {
    const season = await freshSeason()
    const keys = await makeApp()
    const slug = unique('crowded')
    await makeDiscipline(keys, { slug, name: 'Crowded', trust_tier: 1, max_title_level: 2 })
    const d = await env.DB.prepare(`SELECT * FROM disciplines WHERE slug = ?`).bind(slug).first<any>()

    await populate(d.id, season)

    const timed = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
      const started = Date.now()
      const result = await work()
      return [result, Date.now() - started]
    }

    // --- the first page
    const [firstPage, firstMs] = await timed(() =>
      projection.page(env.DB, d, season, {}, { limit: 25 }),
    )
    expect(firstPage.total).toBe(POPULATION)
    expect(firstPage.rows[0].handle).toBe('load-0')
    expect(firstPage.rows).toHaveLength(25)

    // --- the rank of somebody at the very top, and somebody near the bottom
    const [top, topMs] = await timed(() =>
      projection.rank(env.DB, d, season, 'plr_load_3', {}),
    )
    const [deep, deepMs] = await timed(() =>
      projection.rank(env.DB, d, season, `plr_load_${POPULATION - 4}`, {}),
    )
    expect(top!.rank).toBe(4)
    expect(top!.of).toBe(POPULATION)
    expect(deep!.rank).toBe(POPULATION - 3)

    // Position must not decide cost. A linear implementation would make the
    // deep lookup dramatically more expensive than the shallow one.
    expect(deepMs).toBeLessThan(Math.max(topMs, 20) * 12)

    // --- a regional board over half the population
    const [district, districtMs] = await timed(() =>
      projection.page(env.DB, d, season, { regionId: 'hh-altona', level: 1 }, { limit: 25 }),
    )
    expect(district.total).toBe(POPULATION / 2)
    expect(district.rows[0].handle).toBe('load-0')

    // --- the neighbourhood of somebody in the middle
    const [around, aroundMs] = await timed(() =>
      projection.neighbourhood(env.DB, d, season, `plr_load_${POPULATION / 2}`, {}, 2),
    )
    expect(around!.rank).toBe(POPULATION / 2 + 1)
    expect(around!.rows.map((r) => r.rank)).toEqual([
      POPULATION / 2 - 1,
      POPULATION / 2,
      POPULATION / 2 + 1,
      POPULATION / 2 + 2,
      POPULATION / 2 + 3,
    ])
    expect(around!.rows.find((r) => r.you)!.handle).toBe(`load-${POPULATION / 2}`)

    // --- a deep cursor page costs what a shallow one costs
    let cursor = firstPage.cursor
    for (let i = 0; i < 8; i++) {
      const next = await projection.page(env.DB, d, season, {}, { limit: 25, cursor })
      cursor = next.cursor
    }
    const [deepPage, deepPageMs] = await timed(() =>
      projection.page(env.DB, d, season, {}, { limit: 25, cursor }),
    )
    expect(deepPage.rows).toHaveLength(25)
    expect(deepPage.rows[0].handle).toBe(`load-${25 * 9}`)
    expect(deepPageMs).toBeLessThan(Math.max(firstMs, 20) * 12)

    console.log(
      `population ${POPULATION}: first page ${firstMs}ms · deep page ${deepPageMs}ms · ` +
        `rank@4 ${topMs}ms · rank@${POPULATION - 3} ${deepMs}ms · district ${districtMs}ms · around ${aroundMs}ms`,
    )

    // An absolute ceiling as well, generous enough not to be flaky but low
    // enough that a return to scanning would fail here.
    for (const [label, ms] of [
      ['first page', firstMs],
      ['deep page', deepPageMs],
      ['rank', deepMs],
      ['district', districtMs],
      ['around', aroundMs],
    ] as const) {
      expect(ms, `${label} took ${ms}ms`).toBeLessThan(1500)
    }
  }, 120_000)
})
