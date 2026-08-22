import { Discipline } from './lib'

/**
 * One query carries four kinds of aggregation. The difference between a
 * high-score game, a distance app and a habit tracker is exactly this one CTE —
 * everything else in the system stays the same.
 */
function aggregateCte(d: Discipline): string {
  switch (d.aggregation) {
    case 'best':
      return `agg AS (SELECT player_id, ${d.score_direction === 'asc' ? 'MIN' : 'MAX'}(value) AS value,
                             MIN(created_at) AS since FROM scoped GROUP BY player_id)`
    case 'sum':
      return `agg AS (SELECT player_id, SUM(value) AS value,
                             MIN(created_at) AS since FROM scoped GROUP BY player_id)`
    case 'count':
      return `agg AS (SELECT player_id, COUNT(*) AS value,
                             MIN(created_at) AS since FROM scoped GROUP BY player_id)`
    case 'streak':
      // Consecutive days form one group when day minus row number stays constant.
      // The longest such block is the streak.
      return `
        days AS (SELECT player_id, day, MIN(created_at) AS first_created
                   FROM scoped GROUP BY player_id, day),
        grouped AS (SELECT player_id, day, first_created,
                           date(day, '-' || ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY day) || ' days') AS grp
                      FROM days),
        runs AS (SELECT player_id, grp, COUNT(*) AS len, MIN(first_created) AS since
                   FROM grouped GROUP BY player_id, grp),
        agg AS (SELECT player_id, MAX(len) AS value, MIN(since) AS since
                  FROM runs GROUP BY player_id)`
  }
}

type EntryFilter = {
  playerId: string
  /** Only entries after this instant — the basis of every challenge. */
  since?: string
}

/**
 * One player's aggregate, straight from the ledger.
 *
 * This is the only ledger-side aggregation left. Boards, ranks and
 * neighbourhoods are served by the projection in `projection.ts`; what remains
 * here is the single-player question the projection itself is built from, and
 * the time-windowed variant a challenge needs.
 */
export async function valueFor(
  db: D1Database,
  d: Discipline,
  seasonId: string,
  playerId: string,
  since?: string,
): Promise<number | null> {
  const row = await one(db, d, seasonId, { playerId, since })
  return row ? row.value : null
}

export type Standing = { player_id: string; handle: string; value: number; since: string }

/** The same question, with the row rather than just the number. */
export async function one(
  db: D1Database,
  d: Discipline,
  seasonId: string,
  filter: EntryFilter,
): Promise<Standing | null> {
  const binds: (string | number)[] = [d.id, seasonId, filter.playerId]
  let window = ''
  if (filter.since) {
    window = ' AND e.created_at > ?'
    binds.push(filter.since)
  }

  const sql = `
    WITH scoped AS (
      SELECT e.player_id, e.value, e.day, e.created_at
        FROM entries e
       WHERE e.discipline_id = ? AND e.season_id = ? AND e.status = 'counted'
         AND e.player_id = ?${window}),
    ${aggregateCte(d)}
    SELECT p.id AS player_id, p.handle, a.value, a.since
      FROM agg a JOIN players p ON p.id = a.player_id`

  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<Standing>()
  return row ?? null
}

/** Live daily streak ending today or yesterday — what habit apps display. */
export async function currentStreak(
  db: D1Database,
  d: Discipline,
  seasonId: string,
  playerId: string,
  today: string,
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT day FROM entries
        WHERE discipline_id = ? AND season_id = ? AND player_id = ? AND status = 'counted'
        ORDER BY day DESC LIMIT 400`,
    )
    .bind(d.id, seasonId, playerId)
    .all<{ day: string }>()
  const days = rows.results.map((r) => r.day)
  if (days.length === 0) return 0

  const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000)
  const todayNo = dayNumber(today)
  // A streak ending yesterday is still alive; anything older is broken.
  if (todayNo - dayNumber(days[0]) > 1) return 0

  let streak = 1
  for (let i = 1; i < days.length; i++) {
    if (dayNumber(days[i - 1]) - dayNumber(days[i]) !== 1) break
    streak++
  }
  return streak
}
