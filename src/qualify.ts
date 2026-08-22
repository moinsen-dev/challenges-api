import { Discipline, beats, now, reaches, record } from './lib'
import { one as ledgerRow } from './standings'

/**
 * Decide whether a player has passed a discipline's exam, and record it.
 *
 * This lives on its own because an aggregate can change in two places: when an
 * entry arrives, and when a held entry is later decided. Having the rule in
 * only one of them was a bug — a player whose single run was held for review
 * and then accepted stayed unqualified forever, and so could never appear on
 * any board.
 */
export async function syncQualification(
  db: D1Database,
  d: Discipline,
  seasonId: string,
  playerId: string,
  appId: string | null,
): Promise<{ aggregate: number | null; qualified: boolean; qualifiedNow: boolean }> {
  const row = await ledgerRow(db, d, seasonId, { playerId })
  const aggregate = row?.value ?? null
  if (aggregate === null) return { aggregate, qualified: d.qualifying_score === null, qualifiedNow: false }

  const existing = await db
    .prepare(
      `SELECT value_at FROM qualifications WHERE player_id = ? AND discipline_id = ? AND season_id = ?`,
    )
    .bind(playerId, d.id, seasonId)
    .first<{ value_at: number }>()

  let qualifiedNow = false
  if (!existing && d.qualifying_score !== null && reaches(d, aggregate, d.qualifying_score)) {
    await db
      .prepare(
        `INSERT INTO qualifications (player_id, discipline_id, season_id, value_at, achieved_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .bind(playerId, d.id, seasonId, aggregate, now())
      .run()
    await record(db, appId, playerId, 'qualification.achieved', { discipline: d.slug, value: aggregate })
    qualifiedNow = true
  } else if (existing && beats(d, aggregate, existing.value_at)) {
    await db
      .prepare(
        `UPDATE qualifications SET value_at = ? WHERE player_id = ? AND discipline_id = ? AND season_id = ?`,
      )
      .bind(aggregate, playerId, d.id, seasonId)
      .run()
  }

  return {
    aggregate,
    qualified: Boolean(existing) || qualifiedNow || d.qualifying_score === null,
    qualifiedNow,
  }
}
