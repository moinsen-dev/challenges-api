import { now, record } from './lib'

/**
 * Badge rules. Deliberately declarative and derived from the ledger: a badge
 * is never submitted, it is determined. That way the set a player holds is the
 * same again after rebuilding the database from scratch.
 *
 * Disciplines are referenced as "app-slug/discipline-slug".
 */
export type Rule =
  | { type: 'qualified_in_n_apps'; n: number }
  | { type: 'qualified_in_category'; category: string }
  | { type: 'discipline_mastery'; factor: number }
  | { type: 'titles_in_n_regions'; n: number }
  | { type: 'streak_days'; days: number; discipline?: string }
  | { type: 'active_on_n_days'; n: number; discipline?: string }
  | { type: 'total_at_least'; discipline: string; value: number }
  | { type: 'collection_complete'; collection: string }
  | { type: 'all_of'; rules: Rule[] }
  | { type: 'any_of'; rules: Rule[] }

export async function evaluateBadges(
  db: D1Database,
  playerId: string,
  appId: string | null,
): Promise<{ id: string; name: string }[]> {
  const [candidates, held] = await Promise.all([
    db
      .prepare(`SELECT id, name, rule FROM badges WHERE app_id IS NULL OR app_id = ?`)
      .bind(appId)
      .all<{ id: string; name: string; rule: string }>(),
    db
      .prepare(`SELECT badge_id FROM player_badges WHERE player_id = ?`)
      .bind(playerId)
      .all<{ badge_id: string }>(),
  ])
  const have = new Set(held.results.map((r) => r.badge_id))

  const earned: { id: string; name: string }[] = []
  for (const badge of candidates.results) {
    if (have.has(badge.id)) continue
    if (!(await satisfies(db, playerId, JSON.parse(badge.rule) as Rule))) continue
    await db
      .prepare(`INSERT INTO player_badges (player_id, badge_id, earned_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(playerId, badge.id, now())
      .run()
    await record(db, appId, playerId, 'badge.earned', { badge_id: badge.id, name: badge.name })
    earned.push({ id: badge.id, name: badge.name })
  }
  return earned
}

const scalar = async (db: D1Database, sql: string, ...binds: unknown[]) =>
  (await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0

/** Resolve "app/discipline" into a discipline id. */
async function disciplineId(db: D1Database, ref: string): Promise<string | null> {
  const [appSlug, discSlug] = ref.split('/')
  const row = await db
    .prepare(
      `SELECT d.id FROM disciplines d JOIN apps a ON a.id = d.app_id
        WHERE a.slug = ? AND d.slug = ?`,
    )
    .bind(appSlug, discSlug)
    .first<{ id: string }>()
  return row?.id ?? null
}

async function satisfies(db: D1Database, playerId: string, rule: Rule): Promise<boolean> {
  switch (rule.type) {
    case 'all_of':
      for (const r of rule.rules) if (!(await satisfies(db, playerId, r))) return false
      return true

    case 'any_of':
      for (const r of rule.rules) if (await satisfies(db, playerId, r)) return true
      return false

    case 'qualified_in_n_apps':
      return (
        (await scalar(
          db,
          `SELECT COUNT(DISTINCT d.app_id) AS n FROM qualifications q
             JOIN disciplines d ON d.id = q.discipline_id WHERE q.player_id = ?`,
          playerId,
        )) >= rule.n
      )

    case 'qualified_in_category': {
      const total = await scalar(
        db,
        `SELECT COUNT(*) AS n FROM disciplines WHERE category = ? AND qualifying_score IS NOT NULL`,
        rule.category,
      )
      if (total === 0) return false
      const mine = await scalar(
        db,
        `SELECT COUNT(DISTINCT q.discipline_id) AS n FROM qualifications q
           JOIN disciplines d ON d.id = q.discipline_id
          WHERE q.player_id = ? AND d.category = ? AND d.qualifying_score IS NOT NULL`,
        playerId,
        rule.category,
      )
      return mine >= total
    }

    case 'discipline_mastery':
      // Passed the exam at a multiple of the bar, honouring score direction.
      return (
        (await scalar(
          db,
          `SELECT COUNT(*) AS n FROM qualifications q JOIN disciplines d ON d.id = q.discipline_id
            WHERE q.player_id = ? AND d.qualifying_score IS NOT NULL
              AND ((d.aggregation = 'best' AND d.score_direction = 'asc'
                     AND q.value_at <= d.qualifying_score / ?)
                OR ((d.aggregation != 'best' OR d.score_direction != 'asc')
                     AND q.value_at >= d.qualifying_score * ?))`,
          playerId,
          rule.factor,
          rule.factor,
        )) > 0
      )

    case 'titles_in_n_regions':
      return (
        (await scalar(
          db,
          `SELECT COUNT(DISTINCT region_id) AS n FROM titles WHERE player_id = ?`,
          playerId,
        )) >= rule.n
      )

    case 'active_on_n_days': {
      const discId = rule.discipline ? await disciplineId(db, rule.discipline) : null
      if (rule.discipline && !discId) return false
      return (
        (await scalar(
          db,
          `SELECT COUNT(DISTINCT day) AS n FROM entries
            WHERE player_id = ? AND status = 'counted' AND (? IS NULL OR discipline_id = ?)`,
          playerId,
          discId,
          discId,
        )) >= rule.n
      )
    }

    case 'streak_days': {
      const discId = rule.discipline ? await disciplineId(db, rule.discipline) : null
      if (rule.discipline && !discId) return false
      // Longest daily streak per discipline; one is enough.
      return (
        (await scalar(
          db,
          `WITH days AS (SELECT DISTINCT discipline_id, day FROM entries
                          WHERE player_id = ? AND status = 'counted'
                            AND (? IS NULL OR discipline_id = ?)),
                grouped AS (SELECT discipline_id, day,
                                   date(day, '-' || ROW_NUMBER() OVER (PARTITION BY discipline_id ORDER BY day) || ' days') AS grp
                              FROM days),
                runs AS (SELECT discipline_id, grp, COUNT(*) AS len FROM grouped GROUP BY discipline_id, grp)
           SELECT COALESCE(MAX(len), 0) AS n FROM runs`,
          playerId,
          discId,
          discId,
        )) >= rule.days
      )
    }

    case 'total_at_least': {
      const discId = await disciplineId(db, rule.discipline)
      if (!discId) return false
      const sum =
        (
          await db
            .prepare(
              `SELECT COALESCE(SUM(value), 0) AS n FROM entries
                WHERE player_id = ? AND discipline_id = ? AND status = 'counted'`,
            )
            .bind(playerId, discId)
            .first<{ n: number }>()
        )?.n ?? 0
      return sum >= rule.value
    }

    case 'collection_complete': {
      const [appSlug, collSlug] = rule.collection.split('/')
      const coll = await db
        .prepare(
          `SELECT c.id FROM collections c JOIN apps a ON a.id = c.app_id
            WHERE a.slug = ? AND c.slug = ?`,
        )
        .bind(appSlug, collSlug)
        .first<{ id: string }>()
      if (!coll) return false
      const total = await scalar(
        db,
        `SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?`,
        coll.id,
      )
      if (total === 0) return false
      const mine = await scalar(
        db,
        `SELECT COUNT(*) AS n FROM player_items pi
           JOIN collection_items ci ON ci.id = pi.item_id
          WHERE pi.player_id = ? AND ci.collection_id = ?`,
        playerId,
        coll.id,
      )
      return mine >= total
    }
  }
}
