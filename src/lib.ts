import type { Context, Next } from 'hono'

export type Env = {
  DB: D1Database
  BLOBS: R2Bucket
  ADMIN_KEY: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GITHUB_CALLBACK_URL?: string
  CONSOLE_ORIGIN?: string
  DEV_ALLOWLIST?: string
  RP_ID?: string
  RP_ORIGINS?: string
  RESEND_API_KEY?: string
  MAIL_FROM?: string
  MAIL_LINK_BASE?: string
}
export type Vars = {
  player?: Player
  app?: AppRow
  scope?: 'public' | 'secret'
  developer?: {
    id: string
    provider: string
    login: string
    name: string | null
    email: string | null
    avatar_url: string | null
    two_factor: number
    app_quota: number
  }
}
export type HonoApp = { Bindings: Env; Variables: Vars }

export type Player = {
  id: string
  handle: string
  created_at: string
  status: 'active' | 'suspended' | 'banned'
  status_until: string | null
  status_reason: string | null
}
export type AppRow = { id: string; slug: string; name: string }

export type Aggregation = 'best' | 'sum' | 'count' | 'streak'
export type Discipline = {
  id: string
  app_id: string
  slug: string
  name: string
  category: string
  unit: string | null
  aggregation: Aggregation
  score_direction: 'asc' | 'desc'
  trust_tier: number
  qualifying_score: number | null
  max_title_level: number
  title_min_players: number
  head_to_head: number
  max_value: number | null
  module_id: string | null
  verify_export: string
  verify_timeout_ms: number
}

export const now = () => new Date().toISOString()
export const dayOf = (iso: string) => iso.slice(0, 10)

export const id = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`

export const secret = () => {
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  return hex(raw)
}

/**
 * App keys carry a distinctive, greppable prefix. That is not decoration: it
 * lets a secret scanner recognise a leaked key in a public repository, and it
 * lets a person tell at a glance which half of the pair they are holding.
 */
export const KEY_PREFIX = { public: 'chapi_pk', secret: 'chapi_sk' } as const
export const mintKey = (kind: 'public' | 'secret') => `${KEY_PREFIX[kind]}_${secret()}`

/** Record an action that changed access or moderation state. */
export async function audit(
  db: D1Database,
  actor: { kind: 'developer' | 'operator' | 'player' | 'system'; id?: string; label?: string },
  action: string,
  subject?: string,
  detail?: unknown,
) {
  await db
    .prepare(
      `INSERT INTO audit_log (actor_kind, actor_id, actor_label, action, subject, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      actor.kind,
      actor.id ?? null,
      actor.label ?? null,
      action,
      subject ?? null,
      detail === undefined ? null : JSON.stringify(detail),
      now(),
    )
    .run()
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256(input: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))))
}

/** For 'best' the direction decides, otherwise more is always better. */
export const higherIsBetter = (d: { aggregation: Aggregation; score_direction: string }) =>
  d.aggregation === 'best' ? d.score_direction !== 'asc' : true

export const beats = (d: Discipline, a: number, b: number) =>
  higherIsBetter(d) ? a > b : a < b
export const reaches = (d: Discipline, value: number, bar: number) =>
  higherIsBetter(d) ? value >= bar : value <= bar

/** The most recently started season, open or not — for reports after a close. */
export async function latestSeason(db: D1Database) {
  return db
    .prepare(`SELECT * FROM seasons ORDER BY starts_at DESC LIMIT 1`)
    .first<{ id: string; name: string; starts_at: string; ends_at: string; status: string }>()
}

export async function currentSeason(db: D1Database) {
  return db
    .prepare(`SELECT * FROM seasons WHERE status = 'open' ORDER BY starts_at DESC LIMIT 1`)
    .first<{ id: string; name: string; starts_at: string; ends_at: string; status: string }>()
}

export async function record(
  db: D1Database,
  appId: string | null,
  playerId: string | null,
  type: string,
  payload: unknown,
) {
  await db
    .prepare(`INSERT INTO events (app_id, player_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(appId, playerId, type, JSON.stringify(payload), now())
    .run()
}

// -------------------------------------------------------------------- Access

/** Public key: everything that is allowed to live inside a client. */
export async function requireApp(c: Context<HonoApp>, next: Next) {
  return resolveApp(c, next, 'public')
}

/** Secret key: authority that never belongs in a client. */
export async function requireAppSecret(c: Context<HonoApp>, next: Next) {
  return resolveApp(c, next, 'secret')
}

/** How stale `last_used_at` may get before we write it again. */
const KEY_TOUCH_INTERVAL_MS = 3600_000

async function resolveApp(c: Context<HonoApp>, next: Next, need: 'public' | 'secret') {
  const key = c.req.header('X-App-Key')
  if (!key) return c.json({ error: 'X-App-Key missing' }, 401)

  const row = await c.env.DB.prepare(
    `SELECT k.id AS key_id, k.kind, k.revoked_at, k.expires_at, k.last_used_at,
            a.id, a.slug, a.name
       FROM api_keys k JOIN apps a ON a.id = k.app_id
      WHERE k.key_hash = ?`,
  )
    .bind(await sha256(key))
    .first<
      AppRow & {
        key_id: string
        kind: 'public' | 'secret'
        revoked_at: string | null
        expires_at: string | null
        last_used_at: string | null
      }
    >()
  if (!row) return c.json({ error: 'unknown app key' }, 401)
  // A revoked key says so plainly. Silence here would cost somebody an hour.
  if (row.revoked_at) return c.json({ error: 'app key revoked', revoked_at: row.revoked_at }, 401)
  if (row.expires_at && Date.parse(row.expires_at) < Date.now())
    return c.json({ error: 'app key expired', expired_at: row.expires_at }, 401)

  if (need === 'secret' && row.kind !== 'secret')
    return c.json({ error: 'this call requires the secret app key' }, 403)

  // "Last used" is what makes an old key safe to retire. Written at most once
  // an hour so it never becomes a write on the hot path.
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > KEY_TOUCH_INTERVAL_MS) {
    await c.env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
      .bind(now(), row.key_id)
      .run()
  }

  c.set('app', { id: row.id, slug: row.slug, name: row.name })
  c.set('scope', row.kind)
  await next()
}

export async function requirePlayer(c: Context<HonoApp>, next: Next) {
  const auth = c.req.header('Authorization') ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!bearer) return c.json({ error: 'missing bearer token' }, 401)
  const hash = await sha256(bearer)
  const player = await c.env.DB.prepare(
    `SELECT p.* FROM players p JOIN sessions s ON s.player_id = p.id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
  )
    .bind(hash)
    .first<Player>()
  if (!player) return c.json({ error: 'invalid token' }, 401)

  // An expired suspension lifts itself on the next request.
  if (player.status === 'suspended' && player.status_until && Date.parse(player.status_until) < Date.now()) {
    await c.env.DB.prepare(
      `UPDATE players SET status = 'active', status_until = NULL, status_reason = NULL WHERE id = ?`,
    )
      .bind(player.id)
      .run()
    player.status = 'active'
    player.status_until = null
  }

  await c.env.DB.prepare(`UPDATE sessions SET last_seen = ? WHERE token_hash = ?`)
    .bind(now(), hash)
    .run()
  c.set('player', player)
  await next()
}

export function requireAdmin(c: Context<HonoApp>, next: Next) {
  if (c.req.header('X-Admin-Key') !== c.env.ADMIN_KEY)
    return c.json({ error: 'admin key required' }, 401)
  return next()
}

/** A suspended or banned player may still read, but no longer contribute. */
export function mayContribute(player: Player) {
  return player.status === 'active'
}

export async function discipline(db: D1Database, appId: string, slug: string) {
  return db
    .prepare(`SELECT * FROM disciplines WHERE app_id = ? AND slug = ?`)
    .bind(appId, slug)
    .first<Discipline>()
}
