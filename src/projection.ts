import { Discipline, higherIsBetter, now } from './lib'
import { one as ledgerRow, valueFor } from './standings'

/**
 * The materialised standings projection.
 *
 * Everything here can be thrown away and rebuilt from `entries`. That is the
 * property that makes a projection safe to have at all: if it is ever wrong,
 * the fix is `rebuild`, not an archaeology session.
 */

export type Row = { player_id: string; handle: string; value: number; since: string }

/** Region column for a level: 1 district … 6 world. */
const column = (level: number) => `r${level}`

/** The chain of regions a player's entries roll up into. */
export async function ancestors(db: D1Database, regionId: string | null) {
  const chain: Record<string, string | null> = { r1: null, r2: null, r3: null, r4: null, r5: null, r6: null }
  if (!regionId) return chain
  const rows = await db
    .prepare(
      `WITH RECURSIVE up(id, parent_id, level) AS (
         SELECT id, parent_id, level FROM regions WHERE id = ?
         UNION ALL
         SELECT r.id, r.parent_id, r.level FROM regions r JOIN up ON r.id = up.parent_id
       )
       SELECT id, level FROM up`,
    )
    .bind(regionId)
    .all<{ id: string; level: number }>()
  for (const row of rows.results) chain[column(row.level)] = row.id
  return chain
}

/** Whether this player currently belongs on a board at all. */
async function eligibility(
  db: D1Database,
  d: Discipline,
  seasonId: string,
  playerId: string,
): Promise<boolean> {
  const player = await db
    .prepare(`SELECT status FROM players WHERE id = ?`)
    .bind(playerId)
    .first<{ status: string }>()
  if (!player || player.status === 'banned') return false
  if (d.qualifying_score === null) return true
  const qualified = await db
    .prepare(
      `SELECT 1 AS q FROM qualifications WHERE player_id = ? AND discipline_id = ? AND season_id = ?`,
    )
    .bind(playerId, d.id, seasonId)
    .first()
  return Boolean(qualified)
}

/**
 * Recompute one player's row from the ledger. Called after every entry, which
 * is the only moment their aggregate can change.
 */
export async function refresh(
  db: D1Database,
  d: Discipline,
  seasonId: string,
  playerId: string,
  regionId: string | null,
) {
  const row = await ledgerRow(db, d, seasonId, { playerId })
  if (!row) {
    await db
      .prepare(`DELETE FROM standings WHERE discipline_id = ? AND season_id = ? AND player_id = ?`)
      .bind(d.id, seasonId, playerId)
      .run()
    return null
  }

  const chain = await ancestors(db, regionId)
  const eligible = (await eligibility(db, d, seasonId, playerId)) ? 1 : 0
  await db
    .prepare(
      `INSERT INTO standings
         (discipline_id, season_id, player_id, value, since, eligible, r1, r2, r3, r4, r5, r6, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (discipline_id, season_id, player_id) DO UPDATE SET
         value = excluded.value, since = excluded.since, eligible = excluded.eligible,
         r1 = excluded.r1, r2 = excluded.r2, r3 = excluded.r3,
         r4 = excluded.r4, r5 = excluded.r5, r6 = excluded.r6,
         updated_at = excluded.updated_at`,
    )
    .bind(
      d.id,
      seasonId,
      playerId,
      row.value,
      row.since,
      eligible,
      chain.r1,
      chain.r2,
      chain.r3,
      chain.r4,
      chain.r5,
      chain.r6,
      now(),
    )
    .run()
  return row.value
}

/** A ban or an unban changes every board a person is on, at once. */
export async function setEligibility(db: D1Database, playerId: string, banned: boolean) {
  if (banned) {
    await db.prepare(`UPDATE standings SET eligible = 0 WHERE player_id = ?`).bind(playerId).run()
    return
  }
  // Coming back is not simply the reverse: the exam still has to be passed.
  await db
    .prepare(
      `UPDATE standings SET eligible = CASE
         WHEN (SELECT qualifying_score FROM disciplines WHERE id = standings.discipline_id) IS NULL THEN 1
         WHEN EXISTS (SELECT 1 FROM qualifications q
                       WHERE q.player_id = standings.player_id
                         AND q.discipline_id = standings.discipline_id
                         AND q.season_id = standings.season_id) THEN 1
         ELSE 0 END
       WHERE player_id = ?`,
    )
    .bind(playerId)
    .run()
}

type Scope = { regionId?: string | null; level?: number }

/** The WHERE clause a board and its rank must agree on, or they will disagree. */
function scoped(d: Discipline, seasonId: string, scope: Scope) {
  const where = ['s.discipline_id = ?', 's.season_id = ?', 's.eligible = 1']
  const binds: unknown[] = [d.id, seasonId]
  if (scope.regionId && scope.level) {
    where.push(`s.${column(scope.level)} = ?`)
    binds.push(scope.regionId)
  }
  return { where: where.join(' AND '), binds }
}

const order = (d: Discipline) => (higherIsBetter(d) ? 'DESC' : 'ASC')

export type Page = { rows: Row[]; cursor: string | null; total: number }

/**
 * One page of a board, by keyset rather than by offset: a cursor stays correct
 * while people below it move, and it costs the same on page 400 as on page 1.
 */
export async function page(
  db: D1Database,
  d: Discipline,
  seasonId: string,
  scope: Scope,
  opts: { limit: number; cursor?: string | null },
): Promise<Page> {
  const { where, binds } = scoped(d, seasonId, scope)
  const direction = order(d)
  const comparison = direction === 'DESC' ? '<' : '>'

  let keyset = ''
  const keysetBinds: unknown[] = []
  if (opts.cursor) {
    const [value, since] = decodeCursor(opts.cursor)
    keyset = ` AND (s.value ${comparison} ? OR (s.value = ? AND s.since > ?))`
    keysetBinds.push(value, value, since)
  }

  const rows = await db
    .prepare(
      `SELECT s.player_id, p.handle, s.value, s.since
         FROM standings s JOIN players p ON p.id = s.player_id
        WHERE ${where}${keyset}
        ORDER BY s.value ${direction}, s.since ASC
        LIMIT ?`,
    )
    .bind(...binds, ...keysetBinds, opts.limit + 1)
    .all<Row>()

  const total = await db
    .prepare(`SELECT COUNT(*) AS n FROM standings s WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>()

  const hasMore = rows.results.length > opts.limit
  const visible = hasMore ? rows.results.slice(0, opts.limit) : rows.results
  const last = visible[visible.length - 1]
  return {
    rows: visible,
    cursor: hasMore && last ? encodeCursor(last.value, last.since) : null,
    total: total?.n ?? 0,
  }
}

/**
 * A player's rank, as a counting question rather than a sorting one: how many
 * stand ahead of them. Index-backed, and unaffected by how far down they are.
 */
export async function rank(
  db: D1Database,
  d: Discipline,
  seasonId: string,
  playerId: string,
  scope: Scope,
): Promise<{ rank: number; of: number; value: number } | null> {
  // Read the region columns too: a player who is not part of this board has
  // no rank on it. Without this check somebody from another district counts
  // as "nobody ahead of them" and comes back as first — which is how a
  // regional seeding once handed the top seed to an outsider.
  const mine = await db
    .prepare(
      `SELECT value, since, eligible, r1, r2, r3, r4, r5, r6 FROM standings
        WHERE discipline_id = ? AND season_id = ? AND player_id = ?`,
    )
    .bind(d.id, seasonId, playerId)
    .first<
      { value: number; since: string; eligible: number } & Record<string, string | null>
    >()
  if (!mine || !mine.eligible) return null
  if (scope.regionId && scope.level && mine[column(scope.level)] !== scope.regionId) return null

  const { where, binds } = scoped(d, seasonId, scope)
  const ahead = higherIsBetter(d) ? '>' : '<'
  const counted = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM standings s
           WHERE ${where} AND (s.value ${ahead} ? OR (s.value = ? AND s.since < ?))) AS ahead,
         (SELECT COUNT(*) FROM standings s WHERE ${where}) AS total`,
    )
    .bind(...binds, mine.value, mine.value, mine.since, ...binds)
    .first<{ ahead: number; total: number }>()

  return { rank: (counted?.ahead ?? 0) + 1, of: counted?.total ?? 0, value: mine.value }
}

/**
 * The rows immediately around a player. This is what a game actually shows —
 * "you are 4th, and here is 2nd through 6th" — and it must not require the
 * whole board to answer.
 */
export async function neighbourhood(
  db: D1Database,
  d: Discipline,
  seasonId: string,
  playerId: string,
  scope: Scope,
  span = 2,
): Promise<{ rank: number; of: number; rows: (Row & { rank: number; you: boolean })[] } | null> {
  const mine = await rank(db, d, seasonId, playerId, scope)
  if (!mine) return null

  const { where, binds } = scoped(d, seasonId, scope)
  const direction = order(d)
  const ahead = higherIsBetter(d) ? '>' : '<'
  const behind = higherIsBetter(d) ? '<' : '>'
  const at = await db
    .prepare(
      `SELECT value, since FROM standings WHERE discipline_id = ? AND season_id = ? AND player_id = ?`,
    )
    .bind(d.id, seasonId, playerId)
    .first<{ value: number; since: string }>()

  const above = await db
    .prepare(
      `SELECT s.player_id, p.handle, s.value, s.since FROM standings s JOIN players p ON p.id = s.player_id
        WHERE ${where} AND (s.value ${ahead} ? OR (s.value = ? AND s.since < ?))
        ORDER BY s.value ${direction === 'DESC' ? 'ASC' : 'DESC'}, s.since DESC LIMIT ?`,
    )
    .bind(...binds, at!.value, at!.value, at!.since, span)
    .all<Row>()

  const below = await db
    .prepare(
      `SELECT s.player_id, p.handle, s.value, s.since FROM standings s JOIN players p ON p.id = s.player_id
        WHERE ${where} AND (s.value ${behind} ? OR (s.value = ? AND s.since > ?))
        ORDER BY s.value ${direction}, s.since ASC LIMIT ?`,
    )
    .bind(...binds, at!.value, at!.value, at!.since, span)
    .all<Row>()

  const me = await db
    .prepare(`SELECT p.handle FROM players p WHERE p.id = ?`)
    .bind(playerId)
    .first<{ handle: string }>()

  const ordered = [
    ...above.results.reverse().map((row, i) => ({ ...row, rank: mine.rank - above.results.length + i, you: false })),
    { player_id: playerId, handle: me!.handle, value: at!.value, since: at!.since, rank: mine.rank, you: true },
    ...below.results.map((row, i) => ({ ...row, rank: mine.rank + 1 + i, you: false })),
  ]
  return { rank: mine.rank, of: mine.of, rows: ordered }
}

/** Rebuild a whole competition key from the ledger. The escape hatch. */
export async function rebuild(db: D1Database, d: Discipline, seasonId: string) {
  await db
    .prepare(`DELETE FROM standings WHERE discipline_id = ? AND season_id = ?`)
    .bind(d.id, seasonId)
    .run()

  const players = await db
    .prepare(
      `SELECT DISTINCT e.player_id,
              (SELECT region_id FROM player_regions pr
                WHERE pr.player_id = e.player_id AND pr.season_id = ?) AS region_id
         FROM entries e
        WHERE e.discipline_id = ? AND e.season_id = ? AND e.status = 'counted'`,
    )
    .bind(seasonId, d.id, seasonId)
    .all<{ player_id: string; region_id: string | null }>()

  for (const row of players.results) await refresh(db, d, seasonId, row.player_id, row.region_id)
  return players.results.length
}

const encodeCursor = (value: number, since: string) => btoa(`${value}|${since}`).replace(/=+$/, '')

function decodeCursor(cursor: string): [number, string] {
  const [value, since] = atob(cursor).split('|')
  return [Number(value), since ?? '']
}

export { valueFor }
