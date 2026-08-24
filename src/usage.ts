import { now } from './lib'

/**
 * What an app has consumed, and what it is allowed for free.
 *
 * The pricing page promises metering "per 100,000 entries above the free
 * allowance" and "per verified run". This module is where those two sentences
 * become numbers. Nothing here charges anybody — it counts, which is the part
 * that has to be true before a rate can be switched on.
 */

/** The free allowance from the pricing page, in entries per calendar month. */
export const FREE_ENTRIES_PER_MONTH = 100_000

/** Titles at or below this level are free; above it they are a metered line. */
export const FREE_TITLE_LEVEL = 2

const dayOf = (iso: string) => iso.slice(0, 10)

export type Usage = {
  month: string
  entries: { counted: number; allowance: number; over: number }
  verification: { runs: number; cpu_ms: number }
  titles_above_city: number
  days: { day: string; entries: number; verifications: number; cpu_ms: number }[]
}

/**
 * Freeze every complete day that has not been frozen yet.
 *
 * Runs from the cron. Idempotent by construction — a day already in
 * `usage_frozen` is skipped rather than recomputed, so a later account deletion
 * cannot rewrite a month that was already reported.
 */
export async function freezeUsage(db: D1Database, today = dayOf(now()), backfillDays = 40) {
  const apps = await db.prepare(`SELECT id FROM apps`).all<{ id: string }>()
  const wanted: string[] = []
  for (let i = 1; i <= backfillDays; i++)
    wanted.push(dayOf(new Date(Date.parse(today + 'T00:00:00Z') - i * 86_400_000).toISOString()))

  let frozen = 0
  for (const app of apps.results) {
    const done = await db
      .prepare(`SELECT day FROM usage_frozen WHERE app_id = ? AND day >= ?`)
      .bind(app.id, wanted[wanted.length - 1])
      .all<{ day: string }>()
    const already = new Set(done.results.map((r) => r.day))

    for (const day of wanted) {
      if (already.has(day)) continue
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM entries e JOIN disciplines d ON d.id = e.discipline_id
            WHERE d.app_id = ? AND e.day = ?`,
        )
        .bind(app.id, day)
        .first<{ n: number }>()
      // COUNT(*) always yields a row, so there is no empty case to handle.
      const count = row!.n
      if (count > 0) {
        await db
          .prepare(
            `INSERT INTO usage_counters (app_id, day, metric, count, cpu_ms) VALUES (?, ?, 'entries', ?, 0)
             ON CONFLICT (app_id, day, metric) DO UPDATE SET count = excluded.count`,
          )
          .bind(app.id, day, count)
          .run()
      }
      await db
        .prepare(`INSERT INTO usage_frozen (app_id, day) VALUES (?, ?) ON CONFLICT DO NOTHING`)
        .bind(app.id, day)
        .run()
      frozen++
    }
  }
  return { apps: apps.results.length, days_frozen: frozen }
}

/**
 * One month of usage for one app.
 *
 * A day is counted once: from the frozen counters if the cron has written it
 * down, from the ledger otherwise. `usage_frozen` is the authority on which is
 * which, so there is no overlap and no gap. Asking "is it today?" instead would
 * lose yesterday between midnight and the cron run — the reported month would
 * drop overnight and climb back at 03:17.
 */
export async function usageForMonth(db: D1Database, appId: string, month: string): Promise<Usage> {
  const [counters, live, titles] = await Promise.all([
    db
      .prepare(
        `SELECT day, metric, count, cpu_ms FROM usage_counters
          WHERE app_id = ? AND day LIKE ? ORDER BY day`,
      )
      .bind(appId, month + '%')
      .all<{ day: string; metric: string; count: number; cpu_ms: number }>(),
    db
      .prepare(
        `SELECT e.day AS day, COUNT(*) AS n
           FROM entries e JOIN disciplines d ON d.id = e.discipline_id
          WHERE d.app_id = ? AND e.day LIKE ?
            AND NOT EXISTS (SELECT 1 FROM usage_frozen f WHERE f.app_id = d.app_id AND f.day = e.day)
          GROUP BY e.day`,
      )
      .bind(appId, month + '%')
      .all<{ day: string; n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM titles t JOIN disciplines d ON d.id = t.discipline_id
          WHERE d.app_id = ? AND t.level > ? AND t.awarded_at LIKE ?`,
      )
      .bind(appId, FREE_TITLE_LEVEL, month + '%')
      .first<{ n: number }>(),
  ])

  const byDay = new Map<string, { day: string; entries: number; verifications: number; cpu_ms: number }>()
  const at = (day: string) => {
    if (!byDay.has(day)) byDay.set(day, { day, entries: 0, verifications: 0, cpu_ms: 0 })
    return byDay.get(day)!
  }
  for (const row of counters.results) {
    const slot = at(row.day)
    if (row.metric === 'entries') slot.entries += row.count
    if (row.metric === 'verification') {
      slot.verifications += row.count
      slot.cpu_ms += row.cpu_ms
    }
  }
  for (const row of live.results) at(row.day).entries += row.n

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
  const entries = days.reduce((n, d) => n + d.entries, 0)
  return {
    month,
    entries: {
      counted: entries,
      allowance: FREE_ENTRIES_PER_MONTH,
      over: Math.max(0, entries - FREE_ENTRIES_PER_MONTH),
    },
    verification: {
      runs: days.reduce((n, d) => n + d.verifications, 0),
      cpu_ms: days.reduce((n, d) => n + d.cpu_ms, 0),
    },
    titles_above_city: titles!.n,
    days,
  }
}
