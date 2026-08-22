import { Hono } from 'hono'
import { HonoApp, id, now, record, requireAdmin, requireApp, requireAppSecret, requirePlayer, secret, sha256 } from '../lib'

export const access = new Hono<HonoApp>()

// ------------------------------------------------------------------ Invites

access.post('/v1/invites', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const body = await c.req.json<{
    max_uses?: number
    expires_in_days?: number
    region_id?: string
    note?: string
    count?: number
  }>().catch(() => ({}) as Record<string, never>)

  const count = Math.min(Math.max(body.count ?? 1, 1), 100)
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const code = `${app.slug.slice(0, 6)}-${secret().slice(0, 8)}`.toUpperCase()
    await c.env.DB.prepare(
      `INSERT INTO invites (code_hash, app_id, created_by, max_uses, region_id, note, expires_at, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
      .bind(
        await sha256(code),
        app.id,
        body.max_uses ?? 1,
        body.region_id ?? null,
        body.note ?? null,
        body.expires_in_days ? new Date(Date.now() + body.expires_in_days * 86_400_000).toISOString() : null,
        now(),
      )
      .run()
    codes.push(code)
  }
  // Codes are shown exactly once; only their hash is stored.
  return c.json({ codes }, 201)
})

/** A player gives from their own allowance — this is the growth path. */
access.post('/v1/me/invites', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const row = await c.env.DB.prepare(`SELECT invites_left FROM players WHERE id = ?`)
    .bind(player.id)
    .first<{ invites_left: number }>()
  if (!row || row.invites_left <= 0) return c.json({ error: 'no invites left' }, 409)

  const code = `${player.handle.slice(0, 6)}-${secret().slice(0, 6)}`.toUpperCase()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO invites (code_hash, app_id, created_by, max_uses, created_at) VALUES (?, ?, ?, 1, ?)`,
    ).bind(await sha256(code), app.id, player.id, now()),
    c.env.DB.prepare(`UPDATE players SET invites_left = invites_left - 1 WHERE id = ?`).bind(player.id),
  ])
  return c.json({ code, invites_left: row.invites_left - 1 }, 201)
})

access.get('/v1/me/invites', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const [row, used] = await Promise.all([
    c.env.DB.prepare(`SELECT invites_left FROM players WHERE id = ?`).bind(player.id).first<{ invites_left: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM players WHERE invited_by = ?`,
    )
      .bind(player.id)
      .first<{ n: number }>(),
  ])
  const outstanding = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND uses < max_uses`,
  )
    .bind(player.id)
    .first<{ n: number }>()
  return c.json({
    invites_left: row?.invites_left ?? 0,
    outstanding: outstanding?.n ?? 0,
    joined_through_you: used?.n ?? 0,
  })
})

access.get('/v1/admin/invites', requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT i.max_uses, i.uses, i.region_id, i.note, i.expires_at, i.created_at,
            a.slug AS app, p.handle AS created_by
       FROM invites i JOIN apps a ON a.id = i.app_id
       LEFT JOIN players p ON p.id = i.created_by
      ORDER BY i.created_at DESC LIMIT 100`,
  ).all()
  return c.json({ invites: rows.results })
})

// ---------------------------------------------------------------- Waitlists

access.post('/v1/waitlist/:region', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const region = await c.env.DB.prepare(
    `SELECT id, name, level, active, unlock_threshold FROM regions WHERE id = ?`,
  )
    .bind(c.req.param('region'))
    .first<{ id: string; name: string; level: number; active: number; unlock_threshold: number }>()
  if (!region) return c.json({ error: 'unknown region' }, 404)
  if (region.active) return c.json({ error: 'region is already open', region: region.id }, 409)

  await c.env.DB.prepare(
    `INSERT INTO region_waitlist (player_id, region_id, app_id, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(player.id, region.id, app.id, now())
    .run()

  const waiting = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM region_waitlist WHERE region_id = ?`)
    .bind(region.id)
    .first<{ n: number }>()
  const count = waiting?.n ?? 0

  // The region opens itself once enough people are waiting. That is precisely
  // the density without which a geographic title means nothing.
  let opened = false
  if (region.unlock_threshold > 0 && count >= region.unlock_threshold) {
    opened = true
    await unlockRegion(c.env.DB, region.id, region.name)
  }

  return c.json(
    {
      region: region.id,
      waiting: count,
      threshold: region.unlock_threshold,
      missing: Math.max(0, region.unlock_threshold - count),
      opened,
    },
    201,
  )
})

access.get('/v1/waitlist', requireApp, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.name, r.level, r.unlock_threshold,
            (SELECT COUNT(*) FROM region_waitlist w WHERE w.region_id = r.id) AS waiting
       FROM regions r WHERE r.active = 0
      ORDER BY waiting DESC, r.name`,
  ).all<{ unlock_threshold: number; waiting: number }>()
  return c.json({
    regions: rows.results.map((r) => ({
      ...r,
      missing: Math.max(0, r.unlock_threshold - r.waiting),
    })),
  })
})

access.post('/v1/admin/regions/:id/unlock', requireAdmin, async (c) => {
  const region = await c.env.DB.prepare(`SELECT id, name, active FROM regions WHERE id = ?`)
    .bind(c.req.param('id'))
    .first<{ id: string; name: string; active: number }>()
  if (!region) return c.json({ error: 'unknown region' }, 404)
  if (region.active) return c.json({ error: 'already open' }, 409)
  const notified = await unlockRegion(c.env.DB, region.id, region.name)
  return c.json({ region: region.id, opened: true, notified })
})

/** Open a region and notify everyone waiting for it. */
async function unlockRegion(db: D1Database, regionId: string, name: string): Promise<number> {
  await db.prepare(`UPDATE regions SET active = 1 WHERE id = ?`).bind(regionId).run()
  const waiting = await db
    .prepare(`SELECT player_id, app_id FROM region_waitlist WHERE region_id = ? AND notified_at IS NULL`)
    .bind(regionId)
    .all<{ player_id: string; app_id: string | null }>()
  for (const w of waiting.results) {
    await record(db, w.app_id, w.player_id, 'region.opened', { region: regionId, name })
  }
  await db
    .prepare(`UPDATE region_waitlist SET notified_at = ? WHERE region_id = ? AND notified_at IS NULL`)
    .bind(now(), regionId)
    .run()
  return waiting.results.length
}

export { unlockRegion }
