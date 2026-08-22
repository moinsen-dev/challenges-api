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
  secret,
} from '../lib'
import { issueTicket, readTicket } from '../signing'
import { deliver } from '../webhooks'

export const live = new Hono<HonoApp>()

const PRESENCE_WINDOW_SECONDS = 90
const TICKET_MINUTES = 5
const QUEUE_MINUTES = 5

async function signingSecret(db: D1Database, appId: string): Promise<string> {
  const row = await db.prepare(`SELECT signing_secret FROM apps WHERE id = ?`).bind(appId).first<{
    signing_secret: string | null
  }>()
  if (row?.signing_secret) return row.signing_secret
  const fresh = secret()
  await db.prepare(`UPDATE apps SET signing_secret = ? WHERE id = ?`).bind(fresh, appId).run()
  return fresh
}

// ------------------------------------------------------------------ stream

/**
 * The event stream as Server-Sent Events.
 *
 * Honest about its shape: without a Durable Object there is nobody to push to
 * this connection, so the stream polls the ledger on the server side. What the
 * client gains is real: one connection instead of a timer, delivery within a
 * second or two, and resumption from `Last-Event-ID` after any drop.
 *
 * The connection closes itself after a while and says so. A stream that lives
 * forever is a stream that leaks.
 */
live.get('/v1/events/stream', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const resumeFrom = Number(c.req.header('Last-Event-ID') ?? c.req.query('since') ?? 0)
  const maxSeconds = Math.min(Number(c.req.query('max_seconds') ?? 300), 900)
  const intervalMs = Math.max(Number(c.req.query('interval_ms') ?? 2000), 250)

  const encoder = new TextEncoder()
  let cursor = resumeFrom
  const started = Date.now()

  const stream = new ReadableStream({
    async pull(controller) {
      if (Date.now() - started > maxSeconds * 1000) {
        controller.enqueue(encoder.encode(`event: bye\ndata: {"reason":"time","cursor":${cursor}}\n\n`))
        controller.close()
        return
      }

      const rows = await c.env.DB.prepare(
        `SELECT id, type, payload, created_at FROM events
          WHERE player_id = ? AND id > ? ORDER BY id LIMIT 50`,
      )
        .bind(player.id, cursor)
        .all<{ id: number; type: string; payload: string; created_at: string }>()

      for (const event of rows.results) {
        cursor = event.id
        controller.enqueue(
          encoder.encode(
            `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
              id: event.id,
              type: event.type,
              payload: JSON.parse(event.payload),
              created_at: event.created_at,
            })}\n\n`,
          ),
        )
      }

      // A comment line keeps proxies from closing a quiet connection.
      if (rows.results.length === 0) controller.enqueue(encoder.encode(`: keep-alive ${cursor}\n\n`))
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

// ---------------------------------------------------------------- presence

live.post('/v1/me/presence', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const body = await c.req
    .json<{ status?: string; detail?: string }>()
    .catch(() => ({}) as { status?: string })
  const status = ['online', 'playing', 'away'].includes(body.status ?? '') ? body.status! : 'online'

  await c.env.DB.prepare(
    `INSERT INTO presence (player_id, app_id, status, detail, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (player_id, app_id) DO UPDATE SET
       status = excluded.status, detail = excluded.detail, last_seen = excluded.last_seen`,
  )
    .bind(player.id, app.id, status, (body.detail ?? '').slice(0, 80) || null, now())
    .run()
  return c.json({ status, expires_in_seconds: PRESENCE_WINDOW_SECONDS })
})

live.get('/v1/presence', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const since = new Date(Date.now() - PRESENCE_WINDOW_SECONDS * 1000).toISOString()

  const [rivals, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT p.handle, pr.status, pr.detail, pr.last_seen FROM presence pr
         JOIN players p ON p.id = pr.player_id
        WHERE pr.app_id = ? AND pr.last_seen > ?
          AND pr.player_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)
        ORDER BY pr.last_seen DESC LIMIT 100`,
    )
      .bind(app.id, since, player.id)
      .all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM presence WHERE app_id = ? AND last_seen > ?`)
      .bind(app.id, since)
      .first<{ n: number }>(),
  ])
  // Only rivals by name; everyone else is a number. A presence list of
  // strangers is a list of people to bother.
  return c.json({ online: total?.n ?? 0, rivals: rivals.results })
})

// ------------------------------------------------------------------- queue

live.post('/v1/queue', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const body = await c.req.json<{ discipline: string; party_id?: string }>()

  const d = await discipline(c.env.DB, app.id, body.discipline)
  if (!d) return c.json({ error: 'unknown discipline' }, 404)
  if (!d.head_to_head) return c.json({ error: 'discipline is not head-to-head' }, 400)
  const season = await currentSeason(c.env.DB)
  if (!season) return c.json({ error: 'no open season' }, 409)

  const waiting = await c.env.DB.prepare(
    `SELECT id FROM queue_tickets WHERE player_id = ? AND state = 'waiting' AND expires_at > ?`,
  )
    .bind(player.id, now())
    .first<{ id: string }>()
  if (waiting) return c.json({ error: 'already queued', ticket: waiting.id }, 409)

  const [region, rating] = await Promise.all([
    c.env.DB.prepare(`SELECT region_id FROM player_regions WHERE player_id = ? AND season_id = ?`)
      .bind(player.id, season.id)
      .first<{ region_id: string }>(),
    c.env.DB.prepare(
      `SELECT rating FROM ratings WHERE player_id = ? AND discipline_id = ? AND season_id = ?`,
    )
      .bind(player.id, d.id, season.id)
      .first<{ rating: number }>(),
  ])

  const ticketId = id('qt')
  await c.env.DB.prepare(
    `INSERT INTO queue_tickets
       (id, app_id, discipline_id, season_id, player_id, party_id, region_id, rating, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ticketId,
      app.id,
      d.id,
      season.id,
      player.id,
      body.party_id ?? null,
      region?.region_id ?? null,
      rating?.rating ?? 1500,
      now(),
      new Date(Date.now() + QUEUE_MINUTES * 60_000).toISOString(),
    )
    .run()

  const paired = await tryPair(c.env, app.id, d, season.id, ticketId)
  return c.json({ ticket: ticketId, state: paired ? 'matched' : 'waiting', pairing: paired }, 201)
})

/**
 * Pair a fresh ticket with the closest waiting opponent.
 *
 * The claim is one conditional UPDATE, and D1 serialises writers, so two
 * simultaneous attempts cannot both succeed. When a claim catches only one of
 * the two tickets it undoes itself rather than leaving somebody matched with
 * nobody — that is the compensating step the schema comment mentions.
 */
async function tryPair(
  env: HonoApp['Bindings'],
  appId: string,
  d: { id: string; slug: string },
  seasonId: string,
  ticketId: string,
): Promise<string | null> {
  const mine = await env.DB.prepare(`SELECT * FROM queue_tickets WHERE id = ?`)
    .bind(ticketId)
    .first<{ id: string; player_id: string; rating: number; region_id: string | null; party_id: string | null }>()
  if (!mine) return null

  const opponent = await env.DB.prepare(
    `SELECT id, player_id, region_id FROM queue_tickets
      WHERE discipline_id = ? AND state = 'waiting' AND expires_at > ?
        AND player_id != ? AND (party_id IS NULL OR party_id != ?)
      ORDER BY ABS(rating - ?) ASC, created_at ASC LIMIT 1`,
  )
    .bind(d.id, now(), mine.player_id, mine.party_id ?? '', mine.rating)
    .first<{ id: string; player_id: string; region_id: string | null }>()
  if (!opponent) return null

  const pairingId = id('pr')
  const claimed = await env.DB.prepare(
    `UPDATE queue_tickets SET state = 'matched', pairing_id = ?, matched_at = ?
      WHERE id IN (?, ?) AND state = 'waiting' AND expires_at > ?`,
  )
    .bind(pairingId, now(), mine.id, opponent.id, now())
    .run()

  if (claimed.meta.changes !== 2) {
    // Somebody else took one of them in between. Put back whatever we caught.
    await env.DB.prepare(
      `UPDATE queue_tickets SET state = 'waiting', pairing_id = NULL, matched_at = NULL
        WHERE pairing_id = ?`,
    )
      .bind(pairingId)
      .run()
    return null
  }

  await env.DB.prepare(
    `INSERT INTO pairings (id, app_id, discipline_id, season_id, region_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      pairingId,
      appId,
      d.id,
      seasonId,
      mine.region_id === opponent.region_id ? mine.region_id : null,
      now(),
      new Date(Date.now() + TICKET_MINUTES * 60_000).toISOString(),
    )
    .run()

  for (const playerId of [mine.player_id, opponent.player_id]) {
    await record(env.DB, appId, playerId, 'match.found', { pairing: pairingId, discipline: d.slug })
  }
  await deliver(env, appId, 'match.found', {
    pairing: pairingId,
    discipline: d.slug,
    players: [mine.player_id, opponent.player_id],
  })
  return pairingId
}

live.get('/v1/queue/:ticket', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const ticket = await c.env.DB.prepare(
    `SELECT t.*, d.slug AS discipline FROM queue_tickets t
       JOIN disciplines d ON d.id = t.discipline_id
      WHERE t.id = ? AND t.player_id = ?`,
  )
    .bind(c.req.param('ticket'), player.id)
    .first<{
      id: string
      state: string
      pairing_id: string | null
      discipline: string
      expires_at: string
      created_at: string
    }>()
  if (!ticket) return c.json({ error: 'unknown ticket' }, 404)

  // A ticket nobody claimed simply runs out; saying so beats waiting forever.
  if (ticket.state === 'waiting' && Date.parse(ticket.expires_at) < Date.now()) {
    await c.env.DB.prepare(`UPDATE queue_tickets SET state = 'expired' WHERE id = ?`)
      .bind(ticket.id)
      .run()
    return c.json({ ticket: ticket.id, state: 'expired' })
  }

  if (ticket.state !== 'matched' || !ticket.pairing_id)
    return c.json({ ticket: ticket.id, state: ticket.state, waiting_since: ticket.created_at })

  const pairing = await c.env.DB.prepare(`SELECT * FROM pairings WHERE id = ?`)
    .bind(ticket.pairing_id)
    .first<{ id: string; expires_at: string; region_id: string | null }>()
  const opponents = await c.env.DB.prepare(
    `SELECT p.id, p.handle FROM queue_tickets t JOIN players p ON p.id = t.player_id
      WHERE t.pairing_id = ? AND t.player_id != ?`,
  )
    .bind(ticket.pairing_id, player.id)
    .all<{ id: string; handle: string }>()

  const joinTicket = await issueTicket(await signingSecret(c.env.DB, app.id), {
    pairing: ticket.pairing_id,
    player: player.id,
    handle: player.handle,
    discipline: ticket.discipline,
    expires: Math.floor(Date.parse(pairing!.expires_at) / 1000),
  })

  return c.json({
    ticket: ticket.id,
    state: 'matched',
    pairing: ticket.pairing_id,
    region: pairing?.region_id ?? null,
    opponents: opponents.results,
    // The match server checks this itself; it never has to ask us.
    join_ticket: joinTicket,
    expires_at: pairing?.expires_at,
  })
})

live.delete('/v1/queue/:ticket', requireApp, requirePlayer, async (c) => {
  const res = await c.env.DB.prepare(
    `UPDATE queue_tickets SET state = 'cancelled' WHERE id = ? AND player_id = ? AND state = 'waiting'`,
  )
    .bind(c.req.param('ticket'), c.get('player')!.id)
    .run()
  if (!res.meta.changes) return c.json({ error: 'no waiting ticket' }, 404)
  return c.json({ ticket: c.req.param('ticket'), state: 'cancelled' })
})

/** For a match server that would rather ask than verify offline. */
live.post('/v1/tickets/verify', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const { ticket } = await c.req.json<{ ticket: string }>()
  const checked = await readTicket(await signingSecret(c.env.DB, app.id), ticket ?? '')
  if (!checked.ok) return c.json({ valid: false, error: checked.error }, 401)

  const belongs = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM queue_tickets WHERE pairing_id = ? AND player_id = ? AND state = 'matched'`,
  )
    .bind(checked.claims.pairing, checked.claims.player)
    .first()
  if (!belongs) return c.json({ valid: false, error: 'ticket does not match a pairing' }, 401)
  return c.json({ valid: true, ...checked.claims })
})

/** The signing secret, for a match server that verifies tickets offline. */
live.get('/v1/signing-secret', requireAppSecret, async (c) =>
  c.json({ signing_secret: await signingSecret(c.env.DB, c.get('app')!.id) }),
)

export { signingSecret }
