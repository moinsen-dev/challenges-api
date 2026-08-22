import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { call, freshSeason, makeApp, makeDiscipline, signup, unique } from './helpers'
import { readTicket, signDelivery, verifyDelivery } from '../src/signing'

const ctx = { waitUntil() {}, passThroughOnException() {} } as ExecutionContext

afterEach(() => vi.unstubAllGlobals())

async function duelArena() {
  const season = await freshSeason()
  const keys = await makeApp()
  const slug = unique('duel')
  await makeDiscipline(keys, {
    slug,
    name: 'Duel',
    trust_tier: 2,
    head_to_head: true,
    max_title_level: 2,
  })
  return { keys, slug, season }
}

const queue = (keys: any, token: string, slug: string, party?: string) =>
  call('POST', '/v1/queue', {
    key: keys.public_key,
    token,
    body: { discipline: slug, ...(party ? { party_id: party } : {}) },
  })

const ticketState = (keys: any, token: string, ticket: string) =>
  call('GET', `/v1/queue/${ticket}`, { key: keys.public_key, token })

describe('Matchmaking', () => {
  it('pairs two waiting players and issues each a join ticket', async () => {
    const { keys, slug } = await duelArena()
    const one = await signup(keys)
    const two = await signup(keys)

    const first = await queue(keys, one.token, slug)
    expect(first.body.state).toBe('waiting')

    const second = await queue(keys, two.token, slug)
    expect(second.body.state).toBe('matched')
    expect(second.body.pairing).toBeTruthy()

    const forOne = await ticketState(keys, one.token, first.body.ticket)
    expect(forOne.body.state).toBe('matched')
    expect(forOne.body.pairing).toBe(second.body.pairing)
    expect(forOne.body.opponents.map((o: any) => o.handle)).toEqual([two.handle])
    expect(forOne.body.join_ticket).toMatch(/^[\w-]+\.[0-9a-f]{64}$/)
  })

  it('never hands the same player to two matches', async () => {
    const { keys, slug } = await duelArena()
    const players = []
    for (let i = 0; i < 8; i++) players.push(await signup(keys))

    // Everybody arrives at once, which is the only interesting case.
    const results = await Promise.all(players.map((p) => queue(keys, p.token, slug)))
    expect(results.every((r) => r.status === 201)).toBe(true)

    const rows = await env.DB.prepare(
      `SELECT player_id, pairing_id, state FROM queue_tickets WHERE state = 'matched'`,
    ).all<{ player_id: string; pairing_id: string }>()

    // Each matched player appears once, and every pairing holds exactly two.
    const perPlayer = new Map<string, number>()
    const perPairing = new Map<string, number>()
    for (const row of rows.results) {
      perPlayer.set(row.player_id, (perPlayer.get(row.player_id) ?? 0) + 1)
      perPairing.set(row.pairing_id, (perPairing.get(row.pairing_id) ?? 0) + 1)
    }
    expect([...perPlayer.values()].every((n) => n === 1)).toBe(true)
    expect([...perPairing.values()].every((n) => n === 2)).toBe(true)
  })

  it('refuses to queue twice, and lets a ticket be cancelled', async () => {
    const { keys, slug } = await duelArena()
    const player = await signup(keys)
    const first = await queue(keys, player.token, slug)
    expect((await queue(keys, player.token, slug)).status).toBe(409)

    const cancelled = await call('DELETE', `/v1/queue/${first.body.ticket}`, {
      key: keys.public_key,
      token: player.token,
    })
    expect(cancelled.body.state).toBe('cancelled')
    // Cancelling frees the player to queue again.
    expect((await queue(keys, player.token, slug)).status).toBe(201)
  })

  it('does not pair somebody with their own party', async () => {
    const { keys, slug } = await duelArena()
    const one = await signup(keys)
    const two = await signup(keys)
    const party = unique('party')

    await queue(keys, one.token, slug, party)
    const second = await queue(keys, two.token, slug, party)
    expect(second.body.state).toBe('waiting')

    const outsider = await signup(keys)
    expect((await queue(keys, outsider.token, slug)).body.state).toBe('matched')
  })

  it('prefers the closest rating', async () => {
    const { keys, slug, season } = await duelArena()
    const d = await env.DB.prepare(`SELECT id FROM disciplines WHERE slug = ?`).bind(slug).first<any>()
    const far = await signup(keys)
    const near = await signup(keys)
    const seeker = await signup(keys)

    const keysRow = await env.DB.prepare(`SELECT id FROM apps WHERE slug = ?`).bind(keys.slug).first<any>()
    // Both are placed straight into the queue: going through the endpoint
    // would pair them with each other before the seeker ever arrives.
    for (const [player, rating] of [
      [far, 2400],
      [near, 1520],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO queue_tickets
           (id, app_id, discipline_id, season_id, player_id, rating, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          unique('qt'),
          keysRow.id,
          d.id,
          season,
          player.player_id,
          rating,
          new Date().toISOString(),
          new Date(Date.now() + 300_000).toISOString(),
        )
        .run()
    }

    const matched = await queue(keys, seeker.token, slug)
    const opponents = await ticketState(keys, seeker.token, matched.body.ticket)
    expect(opponents.body.opponents[0].handle).toBe(near.handle)
  })

  it('expires a ticket nobody claimed', async () => {
    const { keys, slug } = await duelArena()
    const player = await signup(keys)
    const ticket = await queue(keys, player.token, slug)
    await env.DB.prepare(`UPDATE queue_tickets SET expires_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), ticket.body.ticket)
      .run()

    const state = await ticketState(keys, player.token, ticket.body.ticket)
    expect(state.body.state).toBe('expired')
  })

  it('refuses a discipline that is not head-to-head', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('solo')
    await makeDiscipline(keys, { slug, name: 'Solo', trust_tier: 1 })
    const player = await signup(keys)
    const res = await queue(keys, player.token, slug)
    expect(res.status).toBe(400)
  })
})

describe('Join tickets', () => {
  it('can be checked by a match server with nothing but the signing secret', async () => {
    const { keys, slug } = await duelArena()
    const one = await signup(keys)
    const two = await signup(keys)
    const first = await queue(keys, one.token, slug)
    await queue(keys, two.token, slug)

    const state = await ticketState(keys, one.token, first.body.ticket)
    const revealed = await call('GET', '/v1/signing-secret', { key: keys.secret_key })
    expect(revealed.body.signing_secret).toBeTruthy()

    // Offline verification: no call back to us.
    const checked = await readTicket(revealed.body.signing_secret, state.body.join_ticket)
    expect(checked.ok).toBe(true)
    if (checked.ok) {
      expect(checked.claims.player).toBe(one.player_id)
      expect(checked.claims.handle).toBe(one.handle)
      expect(checked.claims.pairing).toBe(state.body.pairing)
    }
  })

  it('refuses a tampered or foreign ticket', async () => {
    const { keys, slug } = await duelArena()
    const one = await signup(keys)
    const two = await signup(keys)
    const first = await queue(keys, one.token, slug)
    await queue(keys, two.token, slug)
    const state = await ticketState(keys, one.token, first.body.ticket)
    const good = state.body.join_ticket

    const online = await call('POST', '/v1/tickets/verify', { key: keys.secret_key, body: { ticket: good } })
    expect(online.body.valid).toBe(true)

    const [body, signature] = good.split('.')
    const tampered = `${body}.${signature.replace(/.$/, (ch: string) => (ch === 'a' ? 'b' : 'a'))}`
    const bad = await call('POST', '/v1/tickets/verify', { key: keys.secret_key, body: { ticket: tampered } })
    expect(bad.status).toBe(401)

    const nonsense = await call('POST', '/v1/tickets/verify', { key: keys.secret_key, body: { ticket: 'junk' } })
    expect(nonsense.body.error).toContain('malformed')
  })

  it('refuses an expired ticket', async () => {
    const { keys, slug } = await duelArena()
    const one = await signup(keys)
    const two = await signup(keys)
    const first = await queue(keys, one.token, slug)
    await queue(keys, two.token, slug)
    const state = await ticketState(keys, one.token, first.body.ticket)

    const revealed = await call('GET', '/v1/signing-secret', { key: keys.secret_key })
    const stale = await readTicket(revealed.body.signing_secret, state.body.join_ticket)
    expect(stale.ok).toBe(true)

    // Move the clock past the ticket by rewriting its own expiry claim: a
    // ticket whose signature still verifies but whose time has passed.
    vi.setSystemTime(new Date(Date.now() + 10 * 60_000))
    const expired = await readTicket(revealed.body.signing_secret, state.body.join_ticket)
    expect(expired.ok).toBe(false)
    vi.useRealTimers()
  })

  it('needs the secret key to verify or to reveal', async () => {
    const { keys } = await duelArena()
    expect((await call('GET', '/v1/signing-secret', { key: keys.public_key })).status).toBe(403)
    expect(
      (await call('POST', '/v1/tickets/verify', { key: keys.public_key, body: { ticket: 'x' } })).status,
    ).toBe(403)
  })
})

describe('Presence', () => {
  it('counts everyone but names only rivals', async () => {
    await freshSeason()
    const keys = await makeApp()
    const me = await signup(keys)
    const friend = await signup(keys)
    const stranger = await signup(keys)

    for (const player of [me, friend, stranger])
      await call('POST', '/v1/me/presence', {
        key: keys.public_key,
        token: player.token,
        body: { status: 'playing', detail: 'level 3' },
      })
    await call('POST', `/v1/me/follows/${friend.handle}`, { key: keys.public_key, token: me.token })

    const seen = await call('GET', '/v1/presence', { key: keys.public_key, token: me.token })
    expect(seen.body.online).toBe(3)
    expect(seen.body.rivals.map((r: any) => r.handle)).toEqual([friend.handle])
    expect(seen.body.rivals[0].status).toBe('playing')
  })

  it('forgets somebody who stopped checking in', async () => {
    await freshSeason()
    const keys = await makeApp()
    const me = await signup(keys)
    const ghost = await signup(keys)
    await call('POST', '/v1/me/presence', { key: keys.public_key, token: ghost.token, body: {} })
    await env.DB.prepare(`UPDATE presence SET last_seen = ? WHERE player_id = ?`)
      .bind(new Date(Date.now() - 10 * 60_000).toISOString(), ghost.player_id)
      .run()

    await call('POST', '/v1/me/presence', { key: keys.public_key, token: me.token, body: {} })
    const seen = await call('GET', '/v1/presence', { key: keys.public_key, token: me.token })
    expect(seen.body.online).toBe(1)
  })
})

describe('Server-sent events', () => {
  async function stream(keys: any, token: string, query = '') {
    const res = await worker.fetch(
      new Request(`https://api.test/v1/events/stream${query}`, {
        headers: { 'X-App-Key': keys.public_key, Authorization: `Bearer ${token}` },
      }),
      env as any,
      ctx,
    )
    return res
  }

  it('speaks the protocol and replays from a cursor', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('d')
    await makeDiscipline(keys, { slug, name: 'D', trust_tier: 1, qualifying_score: 1 })
    const player = await signup(keys)
    await call('POST', '/v1/entries', {
      key: keys.public_key,
      token: player.token,
      body: { discipline: slug, value: 10 },
    })

    const res = await stream(keys, player.token, '?max_seconds=1&interval_ms=250')
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(res.headers.get('Cache-Control')).toContain('no-cache')

    const text = await res.text()
    expect(text).toContain('event: qualification.achieved')
    expect(text).toMatch(/^id: \d+$/m)
    // It closes itself rather than hanging on forever.
    expect(text).toContain('event: bye')

    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
    const resumed = await worker.fetch(
      new Request(`https://api.test/v1/events/stream?max_seconds=1&interval_ms=250`, {
        headers: {
          'X-App-Key': keys.public_key,
          Authorization: `Bearer ${player.token}`,
          'Last-Event-ID': String(Math.max(...ids)),
        },
      }),
      env as any,
      ctx,
    )
    const after = await resumed.text()
    // Nothing new happened, so the resumed stream carries no events at all.
    expect(after).not.toContain('event: qualification.achieved')
    expect(after).toContain('keep-alive')
  })

  it('needs a player, like every other personal endpoint', async () => {
    const keys = await makeApp()
    const res = await worker.fetch(
      new Request('https://api.test/v1/events/stream', { headers: { 'X-App-Key': keys.public_key } }),
      env as any,
      ctx,
    )
    expect(res.status).toBe(401)
  })
})

describe('Webhooks', () => {
  /** An endpoint somebody else operates, with its failures under our control. */
  function endpoint(behaviour: { fail?: number } = {}) {
    const received: { body: string; signature: string; event: string }[] = []
    let failures = behaviour.fail ?? 0
    const original = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith('https://hook.test/')) {
        if (failures > 0) {
          failures--
          return new Response('nope', { status: 500 })
        }
        received.push({
          body: String(init?.body),
          signature: (init?.headers as Record<string, string>)['X-Challenges-Signature'],
          event: (init?.headers as Record<string, string>)['X-Challenges-Event'],
        })
        return new Response('ok', { status: 200 })
      }
      return original(input as RequestInfo, init)
    })
    return received
  }

  async function register(keys: any, events?: string[]) {
    return call('POST', '/v1/webhooks', {
      key: keys.secret_key,
      body: { url: 'https://hook.test/events', ...(events ? { events } : {}) },
    })
  }

  it('delivers a signed payload the receiver can verify', async () => {
    const { keys, slug } = await duelArena()
    const received = endpoint()
    const hook = await register(keys)
    expect(hook.body.secret).toMatch(/^whsec_/)

    const one = await signup(keys)
    const two = await signup(keys)
    await queue(keys, one.token, slug)
    await queue(keys, two.token, slug)

    expect(received).toHaveLength(1)
    expect(received[0].event).toBe('match.found')
    expect(await verifyDelivery(hook.body.secret, received[0].signature, received[0].body)).toBe(true)
    // A different secret must not verify the same delivery.
    expect(await verifyDelivery('whsec_wrong', received[0].signature, received[0].body)).toBe(false)
  })

  it('refuses an old signature and a tampered body', async () => {
    const secret = 'whsec_test'
    const body = JSON.stringify({ type: 'match.found' })
    const fresh = await signDelivery(secret, body)
    expect(await verifyDelivery(secret, fresh, body)).toBe(true)
    expect(await verifyDelivery(secret, fresh, body + ' ')).toBe(false)

    const ancient = await signDelivery(secret, body, Date.now() - 3600_000)
    expect(await verifyDelivery(secret, ancient, body)).toBe(false)
  })

  it('retries a failing endpoint until it answers', async () => {
    const { keys, slug } = await duelArena()
    const received = endpoint({ fail: 2 })
    await register(keys)

    const one = await signup(keys)
    const two = await signup(keys)
    await queue(keys, one.token, slug)
    await queue(keys, two.token, slug)
    expect(received).toHaveLength(0)

    const pending = await env.DB.prepare(
      `SELECT id, attempts, state, last_status FROM webhook_deliveries ORDER BY created_at DESC LIMIT 1`,
    ).first<{ id: string; attempts: number; state: string; last_status: number }>()
    expect(pending!.state).toBe('pending')
    expect(pending!.attempts).toBe(1)
    expect(pending!.last_status).toBe(500)

    // The cron picks it up once its backoff has passed.
    await env.DB.prepare(`UPDATE webhook_deliveries SET next_try_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), pending!.id)
      .run()
    await call('POST', '/v1/admin/webhooks/retry', { admin: true })
    await env.DB.prepare(`UPDATE webhook_deliveries SET next_try_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), pending!.id)
      .run()
    await call('POST', '/v1/admin/webhooks/retry', { admin: true })

    expect(received).toHaveLength(1)
    const delivered = await env.DB.prepare(`SELECT state, attempts FROM webhook_deliveries WHERE id = ?`)
      .bind(pending!.id)
      .first<{ state: string; attempts: number }>()
    expect(delivered!.state).toBe('delivered')
    expect(delivered!.attempts).toBe(3)
  })

  it('sends only the events an endpoint asked for', async () => {
    const { keys, slug } = await duelArena()
    const received = endpoint()
    await register(keys, ['title.awarded'])

    const one = await signup(keys)
    const two = await signup(keys)
    await queue(keys, one.token, slug)
    await queue(keys, two.token, slug)
    expect(received).toHaveLength(0)
  })

  it('lists endpoints with their health, and can be switched off', async () => {
    const { keys } = await duelArena()
    endpoint()
    const hook = await register(keys)

    const listed = await call('GET', '/v1/webhooks', { key: keys.secret_key })
    expect(listed.body.webhooks[0].url).toBe('https://hook.test/events')
    expect(JSON.stringify(listed.body)).not.toContain(hook.body.secret)

    expect((await call('DELETE', `/v1/webhooks/${hook.body.id}`, { key: keys.secret_key })).status).toBe(200)
    expect((await call('DELETE', '/v1/webhooks/wh_nothing', { key: keys.secret_key })).status).toBe(404)
  })

  it('refuses a URL that is not https, and needs the secret key', async () => {
    const { keys } = await duelArena()
    expect(
      (await call('POST', '/v1/webhooks', { key: keys.secret_key, body: { url: 'http://hook.test/x' } })).status,
    ).toBe(400)
    expect(
      (await call('POST', '/v1/webhooks', { key: keys.secret_key, body: { url: 'not a url' } })).status,
    ).toBe(400)
    expect(
      (await call('POST', '/v1/webhooks', { key: keys.public_key, body: { url: 'https://hook.test/x' } })).status,
    ).toBe(403)
  })
})

describe('The parts that only show up when things go wrong', () => {
  it('lists deliveries for one endpoint, and refuses a foreign id', async () => {
    const { keys, slug } = await duelArena()
    const received: any[] = []
    const original = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://hook.test/')) {
        received.push(init)
        return new Response('ok')
      }
      return original(input as RequestInfo, init)
    })

    const hook = await call('POST', '/v1/webhooks', {
      key: keys.secret_key,
      body: { url: 'https://hook.test/events' },
    })
    const one = await signup(keys)
    const two = await signup(keys)
    await queue(keys, one.token, slug)
    await queue(keys, two.token, slug)

    const listed = await call(`GET`, `/v1/webhooks/${hook.body.id}/deliveries`, { key: keys.secret_key })
    expect(listed.body.deliveries).toHaveLength(1)
    expect(listed.body.deliveries[0].event_type).toBe('match.found')
    expect(listed.body.deliveries[0].state).toBe('delivered')

    expect((await call('GET', '/v1/webhooks/wh_other/deliveries', { key: keys.secret_key })).status).toBe(404)
  })

  it('gives up loudly rather than retrying forever', async () => {
    const { keys, slug } = await duelArena()
    const original = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://hook.test/')) return new Response('down', { status: 503 })
      return original(input as RequestInfo, init)
    })
    await call('POST', '/v1/webhooks', {
      key: keys.secret_key,
      body: { url: 'https://hook.test/broken' },
    })

    const one = await signup(keys)
    const two = await signup(keys)
    await queue(keys, one.token, slug)
    await queue(keys, two.token, slug)

    const delivery = await env.DB.prepare(
      `SELECT id FROM webhook_deliveries ORDER BY created_at DESC LIMIT 1`,
    ).first<{ id: string }>()

    for (let i = 0; i < 8; i++) {
      await env.DB.prepare(`UPDATE webhook_deliveries SET next_try_at = ? WHERE id = ?`)
        .bind(new Date(Date.now() - 1000).toISOString(), delivery!.id)
        .run()
      await call('POST', '/v1/admin/webhooks/retry', { admin: true })
    }

    const final = await env.DB.prepare(
      `SELECT state, attempts, last_status FROM webhook_deliveries WHERE id = ?`,
    )
      .bind(delivery!.id)
      .first<{ state: string; attempts: number; last_status: number }>()
    // Failed is a state somebody can look at, not silence.
    expect(final!.state).toBe('failed')
    expect(final!.last_status).toBe(503)
    const health = await call('GET', '/v1/webhooks', { key: keys.secret_key })
    expect(health.body.webhooks[0].failed).toBe(1)
    expect(health.body.webhooks[0].last_error).toContain('503')
  })

  it('mints a signing secret for an app that never had one', async () => {
    const { keys } = await duelArena()
    await env.DB.prepare(`UPDATE apps SET signing_secret = NULL WHERE slug = ?`).bind(keys.slug).run()
    const revealed = await call('GET', '/v1/signing-secret', { key: keys.secret_key })
    expect(revealed.body.signing_secret).toMatch(/^[0-9a-f]{64}$/)

    // And it stays the same on the next call, or every ticket would break.
    const again = await call('GET', '/v1/signing-secret', { key: keys.secret_key })
    expect(again.body.signing_secret).toBe(revealed.body.signing_secret)
  })

  it('refuses a ticket whose body is not readable', async () => {
    const forged = `${btoa('not json at all').replace(/=+$/, '')}.deadbeef`
    const checked = await readTicket('some-secret', forged)
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.error).toContain('signature')
  })
})

describe('Small refusals that keep the live layer honest', () => {
  it('accepts a cursor as a query as well as a header', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('d')
    await makeDiscipline(keys, { slug, name: 'D', trust_tier: 1, qualifying_score: 1 })
    const player = await signup(keys)
    await call('POST', '/v1/entries', {
      key: keys.public_key,
      token: player.token,
      body: { discipline: slug, value: 10 },
    })

    const res = await worker.fetch(
      new Request('https://api.test/v1/events/stream?since=999999&max_seconds=1&interval_ms=250', {
        headers: { 'X-App-Key': keys.public_key, Authorization: `Bearer ${player.token}` },
      }),
      env as any,
      ctx,
    )
    const text = await res.text()
    // Nothing is newer than that cursor, so only keep-alives arrive.
    expect(text).not.toContain('event: qualification.achieved')
    expect(text).toContain('keep-alive')
  })

  it('falls back to "online" for a status it does not know', async () => {
    await freshSeason()
    const keys = await makeApp()
    const player = await signup(keys)
    const res = await call('POST', '/v1/me/presence', {
      key: keys.public_key,
      token: player.token,
      body: { status: 'invisible' },
    })
    expect(res.body.status).toBe('online')
  })

  it('will not show one player another player ticket', async () => {
    const { keys, slug } = await duelArena()
    const owner = await signup(keys)
    const nosy = await signup(keys)
    const ticket = await queue(keys, owner.token, slug)

    const peek = await call(`GET`, `/v1/queue/${ticket.body.ticket}`, {
      key: keys.public_key,
      token: nosy.token,
    })
    expect(peek.status).toBe(404)
    expect((await call('GET', '/v1/queue/qt_nothing', { key: keys.public_key, token: owner.token })).status).toBe(404)
  })

  it('reports a cancelled ticket as cancelled rather than pretending', async () => {
    const { keys, slug } = await duelArena()
    const player = await signup(keys)
    const ticket = await queue(keys, player.token, slug)
    await call('DELETE', `/v1/queue/${ticket.body.ticket}`, { key: keys.public_key, token: player.token })

    const state = await ticketState(keys, player.token, ticket.body.ticket)
    expect(state.body.state).toBe('cancelled')
    expect(state.body.join_ticket).toBeUndefined()
    // And it cannot be cancelled twice.
    expect(
      (await call('DELETE', `/v1/queue/${ticket.body.ticket}`, { key: keys.public_key, token: player.token }))
        .status,
    ).toBe(404)
  })

  it('needs an open season to queue at all', async () => {
    const { keys, slug } = await duelArena()
    const player = await signup(keys)
    await env.DB.prepare(`UPDATE seasons SET status = 'closed'`).run()
    expect((await queue(keys, player.token, slug)).status).toBe(409)
  })
})
