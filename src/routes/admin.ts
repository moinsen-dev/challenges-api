import { Hono } from 'hono'
import {
  Discipline,
  HonoApp,
  audit,
  currentSeason,
  latestSeason,
  id,
  now,
  requireAdmin,
  requireAppSecret,
  sha256,
} from '../lib'
import { issueKeyPair } from './developers'
import { awardTitles } from '../titles'
import { RETENTION_POLICY, sweepRetention } from '../retention'
import * as projection from '../projection'
import { syncQualification } from '../qualify'

export const admin = new Hono<HonoApp>()

// -------------------------------------------------------- Platform operator

admin.post('/v1/admin/apps', requireAdmin, async (c) => {
  const { slug, name, access_mode, invites_per_player } = await c.req.json<{
    slug: string
    name: string
    access_mode?: 'open' | 'invite'
    invites_per_player?: number
  }>()
  const appId = id('app')
  await c.env.DB.prepare(
    `INSERT INTO apps (id, slug, name, access_mode, invites_per_player, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(appId, slug, name, access_mode ?? 'open', invites_per_player ?? 0, now())
    .run()
  const keys = await issueKeyPair(c.env.DB, appId, null)
  await audit(c.env.DB, { kind: 'operator' }, 'app.created', appId, { slug })
  // Both keys are shown exactly once; only hashes are stored.
  return c.json({ id: appId, slug, name, ...keys }, 201)
})

admin.post('/v1/admin/regions', requireAdmin, async (c) => {
  const body = await c.req.json<{
    id: string
    parent_id: string
    level: number
    name: string
    active?: boolean
    unlock_threshold?: number
  }>()
  // A region may start closed and open itself through its waitlist.
  await c.env.DB.prepare(
    `INSERT INTO regions (id, parent_id, level, name, active, unlock_threshold) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(body.id, body.parent_id, body.level, body.name, body.active === false ? 0 : 1, body.unlock_threshold ?? 0)
    .run()
  return c.json(body, 201)
})

admin.patch('/v1/admin/apps/:slug', requireAdmin, async (c) => {
  const body = await c.req.json<{ access_mode?: 'open' | 'invite'; invites_per_player?: number }>()
  const set: string[] = []
  const binds: unknown[] = []
  if (body.access_mode) {
    if (!['open', 'invite'].includes(body.access_mode))
      return c.json({ error: 'access_mode must be "open" or "invite"' }, 400)
    set.push('access_mode = ?')
    binds.push(body.access_mode)
  }
  if (typeof body.invites_per_player === 'number') {
    set.push('invites_per_player = ?')
    binds.push(body.invites_per_player)
  }
  if (!set.length) return c.json({ error: 'nothing to change' }, 400)
  const res = await c.env.DB.prepare(`UPDATE apps SET ${set.join(', ')} WHERE slug = ?`)
    .bind(...binds, c.req.param('slug'))
    .run()
  if (!res.meta.changes) return c.json({ error: 'unknown app' }, 404)
  return c.json({ slug: c.req.param('slug'), ...body })
})

admin.post('/v1/admin/seasons', requireAdmin, async (c) => {
  const body = await c.req.json<{ id: string; name: string; starts_at: string; ends_at: string }>()
  await c.env.DB.prepare(
    `INSERT INTO seasons (id, name, starts_at, ends_at, status) VALUES (?, ?, ?, ?, 'open')`,
  )
    .bind(body.id, body.name, body.starts_at, body.ends_at)
    .run()
  return c.json({ ...body, status: 'open' }, 201)
})

admin.post('/v1/admin/seasons/:id/close', requireAdmin, async (c) => {
  const seasonId = c.req.param('id')
  const dryRun = c.req.query('dry_run') === '1'
  const season = await c.env.DB.prepare(`SELECT * FROM seasons WHERE id = ?`).bind(seasonId).first()
  if (!season) return c.json({ error: 'unknown season' }, 404)

  const report = await awardTitles(c.env.DB, seasonId, { dryRun })
  let next = null
  if (!dryRun) {
    await c.env.DB.prepare(`UPDATE seasons SET status = 'closed' WHERE id = ?`).bind(seasonId).run()
    // A ladder without a next season is dead. Whoever closes one opens the next.
    const body = await c.req.json<{ next?: { id: string; name: string; starts_at: string; ends_at: string } }>().catch(() => ({}))
    if (body.next) {
      await c.env.DB.prepare(
        `INSERT INTO seasons (id, name, starts_at, ends_at, status) VALUES (?, ?, ?, ?, 'open')`,
      )
        .bind(body.next.id, body.next.name, body.next.starts_at, body.next.ends_at)
        .run()
      next = body.next
    }
  }

  return c.json({ season: seasonId, dry_run: dryRun, next, ...report })
})

admin.post('/v1/admin/badges', requireAdmin, async (c) => {
  const body = await c.req.json<{ id: string; name: string; description: string; rule: unknown }>()
  await c.env.DB.prepare(
    `INSERT INTO badges (id, app_id, name, description, rule, created_at) VALUES (?, NULL, ?, ?, ?, ?)`,
  )
    .bind(body.id, body.name, body.description, JSON.stringify(body.rule), now())
    .run()
  return c.json(body, 201)
})

// ------------------------------------------- App developer (secret key only)

admin.post('/v1/disciplines', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const body = await c.req.json<{
    slug: string
    name: string
    category?: string
    unit?: string
    aggregation?: 'best' | 'sum' | 'count' | 'streak'
    score_direction?: 'asc' | 'desc'
    trust_tier?: number
    qualifying_score?: number | null
    max_title_level?: number
    title_min_players?: number
    head_to_head?: boolean
    max_value?: number | null
  }>()

  const tier = body.trust_tier ?? 0
  const maxLevel = body.max_title_level ?? 0
  // A title must never reach higher than the discipline's trust tier.
  if (tier === 0 && maxLevel > 0)
    return c.json({ error: 'trust_tier 0 awards no titles: max_title_level must be 0' }, 400)
  if (tier === 1 && maxLevel > 2)
    return c.json({ error: 'trust_tier 1 reaches city level at most (max_title_level 2)' }, 400)

  const aggregation = body.aggregation ?? 'best'
  if (!['best', 'sum', 'count', 'streak'].includes(aggregation))
    return c.json({ error: 'unknown aggregation' }, 400)

  const discId = id('disc')
  await c.env.DB.prepare(
    `INSERT INTO disciplines
       (id, app_id, slug, name, category, unit, aggregation, score_direction, trust_tier,
        qualifying_score, max_title_level, title_min_players, head_to_head, max_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      discId,
      app.id,
      body.slug,
      body.name,
      body.category ?? 'general',
      body.unit ?? null,
      aggregation,
      body.score_direction ?? 'desc',
      tier,
      body.qualifying_score ?? null,
      maxLevel,
      body.title_min_players ?? 5,
      body.head_to_head ? 1 : 0,
      body.max_value ?? null,
      now(),
    )
    .run()
  return c.json({ id: discId, app: app.slug, ...body, aggregation }, 201)
})

admin.post('/v1/badges', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const body = await c.req.json<{ id: string; name: string; description: string; rule: unknown }>()
  await c.env.DB.prepare(
    `INSERT INTO badges (id, app_id, name, description, rule, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(body.id, app.id, body.name, body.description, JSON.stringify(body.rule), now())
    .run()
  return c.json(body, 201)
})

admin.get('/v1/admin/seasons', requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.starts_at, s.ends_at, s.status,
            (SELECT COUNT(*) FROM entries e WHERE e.season_id = s.id) AS entries,
            (SELECT COUNT(*) FROM titles t WHERE t.season_id = s.id) AS titles
       FROM seasons s ORDER BY s.starts_at DESC`,
  ).all()
  return c.json({ seasons: rows.results })
})

admin.get('/v1/admin/season', requireAdmin, async (c) =>
  c.json({ season: await currentSeason(c.env.DB) }),
)

// ------------------------------------------------------- Operational views

admin.get('/v1/admin/apps', requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.slug, a.name, a.created_at, a.access_mode, a.invites_per_player,
            (SELECT COUNT(*) FROM disciplines d WHERE d.app_id = a.id) AS disciplines,
            (SELECT COUNT(*) FROM player_apps pa WHERE pa.app_id = a.id) AS players,
            (SELECT COUNT(*) FROM entries e JOIN disciplines d ON d.id = e.discipline_id
              WHERE d.app_id = a.id) AS entries
       FROM apps a ORDER BY a.created_at DESC`,
  ).all()
  return c.json({ apps: rows.results })
})

admin.get('/v1/admin/apps/:slug', requireAdmin, async (c) => {
  const app = await c.env.DB.prepare(`SELECT id, slug, name, created_at FROM apps WHERE slug = ?`)
    .bind(c.req.param('slug'))
    .first<{ id: string; slug: string; name: string }>()
  if (!app) return c.json({ error: 'unknown app' }, 404)
  const season = await currentSeason(c.env.DB)

  const [disciplines, activity, flagged] = await Promise.all([
    c.env.DB.prepare(
      `SELECT d.slug, d.name, d.aggregation, d.unit, d.trust_tier, d.qualifying_score,
              d.max_title_level, d.title_min_players,
              (SELECT COUNT(*) FROM entries e WHERE e.discipline_id = d.id) AS entries,
              (SELECT COUNT(*) FROM qualifications q WHERE q.discipline_id = d.id) AS qualified,
              (SELECT COUNT(DISTINCT e.player_id) FROM entries e WHERE e.discipline_id = d.id) AS players
         FROM disciplines d WHERE d.app_id = ? ORDER BY d.slug`,
    )
      .bind(app.id)
      .all(),
    c.env.DB.prepare(
      `SELECT e.day, COUNT(*) AS entries, COUNT(DISTINCT e.player_id) AS players
         FROM entries e JOIN disciplines d ON d.id = e.discipline_id
        WHERE d.app_id = ? GROUP BY e.day ORDER BY e.day DESC LIMIT 30`,
    )
      .bind(app.id)
      .all(),
    c.env.DB.prepare(
      `SELECT e.id, p.handle, d.slug AS discipline, e.value, e.created_at
         FROM entries e JOIN disciplines d ON d.id = e.discipline_id
         JOIN players p ON p.id = e.player_id
        WHERE d.app_id = ? AND e.status = 'review' ORDER BY e.created_at DESC LIMIT 50`,
    )
      .bind(app.id)
      .all(),
  ])

  return c.json({
    app: { slug: app.slug, name: app.name },
    season,
    disciplines: disciplines.results,
    activity: activity.results,
    flagged: flagged.results,
  })
})

/** Distribution across regions — the number that decides about titles. */
admin.get('/v1/admin/regions/density', requireAdmin, async (c) => {
  const asked = c.req.query('season')
  const season = asked
    ? await c.env.DB.prepare(`SELECT * FROM seasons WHERE id = ?`).bind(asked).first()
    : ((await currentSeason(c.env.DB)) ?? (await latestSeason(c.env.DB)))
  if (!season) return c.json({ error: 'unknown season' }, 404)
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.name, r.level, COUNT(pr.player_id) AS players
       FROM regions r LEFT JOIN player_regions pr ON pr.region_id = r.id AND pr.season_id = ?
      WHERE r.active = 1 GROUP BY r.id ORDER BY r.level, r.name`,
  )
    .bind((season as { id: string }).id)
    .all()
  return c.json({ season, regions: rows.results })
})

admin.get('/v1/admin/events', requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT e.id, e.type, e.payload, e.created_at, a.slug AS app, p.handle
       FROM events e LEFT JOIN apps a ON a.id = e.app_id
       LEFT JOIN players p ON p.id = e.player_id
      ORDER BY e.id DESC LIMIT 100`,
  ).all<{ payload: string }>()
  return c.json({
    events: rows.results.map((e) => ({ ...e, payload: JSON.parse(e.payload) })),
  })
})

admin.post('/v1/admin/entries/:id/review', requireAdmin, async (c) => {
  const { decision } = await c.req.json<{ decision: 'counted' | 'rejected' }>()
  if (!['counted', 'rejected'].includes(decision))
    return c.json({ error: 'decision must be "counted" or "rejected"' }, 400)

  const entry = await c.env.DB.prepare(
    `SELECT id, player_id, discipline_id, season_id, region_id FROM entries
      WHERE id = ? AND status = 'review'`,
  )
    .bind(c.req.param('id'))
    .first<{
      player_id: string
      discipline_id: string
      season_id: string
      region_id: string | null
    }>()
  if (!entry) return c.json({ error: 'no entry under review' }, 404)

  await c.env.DB.prepare(`UPDATE entries SET status = ? WHERE id = ?`)
    .bind(decision, c.req.param('id'))
    .run()

  // Deciding a held entry changes the player's aggregate, so the projection
  // has to follow — this is the second place an aggregate can move.
  const d = await c.env.DB.prepare(`SELECT * FROM disciplines WHERE id = ?`)
    .bind(entry.discipline_id)
    .first<Discipline>()
  if (d) {
    // Accepting a held entry can be the moment somebody passes the exam.
    await syncQualification(c.env.DB, d, entry.season_id, entry.player_id, d.app_id)
    await projection.refresh(c.env.DB, d, entry.season_id, entry.player_id, entry.region_id)
  }

  return c.json({ entry_id: c.req.param('id'), status: decision })
})

/**
 * Rebuild the standings projection from the ledger. The point of a projection
 * is that this exists: if it is ever wrong, the fix is one call, not an
 * archaeology session.
 */
admin.post('/v1/admin/standings/rebuild', requireAdmin, async (c) => {
  const season = (await currentSeason(c.env.DB)) ?? (await latestSeason(c.env.DB))
  if (!season) return c.json({ error: 'no season' }, 409)
  const only = c.req.query('discipline')

  const disciplines = await c.env.DB.prepare(
    `SELECT * FROM disciplines${only ? ' WHERE slug = ?' : ''}`,
  )
    .bind(...(only ? [only] : []))
    .all<Discipline>()

  const rebuilt: Record<string, number> = {}
  for (const d of disciplines.results)
    rebuilt[d.slug] = await projection.rebuild(c.env.DB, d, season.id)
  return c.json({ season: season.id, rebuilt })
})

// ---------------------------------------------------------------- Retention

/**
 * Storage limitation as code instead of as a statement of intent (Art. 5(1)(e)
 * GDPR). Meant for a cron trigger, once a day.
 *
 * Deliberately conservative: only what has demonstrably served its purpose is
 * deleted. Entries and titles stay — they are the competition itself and
 * disappear with the account, not with time.
 */
admin.post('/v1/admin/maintenance', requireAdmin, async (c) => {
  const dryRun = c.req.query('dry_run') === '1'
  const purged = await sweepRetention(c.env.DB, { dryRun })
  return c.json({ dry_run: dryRun, purged, policy: RETENTION_POLICY })
})
