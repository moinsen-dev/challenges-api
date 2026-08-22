import { Hono } from 'hono'
import {
  HonoApp,
  currentSeason,
  discipline,
  id,
  now,
  record,
  requireApp,
  requireAppSecret,
  requirePlayer,
} from '../lib'
import { advancesTo, firstRound, roundCount } from '../bracket'
import * as projection from '../projection'
import { deliver } from '../webhooks'

export const tournaments = new Hono<HonoApp>()

tournaments.post('/v1/tournaments', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const body = await c.req.json<{
    slug: string
    name?: string
    discipline: string
    region?: string
    max_entrants?: number
    starts_at?: string
  }>()

  const d = await discipline(c.env.DB, app.id, body.discipline)
  if (!d) return c.json({ error: 'unknown discipline' }, 404)
  const season = await currentSeason(c.env.DB)
  if (!season) return c.json({ error: 'no open season' }, 409)
  if (!/^[a-z0-9][a-z0-9-]{2,48}$/.test(body.slug ?? ''))
    return c.json({ error: 'slug must be 3-49 characters of a-z, 0-9 and dashes' }, 400)

  const tournamentId = id('trn')
  try {
    await c.env.DB.prepare(
      `INSERT INTO tournaments
         (id, app_id, discipline_id, season_id, slug, name, region_id, max_entrants, starts_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        tournamentId,
        app.id,
        d.id,
        season.id,
        body.slug,
        body.name ?? body.slug,
        body.region ?? null,
        Math.min(body.max_entrants ?? 32, 256),
        body.starts_at ?? null,
        now(),
      )
      .run()
  } catch {
    return c.json({ error: 'slug taken' }, 409)
  }
  return c.json({ id: tournamentId, slug: body.slug, state: 'open' }, 201)
})

async function load(db: D1Database, appId: string, slug: string) {
  return db
    .prepare(`SELECT * FROM tournaments WHERE app_id = ? AND slug = ?`)
    .bind(appId, slug)
    .first<{
      id: string
      discipline_id: string
      season_id: string
      slug: string
      name: string
      state: string
      region_id: string | null
      max_entrants: number
      champion_id: string | null
    }>()
}

tournaments.post('/v1/tournaments/:slug/join', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const tournament = await load(c.env.DB, app.id, c.req.param('slug'))
  if (!tournament) return c.json({ error: 'unknown tournament' }, 404)
  if (tournament.state !== 'open') return c.json({ error: `tournament is ${tournament.state}` }, 409)

  const d = await c.env.DB.prepare(`SELECT * FROM disciplines WHERE id = ?`)
    .bind(tournament.discipline_id)
    .first<{ id: string; qualifying_score: number | null }>()
  // A tournament is the sharp end of a discipline; the exam still applies.
  if (d?.qualifying_score !== null) {
    const qualified = await c.env.DB.prepare(
      `SELECT 1 AS q FROM qualifications WHERE player_id = ? AND discipline_id = ? AND season_id = ?`,
    )
      .bind(player.id, tournament.discipline_id, tournament.season_id)
      .first()
    if (!qualified) return c.json({ error: 'you have not qualified in this discipline' }, 403)
  }

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM tournament_entrants WHERE tournament_id = ?`,
  )
    .bind(tournament.id)
    .first<{ n: number }>()
  if ((count?.n ?? 0) >= tournament.max_entrants) return c.json({ error: 'tournament is full' }, 409)

  await c.env.DB.prepare(
    `INSERT INTO tournament_entrants (tournament_id, player_id, joined_at) VALUES (?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(tournament.id, player.id, now())
    .run()
  return c.json({ tournament: tournament.slug, entrants: (count?.n ?? 0) + 1 }, 201)
})

tournaments.post('/v1/tournaments/:slug/start', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const tournament = await load(c.env.DB, app.id, c.req.param('slug'))
  if (!tournament) return c.json({ error: 'unknown tournament' }, 404)
  if (tournament.state !== 'open') return c.json({ error: `tournament is ${tournament.state}` }, 409)

  const d = await c.env.DB.prepare(`SELECT * FROM disciplines WHERE id = ?`)
    .bind(tournament.discipline_id)
    .first<any>()
  const scope = tournament.region_id
    ? {
        regionId: tournament.region_id,
        level: (
          await c.env.DB.prepare(`SELECT level FROM regions WHERE id = ?`)
            .bind(tournament.region_id)
            .first<{ level: number }>()
        )?.level,
      }
    : {}

  // Seeded from the standings, so the bracket reflects the season rather than
  // the order people happened to sign up in.
  const entrants = await c.env.DB.prepare(
    `SELECT e.player_id FROM tournament_entrants e WHERE e.tournament_id = ? AND e.state = 'in'`,
  )
    .bind(tournament.id)
    .all<{ player_id: string }>()
  if (entrants.results.length < 2) return c.json({ error: 'a bracket needs at least two entrants' }, 409)

  const ranked: { player_id: string; value: number }[] = []
  for (const entrant of entrants.results) {
    const standing = await projection.rank(c.env.DB, d, tournament.season_id, entrant.player_id, scope)
    ranked.push({ player_id: entrant.player_id, value: standing?.value ?? Number.NEGATIVE_INFINITY })
  }
  ranked.sort((a, b) => b.value - a.value)

  const bySeed = new Map<number, string>()
  const writes: D1PreparedStatement[] = []
  ranked.forEach((entrant, index) => {
    bySeed.set(index + 1, entrant.player_id)
    writes.push(
      c.env.DB.prepare(`UPDATE tournament_entrants SET seed = ? WHERE tournament_id = ? AND player_id = ?`).bind(
        index + 1,
        tournament.id,
        entrant.player_id,
      ),
    )
  })

  const count = ranked.length
  const rounds = roundCount(count)
  for (const pair of firstRound(count)) {
    const a = pair.a ? bySeed.get(pair.a)! : null
    const b = pair.b ? bySeed.get(pair.b)! : null
    // An empty chair is a bye: the seed opposite it advances without playing.
    const bye = (a && !b) || (b && !a)
    writes.push(
      c.env.DB.prepare(
        `INSERT INTO tournament_matches (id, tournament_id, round, slot, player_a, player_b, winner_id, state, reported_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id('tm'),
        tournament.id,
        pair.slot,
        a,
        b,
        bye ? (a ?? b) : null,
        bye ? 'bye' : a && b ? 'ready' : 'pending',
        bye ? now() : null,
      ),
    )
  }
  for (let round = 2; round <= rounds; round++) {
    const slots = 2 ** (rounds - round)
    for (let slot = 1; slot <= slots; slot++) {
      writes.push(
        c.env.DB.prepare(
          `INSERT INTO tournament_matches (id, tournament_id, round, slot, state) VALUES (?, ?, ?, ?, 'pending')`,
        ).bind(id('tm'), tournament.id, round, slot),
      )
    }
  }
  writes.push(
    c.env.DB.prepare(`UPDATE tournaments SET state = 'running', started_at = ? WHERE id = ?`).bind(
      now(),
      tournament.id,
    ),
  )
  await c.env.DB.batch(writes)

  // Byes are decided the moment the bracket exists, so push them onward now.
  for (const bye of (
    await c.env.DB.prepare(
      `SELECT id, round, slot, winner_id FROM tournament_matches WHERE tournament_id = ? AND state = 'bye'`,
    )
      .bind(tournament.id)
      .all<{ id: string; round: number; slot: number; winner_id: string }>()
  ).results) {
    await advance(c.env.DB, tournament.id, bye.round, bye.slot, bye.winner_id, count)
  }

  for (const entrant of ranked)
    await record(c.env.DB, app.id, entrant.player_id, 'tournament.started', {
      tournament: tournament.slug,
    })
  return c.json({ tournament: tournament.slug, state: 'running', entrants: count, rounds })
})

/** Move a winner into the slot that was waiting for them. */
async function advance(
  db: D1Database,
  tournamentId: string,
  round: number,
  slot: number,
  winnerId: string,
  entrants: number,
) {
  const next = advancesTo(round, slot, entrants)
  if (!next) return null

  await db
    .prepare(
      `UPDATE tournament_matches SET player_${next.side} = ? WHERE tournament_id = ? AND round = ? AND slot = ?`,
    )
    .bind(winnerId, tournamentId, next.round, next.slot)
    .run()

  // Once both chairs are filled the match can be played.
  await db
    .prepare(
      `UPDATE tournament_matches SET state = 'ready'
        WHERE tournament_id = ? AND round = ? AND slot = ?
          AND player_a IS NOT NULL AND player_b IS NOT NULL AND state = 'pending'`,
    )
    .bind(tournamentId, next.round, next.slot)
    .run()
  return next
}

tournaments.post('/v1/tournaments/:slug/matches/:id/result', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const body = await c.req.json<{ winner: string; detail?: string }>()
  const tournament = await load(c.env.DB, app.id, c.req.param('slug'))
  if (!tournament) return c.json({ error: 'unknown tournament' }, 404)
  if (tournament.state !== 'running') return c.json({ error: `tournament is ${tournament.state}` }, 409)

  const match = await c.env.DB.prepare(
    `SELECT * FROM tournament_matches WHERE id = ? AND tournament_id = ?`,
  )
    .bind(c.req.param('id'), tournament.id)
    .first<{
      id: string
      round: number
      slot: number
      player_a: string | null
      player_b: string | null
      state: string
    }>()
  if (!match) return c.json({ error: 'unknown match' }, 404)
  if (match.state === 'done' || match.state === 'bye')
    return c.json({ error: 'match is already decided' }, 409)
  if (match.state !== 'ready') return c.json({ error: 'match is still waiting for both players' }, 409)

  const winner = await c.env.DB.prepare(`SELECT id FROM players WHERE handle = ? OR id = ?`)
    .bind(body.winner ?? '', body.winner ?? '')
    .first<{ id: string }>()
  // A winner who is not in the match is not a winner.
  if (!winner || ![match.player_a, match.player_b].includes(winner.id))
    return c.json({ error: 'winner must be one of the two players in this match' }, 400)

  const entrants = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM tournament_entrants WHERE tournament_id = ? AND seed IS NOT NULL`,
  )
    .bind(tournament.id)
    .first<{ n: number }>()

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE tournament_matches SET winner_id = ?, state = 'done', reported_at = ?, detail = ? WHERE id = ?`,
    ).bind(winner.id, now(), body.detail ?? null, match.id),
    c.env.DB.prepare(
      `UPDATE tournament_entrants SET state = 'out' WHERE tournament_id = ? AND player_id = ?`,
    ).bind(tournament.id, winner.id === match.player_a ? match.player_b : match.player_a),
  ])

  const next = await advance(c.env.DB, tournament.id, match.round, match.slot, winner.id, entrants?.n ?? 2)
  if (next) return c.json({ match: match.id, winner: winner.id, advances_to: next })

  // No next slot means that was the final.
  await c.env.DB.prepare(
    `UPDATE tournaments SET state = 'finished', finished_at = ?, champion_id = ? WHERE id = ?`,
  )
    .bind(now(), winner.id, tournament.id)
    .run()
  await record(c.env.DB, app.id, winner.id, 'tournament.won', { tournament: tournament.slug })
  await deliver(c.env, app.id, 'tournament.finished', {
    tournament: tournament.slug,
    champion: winner.id,
  })
  return c.json({ match: match.id, winner: winner.id, tournament: 'finished' })
})

tournaments.get('/v1/tournaments', requireApp, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.slug, t.name, t.state, t.region_id, t.starts_at, d.slug AS discipline,
            p.handle AS champion,
            (SELECT COUNT(*) FROM tournament_entrants e WHERE e.tournament_id = t.id) AS entrants
       FROM tournaments t JOIN disciplines d ON d.id = t.discipline_id
       LEFT JOIN players p ON p.id = t.champion_id
      WHERE t.app_id = ? ORDER BY t.created_at DESC LIMIT 50`,
  )
    .bind(c.get('app')!.id)
    .all()
  return c.json({ tournaments: rows.results })
})

tournaments.get('/v1/tournaments/:slug', requireApp, async (c) => {
  const app = c.get('app')!
  const tournament = await load(c.env.DB, app.id, c.req.param('slug'))
  if (!tournament) return c.json({ error: 'unknown tournament' }, 404)

  const [matches, entrants] = await Promise.all([
    c.env.DB.prepare(
      `SELECT m.id, m.round, m.slot, m.state, a.handle AS player_a, b.handle AS player_b,
              w.handle AS winner
         FROM tournament_matches m
         LEFT JOIN players a ON a.id = m.player_a
         LEFT JOIN players b ON b.id = m.player_b
         LEFT JOIN players w ON w.id = m.winner_id
        WHERE m.tournament_id = ? ORDER BY m.round, m.slot`,
    )
      .bind(tournament.id)
      .all(),
    c.env.DB.prepare(
      `SELECT p.handle, e.seed, e.state FROM tournament_entrants e JOIN players p ON p.id = e.player_id
        WHERE e.tournament_id = ? ORDER BY e.seed`,
    )
      .bind(tournament.id)
      .all(),
  ])

  const champion = tournament.champion_id
    ? await c.env.DB.prepare(`SELECT handle FROM players WHERE id = ?`)
        .bind(tournament.champion_id)
        .first<{ handle: string }>()
    : null

  return c.json({
    slug: tournament.slug,
    name: tournament.name,
    state: tournament.state,
    region: tournament.region_id,
    champion: champion?.handle ?? null,
    entrants: entrants.results,
    bracket: matches.results,
  })
})
