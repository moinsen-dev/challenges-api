import { Hono } from 'hono'
import {
  Discipline,
  HonoApp,
  beats,
  currentSeason,
  dayOf,
  discipline,
  id,
  now,
  reaches,
  record,
  requireApp,
  requireAppSecret,
  requirePlayer,
  mayContribute,
  sha256,
} from '../lib'
import { currentStreak, valueFor } from '../standings'
import * as projection from '../projection'
import { syncQualification } from '../qualify'
import { queueVerification } from './verify'
import { evaluateBadges } from '../badges'
import { pairwiseScores, updateRating } from '../glicko'

export const compete = new Hono<HonoApp>()

compete.get('/v1/catalog', requireApp, async (c) => {
  const app = c.get('app')!
  const [disciplines, regions, season, collections] = await Promise.all([
    c.env.DB.prepare(
      `SELECT slug, name, category, unit, aggregation, score_direction, trust_tier,
              qualifying_score, max_title_level, title_min_players, head_to_head
         FROM disciplines WHERE app_id = ?`,
    )
      .bind(app.id)
      .all(),
    c.env.DB.prepare(`SELECT id, parent_id, level, name FROM regions WHERE active = 1`).all(),
    currentSeason(c.env.DB),
    c.env.DB.prepare(`SELECT slug, name FROM collections WHERE app_id = ?`).bind(app.id).all(),
  ])
  return c.json({
    app,
    season,
    disciplines: disciplines.results,
    regions: regions.results,
    collections: collections.results,
  })
})

// ------------------------------------------------------------------- Entries

compete.post('/v1/entries', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const body = await c.req.json<{
    discipline: string
    value: number
    occurred_at?: string
    meta?: unknown
    idem_key?: string
    /** Base64 input trace. Required once a discipline can prove its runs. */
    trace?: string
  }>()

  // A suspended player may keep reading, but no longer contribute.
  if (!mayContribute(player))
    return c.json({ error: `account is ${player.status}`, until: player.status_until }, 403)

  const d = await discipline(c.env.DB, app.id, body.discipline)
  if (!d) return c.json({ error: 'unknown discipline' }, 404)
  // From tier 2 on, a client is no longer an authority.
  if (d.trust_tier >= 2 && c.get('scope') !== 'secret')
    return c.json({ error: 'this discipline requires the secret app key' }, 403)
  if (typeof body.value !== 'number' || !Number.isFinite(body.value))
    return c.json({ error: 'value must be a number' }, 400)

  const season = await currentSeason(c.env.DB)
  if (!season) return c.json({ error: 'no open season' }, 409)

  // meta is free-form and therefore the only place where an app could
  // accidentally store personal data. Keep it small.
  const meta = body.meta ? JSON.stringify(body.meta) : null
  if (meta && meta.length > 4096) return c.json({ error: 'meta is limited to 4 KB' }, 413)

  const occurredAt = body.occurred_at ?? now()
  if (Date.parse(occurredAt) > Date.now() + 86_400_000)
    return c.json({ error: 'occurred_at is in the future' }, 400)

  if (body.idem_key) {
    const seen = await c.env.DB.prepare(
      `SELECT id, status FROM entries WHERE discipline_id = ? AND player_id = ? AND idem_key = ?`,
    )
      .bind(d.id, player.id, body.idem_key)
      .first<{ id: string; status: string }>()
    if (seen) return c.json({ entry_id: seen.id, duplicate: true, status: seen.status }, 200)
  }

  const region = await c.env.DB.prepare(
    `SELECT region_id FROM player_regions WHERE player_id = ? AND season_id = ?`,
  )
    .bind(player.id, season.id)
    .first<{ region_id: string }>()

  // Plausibility limit: do not delete, hold for review.
  const suspicious = d.max_value !== null && Math.abs(body.value) > d.max_value
  const status = suspicious ? 'review' : 'counted'

  const entryId = id('ent')
  const insert = c.env.DB.prepare(
    `INSERT INTO entries
       (id, discipline_id, season_id, player_id, region_id, value, day, occurred_at,
        trust_tier, status, meta, idem_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      entryId,
      d.id,
      season.id,
      player.id,
      region?.region_id ?? null,
      body.value,
      dayOf(occurredAt),
      occurredAt,
      d.trust_tier,
      status,
      meta,
      body.idem_key ?? null,
      now(),
    )

  try {
    await insert.run()
  } catch (error) {
    // Two identical submissions at once: the unique index holds, and the second
    // call gets the same answer a late straggler would.
    const raced =
      body.idem_key &&
      (await c.env.DB.prepare(
        `SELECT id, status FROM entries WHERE discipline_id = ? AND player_id = ? AND idem_key = ?`,
      )
        .bind(d.id, player.id, body.idem_key)
        .first<{ id: string; status: string }>())
    if (!raced) throw error
    return c.json({ entry_id: raced.id, duplicate: true, status: raced.status }, 200)
  }

  await c.env.DB.prepare(
    `INSERT INTO player_apps (player_id, app_id, first_seen) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(player.id, app.id, now())
    .run()

  if (suspicious) {
    await record(c.env.DB, app.id, player.id, 'entry.flagged', {
      entry_id: entryId,
      value: body.value,
      max_value: d.max_value,
    })
    return c.json({ entry_id: entryId, status, ranked: false, reason: 'held for review' }, 202)
  }

  // A discipline that can prove its runs does not count one until it has.
  // The entry exists, it is simply not part of the competition yet.
  if (d.module_id) {
    if (!body.trace)
      return c.json({ error: 'this discipline requires a trace', entry_id: entryId }, 400)
    let trace: Uint8Array
    try {
      trace = Uint8Array.from(atob(body.trace), (ch) => ch.charCodeAt(0))
    } catch {
      return c.json({ error: 'trace must be base64' }, 400)
    }
    if (trace.length === 0 || trace.length > 512 * 1024)
      return c.json({ error: 'trace must be between 1 byte and 512 KB' }, 413)

    await c.env.DB.prepare(`UPDATE entries SET status = 'review' WHERE id = ?`).bind(entryId).run()
    const job = await queueVerification(c.env, d, entryId, app.id, body.value, trace)
    return c.json(
      {
        entry_id: entryId,
        status: 'review',
        verification: 'pending',
        job,
        value: body.value,
        message: 'queued for replay verification',
      },
      202,
    )
  }

  // The exam is checked against the aggregate, not the single entry: for 'sum'
  // or 'streak' anything else would be meaningless.
  const exam = await syncQualification(c.env.DB, d, season.id, player.id, app.id)
  const aggregate = exam.aggregate ?? body.value
  const qualifiedNow = exam.qualifiedNow

  const qualified = exam.qualified
  // The projection is refreshed here and nowhere else: an entry is the only
  // moment a player's aggregate can change.
  await projection.refresh(c.env.DB, d, season.id, player.id, region?.region_id ?? null)

  const settled = await settleChallenges(c.env.DB, app.id, d, season.id, player.id, entryId)
  const badges = await evaluateBadges(c.env.DB, player.id, app.id)

  return c.json(
    {
      entry_id: entryId,
      status,
      value: body.value,
      aggregate,
      aggregation: d.aggregation,
      qualified,
      qualified_now: qualifiedNow,
      qualifying_score: d.qualifying_score,
      rank: qualified ? await ranks(c.env.DB, d, season.id, player.id, region?.region_id ?? null) : null,
      streak_days:
        d.aggregation === 'streak'
          ? await currentStreak(c.env.DB, d, season.id, player.id, dayOf(now()))
          : null,
      settled_challenges: settled,
      badges_earned: badges,
    },
    201,
  )
})

// -------------------------------------------------------------- Leaderboards

compete.get('/v1/leaderboards/:discipline', requireApp, async (c) => {
  const app = c.get('app')!
  const d = await discipline(c.env.DB, app.id, c.req.param('discipline'))
  if (!d) return c.json({ error: 'unknown discipline' }, 404)
  const season = await currentSeason(c.env.DB)
  if (!season) return c.json({ error: 'no open season' }, 409)

  const regionId = c.req.query('region')
  const limit = Math.min(Number(c.req.query('limit') ?? 25), 100)

  // scope=friends shows the standing among one's own rivals.
  let friendsOf: string | undefined
  if (c.req.query('scope') === 'friends') {
    const auth = c.req.header('Authorization') ?? ''
    const me = auth.startsWith('Bearer ')
      ? await c.env.DB.prepare(
          `SELECT p.id FROM players p JOIN sessions s ON s.player_id = p.id WHERE s.token_hash = ?`,
        )
          .bind(await sha256(auth.slice(7)))
          .first<{ id: string }>()
      : null
    if (!me) return c.json({ error: 'scope=friends requires a player token' }, 401)
    friendsOf = me.id
  }

  const scope = await regionScope(c.env.DB, regionId)
  if (regionId && !scope.level) return c.json({ error: 'unknown region' }, 404)

  const result = friendsOf
    ? await friendsPage(c.env.DB, d, season.id, friendsOf, limit)
    : await projection.page(c.env.DB, d, season.id, scope, { limit, cursor: c.req.query('cursor') })

  // Ranks are positions in this page, offset by where the page starts.
  const startsAt = c.req.query('cursor') ? null : 1
  return c.json({
    discipline: d.slug,
    unit: d.unit,
    aggregation: d.aggregation,
    trust_tier: d.trust_tier,
    // Honest on every board: whether these results were re-simulated at all.
    verification: d.module_id ? 'replay' : 'none',
    region: regionId ?? 'global',
    scope: friendsOf ? 'friends' : 'all',
    season: season.id,
    contenders: result.total,
    title_min_players: d.title_min_players,
    // Honestly visible: without enough contenders there is no title here.
    title_eligible: d.max_title_level >= 1 && result.total >= d.title_min_players,
    cursor: result.cursor,
    entries: result.rows.map((row, i) => ({
      ...(startsAt ? { rank: startsAt + i } : {}),
      ...row,
    })),
  })
})

/** Resolve a region id to the level its column lives in. */
async function regionScope(db: D1Database, regionId?: string) {
  if (!regionId) return {}
  const region = await db
    .prepare(`SELECT id, level FROM regions WHERE id = ?`)
    .bind(regionId)
    .first<{ id: string; level: number }>()
  return region ? { regionId: region.id, level: region.level } : {}
}

/** Regional and global rank in one answer, the way a game displays them. */
async function ranks(
  db: D1Database,
  d: Discipline,
  seasonId: string,
  playerId: string,
  regionId: string | null,
) {
  const scope = await regionScope(db, regionId ?? undefined)
  return {
    region: regionId ? await projection.rank(db, d, seasonId, playerId, scope) : null,
    global: await projection.rank(db, d, seasonId, playerId, {}),
  }
}

/**
 * A friends board is small by definition, so it stays a join rather than
 * another materialised shape to keep in step.
 */
async function friendsPage(
  db: D1Database,
  d: Discipline,
  seasonId: string,
  playerId: string,
  limit: number,
): Promise<projection.Page> {
  const direction = d.aggregation === 'best' && d.score_direction === 'asc' ? 'ASC' : 'DESC'
  const rows = await db
    .prepare(
      `SELECT s.player_id, p.handle, s.value, s.since
         FROM standings s JOIN players p ON p.id = s.player_id
        WHERE s.discipline_id = ? AND s.season_id = ? AND s.eligible = 1
          AND (s.player_id = ? OR s.player_id IN
               (SELECT followee_id FROM follows WHERE follower_id = ?))
        ORDER BY s.value ${direction}, s.since ASC LIMIT ?`,
    )
    .bind(d.id, seasonId, playerId, playerId, limit)
    .all<projection.Row>()
  return { rows: rows.results, cursor: null, total: rows.results.length }
}

/**
 * The rows immediately around you. This is what a game actually shows, and it
 * must not need the whole board to answer.
 */
compete.get('/v1/leaderboards/:discipline/around', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const d = await discipline(c.env.DB, app.id, c.req.param('discipline'))
  if (!d) return c.json({ error: 'unknown discipline' }, 404)
  const season = await currentSeason(c.env.DB)
  if (!season) return c.json({ error: 'no open season' }, 409)

  const scope = await regionScope(c.env.DB, c.req.query('region'))
  const span = Math.min(Number(c.req.query('span') ?? 2), 10)
  const around = await projection.neighbourhood(c.env.DB, d, season.id, player.id, scope, span)
  if (!around) return c.json({ error: 'you are not on this board yet' }, 404)
  return c.json({ discipline: d.slug, region: c.req.query('region') ?? 'global', ...around })
})

/** Own standing: value, rank, streak, exam — what an app wants to display. */
compete.get('/v1/disciplines/:discipline/me', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const d = await discipline(c.env.DB, app.id, c.req.param('discipline'))
  if (!d) return c.json({ error: 'unknown discipline' }, 404)
  const season = await currentSeason(c.env.DB)
  if (!season) return c.json({ error: 'no open season' }, 409)

  const region = await c.env.DB.prepare(
    `SELECT region_id FROM player_regions WHERE player_id = ? AND season_id = ?`,
  )
    .bind(player.id, season.id)
    .first<{ region_id: string }>()
  const qualification = await c.env.DB.prepare(
    `SELECT value_at, achieved_at FROM qualifications
      WHERE player_id = ? AND discipline_id = ? AND season_id = ?`,
  )
    .bind(player.id, d.id, season.id)
    .first()

  const value = await valueFor(c.env.DB, d, season.id, player.id)
  return c.json({
    discipline: d.slug,
    aggregation: d.aggregation,
    unit: d.unit,
    value,
    qualifying_score: d.qualifying_score,
    qualified: Boolean(qualification) || d.qualifying_score === null,
    qualification,
    streak_days: await currentStreak(c.env.DB, d, season.id, player.id, dayOf(now())),
    rank: await ranks(c.env.DB, d, season.id, player.id, region?.region_id ?? null),
  })
})

/**
 * Daily challenge: the same seed for every player worldwide, derived from
 * discipline and date. Needs no storage and makes single-player runs
 * comparable without anyone having to be online at the same time.
 */
compete.get('/v1/daily/:discipline', requireApp, async (c) => {
  const app = c.get('app')!
  const d = await discipline(c.env.DB, app.id, c.req.param('discipline'))
  if (!d) return c.json({ error: 'unknown discipline' }, 404)
  const date = c.req.query('date') ?? dayOf(now())
  const digest = await sha256(`${d.id}:${date}`)
  return c.json({
    discipline: d.slug,
    date,
    seed: parseInt(digest.slice(0, 8), 16),
    seed_hex: digest.slice(0, 16),
  })
})

// ---------------------------------------------------------------- Challenges

compete.post('/v1/challenges', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const body = await c.req.json<{
    discipline: string
    opponent_handle?: string
    expires_in_hours?: number
  }>()
  if (!mayContribute(player))
    return c.json({ error: `account is ${player.status}`, until: player.status_until }, 403)

  const d = await discipline(c.env.DB, app.id, body.discipline)
  if (!d) return c.json({ error: 'unknown discipline' }, 404)
  const season = await currentSeason(c.env.DB)
  if (!season) return c.json({ error: 'no open season' }, 409)

  // Only someone with a standing of their own can challenge.
  const target = await valueFor(c.env.DB, d, season.id, player.id)
  if (target === null) return c.json({ error: 'submit an entry of your own first' }, 409)

  let opponentId: string | null = null
  if (body.opponent_handle) {
    const opponent = await c.env.DB.prepare(`SELECT id FROM players WHERE handle = ?`)
      .bind(body.opponent_handle)
      .first<{ id: string }>()
    if (!opponent) return c.json({ error: 'unknown opponent' }, 404)
    if (opponent.id === player.id) return c.json({ error: 'not against yourself' }, 400)
    // A block between two people prevents every kind of contact.
    const barrier = await c.env.DB.prepare(
      `SELECT 1 AS hit FROM blocks
        WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
    )
      .bind(player.id, opponent.id, opponent.id, player.id)
      .first()
    if (barrier) return c.json({ error: 'not possible' }, 403)
    opponentId = opponent.id
  }

  const qualified = await c.env.DB.prepare(
    `SELECT 1 AS q FROM qualifications WHERE player_id = ? AND discipline_id = ? AND season_id = ?`,
  )
    .bind(player.id, d.id, season.id)
    .first()

  const challengeId = id('chl')
  const expires = new Date(Date.now() + (body.expires_in_hours ?? 72) * 3600_000).toISOString()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO challenges
         (id, discipline_id, season_id, ranked, challenger_id, opponent_id, target_value,
          state, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      challengeId,
      d.id,
      season.id,
      qualified ? 1 : 0,
      player.id,
      opponentId,
      target,
      opponentId ? 'open' : 'accepted', // ohne Gegner: offene Einladung an alle
      expires,
      now(),
    ),
    c.env.DB.prepare(
      `INSERT INTO challenge_entries (challenge_id, player_id, value, entered_at) VALUES (?, ?, ?, ?)`,
    ).bind(challengeId, player.id, target, now()),
  ])
  await record(c.env.DB, app.id, opponentId, 'challenge.created', {
    challenge_id: challengeId,
    discipline: d.slug,
    from: player.handle,
    target,
  })

  return c.json(
    {
      id: challengeId,
      discipline: d.slug,
      target_value: target,
      ranked: Boolean(qualified),
      opponent: body.opponent_handle ?? null,
      expires_at: expires,
    },
    201,
  )
})

compete.post('/v1/challenges/:id/accept', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const challengeId = c.req.param('id')
  const ch = await c.env.DB.prepare(`SELECT * FROM challenges WHERE id = ?`)
    .bind(challengeId)
    .first<{
      state: string
      challenger_id: string
      opponent_id: string | null
      expires_at: string
    }>()
  if (!ch) return c.json({ error: 'unknown challenge' }, 404)
  if (ch.challenger_id === player.id) return c.json({ error: 'not against yourself' }, 400)
  if (new Date(ch.expires_at) < new Date()) return c.json({ error: 'expired' }, 409)
  if (ch.opponent_id && ch.opponent_id !== player.id)
    return c.json({ error: 'not addressed to you' }, 403)
  if (ch.state === 'settled') return c.json({ error: 'already resolved' }, 409)

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE challenges SET state = 'accepted', opponent_id = ? WHERE id = ?`).bind(
      player.id,
      challengeId,
    ),
    c.env.DB.prepare(
      `INSERT INTO challenge_entries (challenge_id, player_id, entered_at) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(challengeId, player.id, now()),
  ])
  return c.json({ id: challengeId, state: 'accepted' })
})

compete.get('/v1/challenges', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  // Expired challenges go to the challenger.
  await c.env.DB.prepare(
    `UPDATE challenges SET state = 'expired', winner_id = challenger_id, settled_at = ?
      WHERE state IN ('open','accepted') AND expires_at < ?`,
  )
    .bind(now(), now())
    .run()
  const rows = await c.env.DB.prepare(
    `SELECT c.id, d.slug AS discipline, c.target_value, c.state, c.ranked, c.expires_at,
            ch.handle AS challenger, op.handle AS opponent, w.handle AS winner
       FROM challenges c
       JOIN disciplines d ON d.id = c.discipline_id
       JOIN players ch ON ch.id = c.challenger_id
       LEFT JOIN players op ON op.id = c.opponent_id
       LEFT JOIN players w ON w.id = c.winner_id
      WHERE c.challenger_id = ? OR c.opponent_id = ? OR c.opponent_id IS NULL
      ORDER BY c.created_at DESC LIMIT 50`,
  )
    .bind(player.id, player.id)
    .all()
  return c.json({ challenges: rows.results })
})

/**
 * A challenge is decided only by performance AFTER acceptance. Otherwise it is
 * won by whoever was already better — which would make accepting pointless.
 */
async function settleChallenges(
  db: D1Database,
  appId: string,
  d: Discipline,
  seasonId: string,
  playerId: string,
  entryId: string,
): Promise<string[]> {
  const open = await db
    .prepare(
      `SELECT c.id, c.target_value, c.challenger_id, ce.entered_at
         FROM challenges c
         JOIN challenge_entries ce ON ce.challenge_id = c.id AND ce.player_id = c.opponent_id
        WHERE c.discipline_id = ? AND c.season_id = ? AND c.state = 'accepted'
          AND c.opponent_id = ? AND c.expires_at > ?`,
    )
    .bind(d.id, seasonId, playerId, now())
    .all<{ id: string; target_value: number; challenger_id: string; entered_at: string }>()

  const settled: string[] = []
  for (const ch of open.results) {
    const sinceAccept = await valueFor(db, d, seasonId, playerId, ch.entered_at)
    if (sinceAccept === null || !beats(d, sinceAccept, ch.target_value)) continue
    await db.batch([
      db
        .prepare(`UPDATE challenges SET state = 'settled', winner_id = ?, settled_at = ? WHERE id = ?`)
        .bind(playerId, now(), ch.id),
      db
        .prepare(
          `UPDATE challenge_entries SET value = ?, entry_id = ? WHERE challenge_id = ? AND player_id = ?`,
        )
        .bind(sinceAccept, entryId, ch.id, playerId),
    ])
    await record(db, appId, ch.challenger_id, 'challenge.settled', {
      challenge_id: ch.id,
      winner: playerId,
    })
    settled.push(ch.id)
  }
  return settled
}

// ---------------------------------------------------- Head-to-head duels (T2)

compete.post('/v1/matches', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const body = await c.req.json<{
    discipline: string
    placements: { handle: string; placement: number; value?: number }[]
    idem_key?: string
    meta?: unknown
  }>()
  const d = await discipline(c.env.DB, app.id, body.discipline)
  if (!d) return c.json({ error: 'unknown discipline' }, 404)
  if (!d.head_to_head) return c.json({ error: 'discipline is not head-to-head' }, 400)
  if (!Array.isArray(body.placements) || body.placements.length < 2)
    return c.json({ error: 'at least two placements required' }, 400)

  const season = await currentSeason(c.env.DB)
  if (!season) return c.json({ error: 'no open season' }, 409)

  if (body.idem_key) {
    const seen = await c.env.DB.prepare(`SELECT id FROM matches WHERE idem_key = ?`)
      .bind(body.idem_key)
      .first<{ id: string }>()
    if (seen) return c.json({ match_id: seen.id, duplicate: true }, 200)
  }

  const resolved: { player_id: string; placement: number; value?: number }[] = []
  for (const p of body.placements) {
    const row = await c.env.DB.prepare(`SELECT id FROM players WHERE handle = ?`)
      .bind(p.handle)
      .first<{ id: string }>()
    if (!row) return c.json({ error: `unknown player: ${p.handle}` }, 404)
    resolved.push({ player_id: row.id, placement: p.placement, value: p.value })
  }

  const matchId = id('mtc')
  const insertMatch = c.env.DB.prepare(
    `INSERT INTO matches (id, discipline_id, season_id, trust_tier, status, meta, idem_key, created_at)
     VALUES (?, ?, ?, ?, 'counted', ?, ?, ?)`,
  )
    .bind(
      matchId,
      d.id,
      season.id,
      d.trust_tier,
      body.meta ? JSON.stringify(body.meta) : null,
      body.idem_key ?? null,
      now(),
    )
  try {
    await insertMatch.run()
  } catch (error) {
    const raced =
      body.idem_key &&
      (await c.env.DB.prepare(`SELECT id FROM matches WHERE idem_key = ?`)
        .bind(body.idem_key)
        .first<{ id: string }>())
    if (!raced) throw error
    return c.json({ match_id: raced.id, duplicate: true }, 200)
  }
  await c.env.DB.batch(
    resolved.map((p) =>
      c.env.DB.prepare(
        `INSERT INTO match_placements (match_id, player_id, placement, value) VALUES (?, ?, ?, ?)`,
      ).bind(matchId, p.player_id, p.placement, p.value ?? null),
    ),
  )

  // Read every rating from BEFORE the match so processing order cannot change
  // the outcome.
  const before = new Map<string, { rating: number; rd: number; volatility: number }>()
  for (const p of resolved) {
    const row = await c.env.DB.prepare(
      `SELECT rating, rd, volatility FROM ratings
        WHERE player_id = ? AND discipline_id = ? AND season_id = ?`,
    )
      .bind(p.player_id, d.id, season.id)
      .first<{ rating: number; rd: number; volatility: number }>()
    before.set(p.player_id, row ?? { rating: 1500, rd: 350, volatility: 0.06 })
  }

  const pairs = pairwiseScores(resolved)
  const after: Record<string, { rating: number; rd: number }> = {}
  for (const p of resolved) {
    const opponents = (pairs.get(p.player_id) ?? []).map((o) => ({
      rating: before.get(o.opponentId)!.rating,
      rd: before.get(o.opponentId)!.rd,
      score: o.score,
    }))
    const next = updateRating(before.get(p.player_id)!, opponents)
    await c.env.DB.prepare(
      `INSERT INTO ratings (player_id, discipline_id, season_id, rating, rd, volatility, matches, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (player_id, discipline_id, season_id) DO UPDATE SET
         rating = excluded.rating, rd = excluded.rd, volatility = excluded.volatility,
         matches = ratings.matches + 1, updated_at = excluded.updated_at`,
    )
      .bind(p.player_id, d.id, season.id, next.rating, next.rd, next.volatility, now())
      .run()
    after[p.player_id] = { rating: Math.round(next.rating), rd: Math.round(next.rd) }
    await evaluateBadges(c.env.DB, p.player_id, app.id)
  }
  await record(c.env.DB, app.id, null, 'match.recorded', { match_id: matchId, discipline: d.slug })

  return c.json({ match_id: matchId, ratings: after }, 201)
})

compete.get('/v1/ratings/:discipline', requireApp, async (c) => {
  const app = c.get('app')!
  const d = await discipline(c.env.DB, app.id, c.req.param('discipline'))
  if (!d) return c.json({ error: 'unknown discipline' }, 404)
  const season = await currentSeason(c.env.DB)
  const rows = await c.env.DB.prepare(
    `SELECT p.handle, ROUND(r.rating) AS rating, ROUND(r.rd) AS rd, r.matches
       FROM ratings r JOIN players p ON p.id = r.player_id
      WHERE r.discipline_id = ? AND r.season_id = ? AND r.matches > 0
      ORDER BY r.rating DESC LIMIT 50`,
  )
    .bind(d.id, season?.id ?? '')
    .all()
  return c.json({ discipline: d.slug, ratings: rows.results })
})

// -------------------------------------------------------------------- Events

compete.get('/v1/events', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const since = Number(c.req.query('since') ?? 0)
  const rows = await c.env.DB.prepare(
    `SELECT id, type, payload, created_at FROM events
      WHERE player_id = ? AND id > ? ORDER BY id LIMIT 100`,
  )
    .bind(player.id, since)
    .all<{ id: number; type: string; payload: string; created_at: string }>()
  return c.json({
    events: rows.results.map((e) => ({ ...e, payload: JSON.parse(e.payload) })),
    cursor: rows.results.length ? rows.results[rows.results.length - 1].id : since,
  })
})
