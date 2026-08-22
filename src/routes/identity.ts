import { Hono } from 'hono'
import {
  HonoApp,
  currentSeason,
  id,
  now,
  record,
  requireApp,
  requirePlayer,
  secret,
  sha256,
} from '../lib'

export const identity = new Hono<HonoApp>()

/** How many anonymous accounts an app may create per hour. Without this limit
  *  the geographic ladder can be flooded with throwaway accounts. */
const SIGNUPS_PER_HOUR = 60

identity.post('/v1/auth/anonymous', requireApp, async (c) => {
  const app = c.get('app')!
  const access = await c.env.DB.prepare(
    `SELECT access_mode, invites_per_player FROM apps WHERE id = ?`,
  )
    .bind(app.id)
    .first<{ access_mode: string; invites_per_player: number }>()
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM player_apps WHERE app_id = ? AND first_seen > ?`,
  )
    .bind(app.id, new Date(Date.now() - 3600_000).toISOString())
    .first<{ n: number }>()
  if ((recent?.n ?? 0) >= SIGNUPS_PER_HOUR)
    return c.json({ error: 'too many new accounts this hour' }, 429)
  const body = await c.req
    .json<{ handle?: string; invite_code?: string }>()
    .catch(() => ({}) as { handle?: string; invite_code?: string })
  const handle = (body.handle ?? `spieler-${id('').slice(1, 7)}`).trim()
  if (handle.length < 3) return c.json({ error: 'handle needs at least three characters' }, 400)

  // Closed app: nobody gets in without a valid invite.
  let invite: { code_hash: string; created_by: string | null; region_id: string | null } | null = null
  if (access?.access_mode === 'invite' || body.invite_code) {
    if (!body.invite_code) return c.json({ error: 'invite required' }, 403)
    const found = await c.env.DB.prepare(
      `SELECT code_hash, created_by, region_id, uses, max_uses, expires_at
         FROM invites WHERE code_hash = ? AND app_id = ?`,
    )
      .bind(await sha256(body.invite_code.trim().toUpperCase()), app.id)
      .first<{
        code_hash: string
        created_by: string | null
        region_id: string | null
        uses: number
        max_uses: number
        expires_at: string | null
      }>()
    if (!found) return c.json({ error: 'unknown invite' }, 404)
    if (found.uses >= found.max_uses) return c.json({ error: 'invite used up' }, 409)
    if (found.expires_at && new Date(found.expires_at) < new Date())
      return c.json({ error: 'invite expired' }, 409)
    invite = found
  }

  if (await c.env.DB.prepare(`SELECT id FROM players WHERE handle = ?`).bind(handle).first())
    return c.json({ error: 'handle taken' }, 409)

  const playerId = id('plr')
  const bearer = secret()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO players (id, handle, created_at, invited_by, invites_left) VALUES (?, ?, ?, ?, ?)`,
    ).bind(playerId, handle, now(), invite?.created_by ?? null, access?.invites_per_player ?? 0),
    c.env.DB.prepare(
      `INSERT INTO sessions (token_hash, player_id, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      await sha256(bearer),
      playerId,
      `new account · ${(c.req.header('User-Agent') ?? '').slice(0, 60)}`,
      now(),
      now(),
    ),
    c.env.DB.prepare(`INSERT INTO player_apps (player_id, app_id, first_seen) VALUES (?, ?, ?)`).bind(
      playerId,
      app.id,
      now(),
    ),
  ])
  if (invite) {
    await c.env.DB.prepare(`UPDATE invites SET uses = uses + 1 WHERE code_hash = ?`)
      .bind(invite.code_hash)
      .run()
    // An invite tied to a district sets that district right away.
    const season = await currentSeason(c.env.DB)
    if (invite.region_id && season)
      await c.env.DB.prepare(
        `INSERT INTO player_regions (player_id, season_id, region_id, locked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
        .bind(playerId, season.id, invite.region_id, now())
        .run()
    if (invite.created_by)
      await record(c.env.DB, app.id, invite.created_by, 'invite.redeemed', { handle })
  }

  await record(c.env.DB, app.id, playerId, 'player.created', { handle })
  return c.json({ player_id: playerId, handle, token: bearer, invited_by: invite?.created_by ?? null }, 201)
})

/**
 * Carry the same identity to a second device or to an app on another domain.
 * Without this, "one identity across all apps" would be a mere promise, because
 * localStorage is separated per origin.
 */
identity.post('/v1/me/link-code', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const code = `${Math.floor(100000 + Math.random() * 900000)}`
  const expires = new Date(Date.now() + 10 * 60_000).toISOString()
  await c.env.DB.prepare(
    `INSERT INTO link_codes (code_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(await sha256(code), player.id, expires, now())
    .run()
  return c.json({ code, expires_at: expires }, 201)
})

identity.post('/v1/auth/redeem', requireApp, async (c) => {
  const app = c.get('app')!
  const { code } = await c.req.json<{ code: string }>()
  const hash = await sha256(String(code))
  const row = await c.env.DB.prepare(
    `SELECT player_id, expires_at, used_at FROM link_codes WHERE code_hash = ?`,
  )
    .bind(hash)
    .first<{ player_id: string; expires_at: string; used_at: string | null }>()
  if (!row) return c.json({ error: 'unknown code' }, 404)
  if (row.used_at) return c.json({ error: 'code already used' }, 409)
  if (new Date(row.expires_at) < new Date()) return c.json({ error: 'code expired' }, 409)

  const bearer = secret()
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE link_codes SET used_at = ? WHERE code_hash = ?`).bind(now(), hash),
    c.env.DB.prepare(
      `INSERT INTO sessions (token_hash, player_id, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      await sha256(bearer),
      row.player_id,
      `link code · ${(c.req.header('User-Agent') ?? '').slice(0, 60)}`,
      now(),
      now(),
    ),
    c.env.DB.prepare(
      `INSERT INTO player_apps (player_id, app_id, first_seen) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(row.player_id, app.id, now()),
  ])
  const player = await c.env.DB.prepare(`SELECT id, handle FROM players WHERE id = ?`)
    .bind(row.player_id)
    .first()
  return c.json({ ...player, token: bearer }, 201)
})

identity.get('/v1/me', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const season = await currentSeason(c.env.DB)
  const [region, quals, badges, titles, apps, items] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.id, r.name, r.level FROM player_regions pr JOIN regions r ON r.id = pr.region_id
        WHERE pr.player_id = ? AND pr.season_id = ?`,
    )
      .bind(player.id, season?.id ?? '')
      .first(),
    c.env.DB.prepare(
      `SELECT a.slug AS app, d.slug AS discipline, q.value_at, q.achieved_at
         FROM qualifications q JOIN disciplines d ON d.id = q.discipline_id
         JOIN apps a ON a.id = d.app_id
        WHERE q.player_id = ? AND q.season_id = ?`,
    )
      .bind(player.id, season?.id ?? '')
      .all(),
    c.env.DB.prepare(
      `SELECT b.id, b.name, b.description, pb.earned_at FROM player_badges pb
         JOIN badges b ON b.id = pb.badge_id WHERE pb.player_id = ? ORDER BY pb.earned_at`,
    )
      .bind(player.id)
      .all(),
    c.env.DB.prepare(
      `SELECT t.id, t.level, t.season_id, r.name AS region, d.slug AS discipline,
              a.slug AS app, t.contenders, t.awarded_at
         FROM titles t JOIN regions r ON r.id = t.region_id
         JOIN disciplines d ON d.id = t.discipline_id JOIN apps a ON a.id = d.app_id
        WHERE t.player_id = ? ORDER BY t.level DESC`,
    )
      .bind(player.id)
      .all(),
    c.env.DB.prepare(
      `SELECT a.slug, a.name FROM player_apps pa JOIN apps a ON a.id = pa.app_id
        WHERE pa.player_id = ?`,
    )
      .bind(player.id)
      .all(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM player_items WHERE player_id = ?`,
    )
      .bind(player.id)
      .first<{ n: number }>(),
  ])

  const profile = await c.env.DB.prepare(
    `SELECT display_name, avatar, locale, featured_title, featured_badge,
            status, status_until, status_reason, invites_left, handle_changed_at,
            recovery_email, recovery_verified_at,
            (SELECT COUNT(*) FROM passkeys k WHERE k.player_id = players.id) AS passkeys
       FROM players WHERE id = ?`,
  )
    .bind(player.id)
    .first()

  return c.json({
    player: { id: player.id, handle: player.handle, created_at: player.created_at, ...profile },
    season,
    region,
    apps: apps.results,
    qualifications: quals.results,
    badges: badges.results,
    titles: titles.results,
    items_owned: items?.n ?? 0,
  })
})

identity.patch('/v1/me/region', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const { region_id } = await c.req.json<{ region_id: string }>()
  const season = await currentSeason(c.env.DB)
  if (!season) return c.json({ error: 'no open season' }, 409)

  const existing = await c.env.DB.prepare(
    `SELECT region_id FROM player_regions WHERE player_id = ? AND season_id = ?`,
  )
    .bind(player.id, season.id)
    .first<{ region_id: string }>()
  // Locked per season: otherwise everyone moves to the emptiest district.
  if (existing)
    return c.json(
      { error: 'home region is locked for this season', region_id: existing.region_id },
      409,
    )

  const region = await c.env.DB.prepare(
    `SELECT id, name, level FROM regions WHERE id = ? AND active = 1`,
  )
    .bind(region_id)
    .first<{ id: string; name: string; level: number }>()
  if (!region) return c.json({ error: 'unknown region' }, 404)
  if (region.level !== 1) return c.json({ error: 'home region must be a district' }, 400)

  await c.env.DB.prepare(
    `INSERT INTO player_regions (player_id, season_id, region_id, locked_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(player.id, season.id, region_id, now())
    .run()
  return c.json({ region, locked_until: season.ends_at })
})

identity.get('/v1/players', requireApp, async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (q.length < 2) return c.json({ error: 'q needs at least two characters' }, 400)

  // A signed-in search hides anyone on either side of a block.
  const auth = c.req.header('Authorization') ?? ''
  const me = auth.startsWith('Bearer ')
    ? await c.env.DB.prepare(
        `SELECT p.id FROM players p JOIN sessions s ON s.player_id = p.id WHERE s.token_hash = ?`,
      )
        .bind(await sha256(auth.slice(7)))
        .first<{ id: string }>()
    : null

  const rows = await c.env.DB.prepare(
    `SELECT id, handle, display_name FROM players
      WHERE handle LIKE ? AND status != 'banned'
        AND (? IS NULL OR id NOT IN (
          SELECT blocked_id FROM blocks WHERE blocker_id = ?
          UNION SELECT blocker_id FROM blocks WHERE blocked_id = ?))
      ORDER BY handle LIMIT 20`,
  )
    .bind(`${q}%`, me?.id ?? null, me?.id ?? null, me?.id ?? null)
    .all()
  return c.json({ players: rows.results })
})

identity.get('/v1/players/:handle', requireApp, async (c) => {
  const player = await c.env.DB.prepare(
    `SELECT id, handle, created_at, display_name, avatar, featured_title, featured_badge, status
       FROM players WHERE handle = ?`,
  )
    .bind(c.req.param('handle'))
    .first<{ id: string; status: string }>()
  if (!player || player.status === 'banned') return c.json({ error: 'unknown' }, 404)
  const [badges, titles] = await Promise.all([
    c.env.DB.prepare(
      `SELECT b.id, b.name FROM player_badges pb JOIN badges b ON b.id = pb.badge_id
        WHERE pb.player_id = ?`,
    )
      .bind(player.id)
      .all(),
    c.env.DB.prepare(
      `SELECT r.name AS region, t.level, d.slug AS discipline FROM titles t
         JOIN regions r ON r.id = t.region_id JOIN disciplines d ON d.id = t.discipline_id
        WHERE t.player_id = ?`,
    )
      .bind(player.id)
      .all(),
  ])
  // Public profile: titles and badges, no region, no ledger.
  const { status, ...visible } = player as Record<string, unknown>
  return c.json({ ...visible, badges: badges.results, titles: titles.results })
})

// ------------------------------------------------------- Export & deletion

/**
 * Complete export of everything stored about this player. Mandatory once a
 * region is attached — and a selling point against developers who have no
 * answer of their own.
 */
identity.get('/v1/me/export', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const tables: Record<string, string> = {
    entries: `SELECT * FROM entries WHERE player_id = ?`,
    qualifications: `SELECT * FROM qualifications WHERE player_id = ?`,
    regions: `SELECT * FROM player_regions WHERE player_id = ?`,
    titles: `SELECT * FROM titles WHERE player_id = ?`,
    badges: `SELECT * FROM player_badges WHERE player_id = ?`,
    items: `SELECT * FROM player_items WHERE player_id = ?`,
    ratings: `SELECT * FROM ratings WHERE player_id = ?`,
    matches: `SELECT * FROM match_placements WHERE player_id = ?`,
    challenges: `SELECT * FROM challenges WHERE challenger_id = ? OR opponent_id = ?`,
    apps: `SELECT * FROM player_apps WHERE player_id = ?`,
    events: `SELECT * FROM events WHERE player_id = ?`,
  }
  const data: Record<string, unknown> = { player }
  for (const [name, sql] of Object.entries(tables)) {
    const binds = sql.includes('opponent_id') ? [player.id, player.id] : [player.id]
    data[name] = (await c.env.DB.prepare(sql).bind(...binds).all()).results
  }
  return c.json(data)
})

/** Final. No anonymised leftovers, no trash bin. */
identity.delete('/v1/me', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const p = player.id
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM challenge_entries WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM challenges WHERE challenger_id = ? OR opponent_id = ?`).bind(p, p),
    c.env.DB.prepare(`DELETE FROM match_placements WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM ratings WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM titles WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM player_badges WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM player_items WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM standings WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM passkeys WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM recovery_tokens WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM webauthn_challenges WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM qualifications WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM entries WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM player_regions WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM player_apps WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM link_codes WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM events WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM sessions WHERE player_id = ?`).bind(p),
    c.env.DB.prepare(`DELETE FROM players WHERE id = ?`).bind(p),
  ])
  return c.json({ deleted: true })
})
