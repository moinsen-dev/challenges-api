import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { call, makeApp, makeDiscipline, signup, unique } from './helpers'
import { FREE_ENTRIES_PER_MONTH, freezeUsage, usageForMonth } from '../src/usage'

/**
 * Metering, which is the part of the price list that has to be true before a
 * rate can be switched on. Nothing here charges anybody.
 */

/** Put entries straight into the ledger on a chosen day; the API only writes today. */
async function ledger(appSlug: string, disciplineSlug: string, day: string, count: number) {
  const d = await env.DB.prepare(
    `SELECT d.id, d.app_id FROM disciplines d JOIN apps a ON a.id = d.app_id
      WHERE a.slug = ? AND d.slug = ?`,
  )
    .bind(appSlug, disciplineSlug)
    .first<{ id: string; app_id: string }>()
  const season = await env.DB.prepare(`SELECT id FROM seasons WHERE status = 'open'`).first<{ id: string }>()
  const player = await env.DB.prepare(`SELECT id FROM players LIMIT 1`).first<{ id: string }>()
  for (let i = 0; i < count; i++) {
    await env.DB.prepare(
      `INSERT INTO entries (id, discipline_id, season_id, player_id, value, day, occurred_at, trust_tier, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
      .bind(unique('ent'), d!.id, season!.id, player!.id, i, day, day + 'T12:00:00Z', day + 'T12:00:00Z')
      .run()
  }
  return d!.app_id
}

async function appWithDiscipline() {
  const keys = await makeApp()
  await makeDiscipline(keys, { slug: 'score', name: 'Score' })
  await signup(keys, unique('zaehler'))
  return keys
}

const today = new Date().toISOString().slice(0, 10)
const month = today.slice(0, 7)
const daysAgo = (n: number) =>
  new Date(Date.parse(today + 'T00:00:00Z') - n * 86_400_000).toISOString().slice(0, 10)

describe('Counting entries', () => {
  it('counts today from the ledger, without anything being frozen', async () => {
    const keys = await appWithDiscipline()
    const appId = await ledger(keys.slug, 'score', today, 3)
    const usage = await usageForMonth(env.DB, appId, month)
    expect(usage.entries.counted).toBe(3)
    expect(usage.entries.allowance).toBe(FREE_ENTRIES_PER_MONTH)
    expect(usage.entries.over).toBe(0)
  })

  it('freezes a completed day and leaves today alone', async () => {
    const keys = await appWithDiscipline()
    const appId = await ledger(keys.slug, 'score', daysAgo(1), 4)
    await ledger(keys.slug, 'score', today, 2)

    await freezeUsage(env.DB, today)
    const counters = await env.DB.prepare(
      `SELECT day, count FROM usage_counters WHERE app_id = ? AND metric = 'entries'`,
    )
      .bind(appId)
      .all<{ day: string; count: number }>()
    // Yesterday is written down; today is not, because today is not over.
    expect(counters.results.map((r) => r.day)).toEqual([daysAgo(1)])
    expect(counters.results[0]!.count).toBe(4)

    const usage = await usageForMonth(env.DB, appId, month)
    expect(usage.entries.counted).toBe(6)
  })

  /**
   * The reason a day is frozen at all: erasure is a right, and a month that
   * shrinks after it was reported is a month nobody can reconcile.
   */
  it('does not recompute a day that was already frozen', async () => {
    const keys = await appWithDiscipline()
    const appId = await ledger(keys.slug, 'score', daysAgo(2), 5)
    await freezeUsage(env.DB, today)

    await env.DB.prepare(
      `DELETE FROM entries WHERE discipline_id IN (SELECT id FROM disciplines WHERE app_id = ?)`,
    )
      .bind(appId)
      .run()
    await freezeUsage(env.DB, today)

    const usage = await usageForMonth(env.DB, appId, month)
    expect(usage.entries.counted).toBe(5)
  })

  it('is idempotent across runs', async () => {
    const keys = await appWithDiscipline()
    const appId = await ledger(keys.slug, 'score', daysAgo(1), 7)
    await freezeUsage(env.DB, today)
    await freezeUsage(env.DB, today)
    await freezeUsage(env.DB, today)
    expect((await usageForMonth(env.DB, appId, month)).entries.counted).toBe(7)
  })

  it('reports a month that is not this one without counting today into it', async () => {
    const keys = await appWithDiscipline()
    const appId = await ledger(keys.slug, 'score', today, 3)
    const usage = await usageForMonth(env.DB, appId, '2020-01')
    expect(usage.entries.counted).toBe(0)
    expect(usage.days).toEqual([])
  })

  it('says how far over the allowance an app is', async () => {
    const keys = await appWithDiscipline()
    const appId = await ledger(keys.slug, 'score', daysAgo(1), 3)
    await env.DB.prepare(
      `INSERT INTO usage_counters (app_id, day, metric, count, cpu_ms) VALUES (?, ?, 'entries', ?, 0)
       ON CONFLICT (app_id, day, metric) DO UPDATE SET count = excluded.count`,
    )
      .bind(appId, daysAgo(2), FREE_ENTRIES_PER_MONTH)
      .run()
    // A counter without its frozen marker is a state freezeUsage never writes,
    // and would make that day count twice.
    await env.DB.prepare(`INSERT INTO usage_frozen (app_id, day) VALUES (?, ?)`)
      .bind(appId, daysAgo(2))
      .run()
    const usage = await usageForMonth(env.DB, appId, month)
    expect(usage.entries.over).toBe(3)
  })
})

describe('The other metered lines', () => {
  it('rolls verification runs and their CPU into the month', async () => {
    const keys = await appWithDiscipline()
    const appId = (await env.DB.prepare(`SELECT id FROM apps WHERE slug = ?`).bind(keys.slug).first<{ id: string }>())!.id
    // The shape the verifier writes when a run has been re-simulated.
    await env.DB.prepare(
      `INSERT INTO usage_counters (app_id, day, metric, count, cpu_ms) VALUES (?, ?, 'verification', 2, 350)`,
    )
      .bind(appId, daysAgo(1))
      .run()
    await env.DB.prepare(
      `INSERT INTO usage_counters (app_id, day, metric, count, cpu_ms) VALUES (?, ?, 'verification', 1, 120)`,
    )
      .bind(appId, today)
      .run()

    const usage = await usageForMonth(env.DB, appId, month)
    expect(usage.verification.runs).toBe(3)
    expect(usage.verification.cpu_ms).toBe(470)
    // A verification counter is not an entry.
    expect(usage.entries.counted).toBe(0)
  })

  it('counts only titles above city level', async () => {
    const keys = await appWithDiscipline()
    const d = await env.DB.prepare(
      `SELECT d.id, d.app_id FROM disciplines d JOIN apps a ON a.id = d.app_id WHERE a.slug = ?`,
    )
      .bind(keys.slug)
      .first<{ id: string; app_id: string }>()
    const season = await env.DB.prepare(`SELECT id FROM seasons WHERE status = 'open'`).first<{ id: string }>()
    const player = await env.DB.prepare(`SELECT id FROM players LIMIT 1`).first<{ id: string }>()
    for (const [level, region] of [
      [1, 'hh-altona'],
      [2, 'hh-city'],
      [3, 'hh'],
      [4, 'de'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO titles (id, player_id, discipline_id, season_id, region_id, level, value_at, contenders, awarded_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 9, ?)`,
      )
        .bind(unique('ttl'), player!.id, d!.id, season!.id, region, level, today + 'T10:00:00Z')
        .run()
    }
    const usage = await usageForMonth(env.DB, d!.app_id, month)
    // Levels 1 and 2 are free; 3 and 4 are the metered line.
    expect(usage.titles_above_city).toBe(2)
  })
})

describe('Freezing a quiet day', () => {
  it('marks it done without writing a counter for nothing', async () => {
    const keys = await appWithDiscipline()
    const appId = (await env.DB.prepare(`SELECT id FROM apps WHERE slug = ?`).bind(keys.slug).first<{ id: string }>())!.id
    await freezeUsage(env.DB, today, 3)

    const counters = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM usage_counters WHERE app_id = ? AND metric = 'entries'`,
    )
      .bind(appId)
      .first<{ n: number }>()
    const marks = await env.DB.prepare(`SELECT COUNT(*) AS n FROM usage_frozen WHERE app_id = ?`)
      .bind(appId)
      .first<{ n: number }>()
    expect(counters!.n).toBe(0)
    expect(marks!.n).toBe(3)
  })
})

describe('The call the cron actually makes', () => {
  /**
   * freezeUsage() with no arguments: today from the clock, forty days back.
   * That is the only form the scheduled handler ever uses, so it is the form
   * worth proving.
   */
  it('freezes from the clock, forty days back, without being told', async () => {
    const keys = await appWithDiscipline()
    const appId = (await env.DB.prepare(`SELECT id FROM apps WHERE slug = ?`).bind(keys.slug).first<{ id: string }>())!.id
    await ledger(keys.slug, 'score', daysAgo(39), 2)
    await ledger(keys.slug, 'score', today, 5)

    const result = await freezeUsage(env.DB)
    expect(result.apps).toBeGreaterThan(0)
    expect(result.days_frozen).toBeGreaterThanOrEqual(40)

    const frozen = await env.DB.prepare(
      `SELECT day, count FROM usage_counters WHERE app_id = ? AND metric = 'entries'`,
    )
      .bind(appId)
      .all<{ day: string; count: number }>()
    expect(frozen.results).toEqual([{ day: daysAgo(39), count: 2 }])

    // This month sees only today: thirty-nine days back always lands in the
    // previous month, which is the point of reporting per month.
    expect((await usageForMonth(env.DB, appId, month)).entries.counted).toBe(5)
  })
})

describe('The usage endpoint', () => {
  it('answers the owner with this month', async () => {
    const keys = await appWithDiscipline()
    await ledger(keys.slug, 'score', today, 2)
    // A developer session, the way the console holds one.
    const devId = unique('dev')
    const token = unique('tok')
    const hash = await crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(token))
      .then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''))
    await env.DB.prepare(
      `INSERT INTO developers (id, provider, provider_id, login, two_factor, created_at, last_seen)
       VALUES (?, 'github', ?, ?, 1, ?, ?)`,
    )
      .bind(devId, devId, devId, new Date().toISOString(), new Date().toISOString())
      .run()
    await env.DB.prepare(`UPDATE apps SET owner_id = ? WHERE slug = ?`).bind(devId, keys.slug).run()
    await env.DB.prepare(
      `INSERT INTO developer_sessions (token_hash, developer_id, created_at, expires_at, last_seen)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        hash,
        devId,
        new Date().toISOString(),
        new Date(Date.now() + 86_400_000).toISOString(),
        new Date().toISOString(),
      )
      .run()

    const worker = (await import('../src/index')).default
    const answer = await worker.fetch(
      new Request(`https://test.local/v1/dev/apps/${keys.slug}/usage`, {
        headers: { Cookie: `chapi_dev=${token}` },
      }),
      env as any,
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    )
    expect(answer.status).toBe(200)
    const body: any = await answer.json()
    expect(body.app).toBe(keys.slug)
    expect(body.entries.counted).toBe(2)
    expect(body.entries.allowance).toBe(FREE_ENTRIES_PER_MONTH)
  })

  it('needs a developer session at all', async () => {
    const keys = await appWithDiscipline()
    expect((await call('GET', `/v1/dev/apps/${keys.slug}/usage`)).status).toBe(401)
  })
})
