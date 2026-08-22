import { Hono } from 'hono'
import { HonoApp, id, now, record, requireApp, requireAdmin, requirePlayer, sha256 } from '../lib'
import { setEligibility } from '../projection'

export const social = new Hono<HonoApp>()

/** How long a handle stays put after a change. */
const HANDLE_COOLDOWN_DAYS = 30

// ------------------------------------------------------------------ Profile

social.patch('/v1/me/profile', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const body = await c.req.json<{
    display_name?: string | null
    avatar?: string | null
    locale?: string | null
    featured_title?: string | null
    featured_badge?: string | null
  }>()

  if (body.display_name && body.display_name.length > 40)
    return c.json({ error: 'display_name is limited to 40 characters' }, 400)

  // You can only feature what you actually own.
  if (body.featured_title) {
    const owned = await c.env.DB.prepare(`SELECT 1 AS ok FROM titles WHERE id = ? AND player_id = ?`)
      .bind(body.featured_title, player.id)
      .first()
    if (!owned) return c.json({ error: 'that title is not yours' }, 403)
  }
  if (body.featured_badge) {
    const owned = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM player_badges WHERE badge_id = ? AND player_id = ?`,
    )
      .bind(body.featured_badge, player.id)
      .first()
    if (!owned) return c.json({ error: 'that badge is not yours' }, 403)
  }

  const fields = ['display_name', 'avatar', 'locale', 'featured_title', 'featured_badge'] as const
  const set = fields.filter((f) => f in body)
  if (set.length === 0) return c.json({ error: 'nothing to change' }, 400)
  await c.env.DB.prepare(`UPDATE players SET ${set.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
    .bind(...set.map((f) => body[f] ?? null), player.id)
    .run()

  const updated = await c.env.DB.prepare(
    `SELECT id, handle, display_name, avatar, locale, featured_title, featured_badge FROM players WHERE id = ?`,
  )
    .bind(player.id)
    .first()
  return c.json(updated)
})

social.patch('/v1/me/handle', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const { handle } = await c.req.json<{ handle: string }>()
  if (!handle || handle.trim().length < 3) return c.json({ error: 'handle needs at least three characters' }, 400)

  const current = await c.env.DB.prepare(`SELECT handle_changed_at FROM players WHERE id = ?`)
    .bind(player.id)
    .first<{ handle_changed_at: string | null }>()
  if (current?.handle_changed_at) {
    const next = Date.parse(current.handle_changed_at) + HANDLE_COOLDOWN_DAYS * 86_400_000
    // A name on a leaderboard is an identifier. It must not change daily.
    if (Date.now() < next)
      return c.json({ error: 'handle was changed recently', next_change: new Date(next).toISOString() }, 409)
  }

  const taken = await c.env.DB.prepare(`SELECT id FROM players WHERE handle = ?`).bind(handle.trim()).first()
  if (taken) return c.json({ error: 'handle taken' }, 409)

  await c.env.DB.prepare(`UPDATE players SET handle = ?, handle_changed_at = ? WHERE id = ?`)
    .bind(handle.trim(), now(), player.id)
    .run()
  await record(c.env.DB, c.get('app')!.id, player.id, 'handle.changed', {
    from: player.handle,
    to: handle.trim(),
  })
  return c.json({ handle: handle.trim(), next_change_after_days: HANDLE_COOLDOWN_DAYS })
})

// ---------------------------------------------------------------- Rivals

social.post('/v1/me/follows/:handle', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const target = await c.env.DB.prepare(`SELECT id, handle FROM players WHERE handle = ?`)
    .bind(c.req.param('handle'))
    .first<{ id: string; handle: string }>()
  if (!target) return c.json({ error: 'unknown player' }, 404)
  if (target.id === player.id) return c.json({ error: 'not yourself' }, 400)
  if (await blocked(c.env.DB, player.id, target.id)) return c.json({ error: 'not possible' }, 403)

  await c.env.DB.prepare(
    `INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(player.id, target.id, now())
    .run()
  return c.json({ following: target.handle }, 201)
})

social.delete('/v1/me/follows/:handle', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const res = await c.env.DB.prepare(
    `DELETE FROM follows WHERE follower_id = ?
      AND followee_id = (SELECT id FROM players WHERE handle = ?)`,
  )
    .bind(player.id, c.req.param('handle'))
    .run()
  if (!res.meta.changes) return c.json({ error: 'not following' }, 404)
  return c.json({ unfollowed: c.req.param('handle') })
})

social.get('/v1/me/follows', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const rows = await c.env.DB.prepare(
    `SELECT p.handle, p.display_name, p.status FROM follows f JOIN players p ON p.id = f.followee_id
      WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT 200`,
  )
    .bind(player.id)
    .all()
  return c.json({ follows: rows.results })
})

// ---------------------------------------------------------------- Blocks

async function blocked(db: D1Database, a: string, b: string) {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM blocks
        WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
    )
    .bind(a, b, b, a)
    .first()
  return Boolean(row)
}

social.post('/v1/me/blocks/:handle', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const target = await c.env.DB.prepare(`SELECT id, handle FROM players WHERE handle = ?`)
    .bind(c.req.param('handle'))
    .first<{ id: string; handle: string }>()
  if (!target) return c.json({ error: 'unknown player' }, 404)
  if (target.id === player.id) return c.json({ error: 'not yourself' }, 400)

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(player.id, target.id, now()),
    // A block dissolves existing connections in both directions.
    c.env.DB.prepare(
      `DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)`,
    ).bind(player.id, target.id, target.id, player.id),
    c.env.DB.prepare(
      `UPDATE challenges SET state = 'expired', settled_at = ?
        WHERE state IN ('open','accepted')
          AND ((challenger_id = ? AND opponent_id = ?) OR (challenger_id = ? AND opponent_id = ?))`,
    ).bind(now(), player.id, target.id, target.id, player.id),
  ])
  return c.json({ blocked: target.handle }, 201)
})

social.delete('/v1/me/blocks/:handle', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const res = await c.env.DB.prepare(
    `DELETE FROM blocks WHERE blocker_id = ?
      AND blocked_id = (SELECT id FROM players WHERE handle = ?)`,
  )
    .bind(player.id, c.req.param('handle'))
    .run()
  if (!res.meta.changes) return c.json({ error: 'not blocked' }, 404)
  return c.json({ unblocked: c.req.param('handle') })
})

social.get('/v1/me/blocks', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const rows = await c.env.DB.prepare(
    `SELECT p.handle FROM blocks b JOIN players p ON p.id = b.blocked_id
      WHERE b.blocker_id = ? ORDER BY b.created_at DESC`,
  )
    .bind(player.id)
    .all()
  return c.json({ blocks: rows.results })
})

// ----------------------------------------------------------------- Reports

social.post('/v1/reports', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const body = await c.req.json<{ handle: string; reason: string; detail?: string }>()
  const reasons = ['handle', 'cheating', 'harassment', 'other']
  if (!reasons.includes(body.reason)) return c.json({ error: `reason must be one of: ${reasons.join(', ')}` }, 400)

  const subject = await c.env.DB.prepare(`SELECT id FROM players WHERE handle = ?`)
    .bind(body.handle)
    .first<{ id: string }>()
  if (!subject) return c.json({ error: 'unknown player' }, 404)
  if (subject.id === player.id) return c.json({ error: 'not yourself' }, 400)

  const reportId = id('rep')
  try {
    await c.env.DB.prepare(
      `INSERT INTO reports (id, app_id, reporter_id, subject_id, reason, detail, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
      .bind(reportId, app.id, player.id, subject.id, body.reason, body.detail?.slice(0, 500) ?? null, now())
      .run()
  } catch {
    // One open report per reporter and subject is enough.
    return c.json({ error: 'already reported' }, 409)
  }
  return c.json({ id: reportId, state: 'open' }, 201)
})

// ------------------------------------------------- Moderation (operator side)

social.get('/v1/admin/reports', requireAdmin, async (c) => {
  const state = c.req.query('state') ?? 'open'
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.reason, r.detail, r.state, r.action, r.created_at,
            a.slug AS app, rep.handle AS reporter,
            sub.handle AS subject, sub.status AS subject_status, sub.display_name AS subject_name
       FROM reports r
       LEFT JOIN apps a ON a.id = r.app_id
       JOIN players rep ON rep.id = r.reporter_id
       JOIN players sub ON sub.id = r.subject_id
      WHERE r.state = ? ORDER BY r.created_at LIMIT 100`,
  )
    .bind(state)
    .all()
  return c.json({ reports: rows.results })
})

social.post('/v1/admin/reports/:id/resolve', requireAdmin, async (c) => {
  const body = await c.req.json<{ action: 'none' | 'rename' | 'suspend' | 'ban'; days?: number; reason?: string }>()
  const actions = ['none', 'rename', 'suspend', 'ban']
  if (!actions.includes(body.action)) return c.json({ error: `action must be one of: ${actions.join(', ')}` }, 400)

  const report = await c.env.DB.prepare(`SELECT id, subject_id, state FROM reports WHERE id = ?`)
    .bind(c.req.param('id'))
    .first<{ id: string; subject_id: string; state: string }>()
  if (!report) return c.json({ error: 'unknown report' }, 404)
  if (report.state !== 'open') return c.json({ error: 'already resolved' }, 409)

  const applied: Record<string, unknown> = { action: body.action }
  if (body.action === 'rename') {
    const fresh = `spieler-${id('').slice(1, 9)}`
    await c.env.DB.prepare(
      `UPDATE players SET handle = ?, display_name = NULL, handle_changed_at = ? WHERE id = ?`,
    )
      .bind(fresh, now(), report.subject_id)
      .run()
    applied.handle = fresh
  }
  if (body.action === 'suspend' || body.action === 'ban') {
    const until = body.action === 'suspend' ? new Date(Date.now() + (body.days ?? 7) * 86_400_000).toISOString() : null
    await c.env.DB.prepare(`UPDATE players SET status = ?, status_until = ?, status_reason = ? WHERE id = ?`)
      .bind(body.action === 'ban' ? 'banned' : 'suspended', until, body.reason ?? null, report.subject_id)
      .run()
    // A ban has to leave every board at once, not at the next entry.
    if (body.action === 'ban') await setEligibility(c.env.DB, report.subject_id, true)
    applied.until = until
  }

  await c.env.DB.prepare(
    `UPDATE reports SET state = 'resolved', action = ?, resolved_at = ? WHERE id = ?`,
  )
    .bind(body.action, now(), report.id)
    .run()
  await record(c.env.DB, null, report.subject_id, 'moderation.applied', applied)
  return c.json({ id: report.id, state: 'resolved', ...applied })
})

social.post('/v1/admin/players/:handle/status', requireAdmin, async (c) => {
  const body = await c.req.json<{ status: 'active' | 'suspended' | 'banned'; days?: number; reason?: string }>()
  if (!['active', 'suspended', 'banned'].includes(body.status))
    return c.json({ error: 'unknown status' }, 400)
  const until =
    body.status === 'suspended' ? new Date(Date.now() + (body.days ?? 7) * 86_400_000).toISOString() : null
  const player = await c.env.DB.prepare(`SELECT id FROM players WHERE handle = ?`)
    .bind(c.req.param('handle'))
    .first<{ id: string }>()
  if (!player) return c.json({ error: 'unknown player' }, 404)

  await c.env.DB.prepare(`UPDATE players SET status = ?, status_until = ?, status_reason = ? WHERE id = ?`)
    .bind(body.status, until, body.reason ?? null, player.id)
    .run()
  // Banning removes somebody from every board; coming back still requires the
  // exam, so it is not simply the reverse.
  await setEligibility(c.env.DB, player.id, body.status === 'banned')
  return c.json({ handle: c.req.param('handle'), status: body.status, until })
})

export { blocked }
