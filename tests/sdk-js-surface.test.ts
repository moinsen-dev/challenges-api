import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'
import { createClient, type TokenStore } from '../packages/js/src/index'
import { call, freshSeason, makeApp, makeDiscipline, unique } from './helpers'

const localFetch: typeof fetch = (input, init) =>
  worker.fetch(new Request(input as RequestInfo, init), env as any, {
    waitUntil() {},
    passThroughOnException() {},
  } as ExecutionContext)

function memoryStore(): TokenStore {
  let token: string | null = null
  return { get: () => token, set: (t) => void (token = t), clear: () => void (token = null) }
}

const clientFor = (publicKey: string) =>
  createClient({
    baseUrl: 'https://api.test',
    appKey: publicKey,
    storage: memoryStore(),
    fetch: localFetch,
  })

describe('JavaScript client — the rest of the surface', () => {
  it('reads a rating list after a duel', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('duel')
    await makeDiscipline(keys, { slug, name: 'Duel', trust_tier: 2, head_to_head: true, max_title_level: 2 })

    const a = clientFor(keys.public_key)
    const b = clientFor(keys.public_key)
    const one = await a.signIn({ handle: unique('duellist') })
    const two = await b.signIn({ handle: unique('duellist') })

    // A duel is server authority, so it is not part of the client surface.
    await call('POST', '/v1/matches', {
      key: keys.secret_key,
      body: {
        discipline: slug,
        placements: [
          { handle: one.player.handle, placement: 1 },
          { handle: two.player.handle, placement: 2 },
        ],
      },
    })

    const ratings = await a.ratings(slug)
    expect(ratings.ratings).toHaveLength(2)
    expect(ratings.ratings[0].handle).toBe(one.player.handle)
    expect(ratings.ratings[0].rating).toBeGreaterThan(1500)
  })

  it('reads a public profile and changes a handle', async () => {
    await freshSeason()
    const keys = await makeApp()
    const client = clientFor(keys.public_key)
    const me = await client.signIn({ handle: unique('renamer') })

    const publicView = await client.player(me.player.handle)
    expect(publicView.handle).toBe(me.player.handle)
    expect(publicView).not.toHaveProperty('region')

    const fresh = unique('renamed')
    const changed = await client.profile.changeHandle(fresh)
    expect(changed.handle).toBe(fresh)
    expect(changed.next_change_after_days).toBeGreaterThan(0)
    expect((await client.me()).player.handle).toBe(fresh)
  })

  it('adds and removes a rival and a block', async () => {
    await freshSeason()
    const keys = await makeApp()
    const me = clientFor(keys.public_key)
    const them = clientFor(keys.public_key)
    await me.signIn({ handle: unique('social') })
    const other = await them.signIn({ handle: unique('social') })

    await me.rivals.add(other.player.handle)
    expect((await me.rivals.list()).follows).toHaveLength(1)
    await me.rivals.remove(other.player.handle)
    expect((await me.rivals.list()).follows).toHaveLength(0)

    await me.blocks.add(other.player.handle)
    expect((await me.blocks.list()).blocks).toHaveLength(1)
    await me.blocks.remove(other.player.handle)
    expect((await me.blocks.list()).blocks).toHaveLength(0)
  })

  it('reads a collection with its own holdings', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('set')
    await call('POST', '/v1/collections', { key: keys.secret_key, body: { slug, name: 'Set' } })
    await call('POST', `/v1/collections/${slug}/items`, {
      key: keys.secret_key,
      body: { items: [{ slug: 'one', name: 'One' }, { slug: 'two', name: 'Two' }] },
    })

    const client = clientFor(keys.public_key)
    const me = await client.signIn({ handle: unique('collector') })
    const empty = await client.collection(slug)
    expect(empty.total).toBe(2)
    expect(empty.complete).toBe(false)

    // Granting is authority, never something a client does to itself.
    await call('POST', `/v1/collections/${slug}/grant`, {
      key: keys.secret_key,
      body: { handle: me.player.handle, item: 'one' },
    })
    const partial = await client.collection(slug)
    expect(partial.owned).toBe(1)
    expect(partial.items.find((i) => i.slug === 'one')?.owned).toBe(1)
  })

  it('reads and spends an invite allowance', async () => {
    await freshSeason()
    const keys = await makeApp()
    await call('PATCH', `/v1/admin/apps/${keys.slug}`, { admin: true, body: { invites_per_player: 2 } })

    const inviter = clientFor(keys.public_key)
    await inviter.signIn({ handle: unique('inviter') })
    expect((await inviter.invites.mine()).invites_left).toBe(2)

    const created = await inviter.invites.create()
    expect(created.invites_left).toBe(1)

    const guest = clientFor(keys.public_key)
    await guest.signIn({ handle: unique('guest'), inviteCode: created.code })
    expect((await inviter.invites.mine()).joined_through_you).toBe(1)
  })

  it('signs out without touching the account', async () => {
    await freshSeason()
    const keys = await makeApp()
    const client = clientFor(keys.public_key)
    const me = await client.signIn({ handle: unique('leaving') })

    client.signOut()
    expect(client.token).toBeNull()
    await expect(client.me()).rejects.toThrow()

    // The player is still there — signing out is not deleting.
    const stillThere = await client.player(me.player.handle)
    expect(stillThere.handle).toBe(me.player.handle)
  })

  it('pages events with a cursor', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('d')
    await makeDiscipline(keys, { slug, name: 'D', trust_tier: 1, qualifying_score: 1 })
    const client = clientFor(keys.public_key)
    await client.signIn({ handle: unique('watcher') })
    await client.submit(slug, 10)

    const first = await client.events()
    expect(first.events.length).toBeGreaterThan(0)
    expect(first.cursor).toBeGreaterThan(0)
    const tail = await client.events(first.cursor)
    expect(tail.events).toHaveLength(0)
  })

  it('falls back to memory when there is no usable localStorage', async () => {
    await freshSeason()
    const keys = await makeApp()
    // No storage passed: the default store has to survive a runtime without
    // localStorage instead of throwing on construction.
    const client = createClient({
      baseUrl: 'https://api.test',
      appKey: keys.public_key,
      fetch: localFetch,
    })
    const me = await client.signIn({ handle: unique('nostorage') })
    expect(client.token).toBeTruthy()
    expect((await client.me()).player.id).toBe(me.player.id)
  })
})

describe('JavaScript client — paging and neighbourhood', () => {
  it('walks a whole board through the generator', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('paged')
    await makeDiscipline(keys, { slug, name: 'Paged', trust_tier: 1 })

    for (let i = 0; i < 12; i++) {
      const player = clientFor(keys.public_key)
      await player.signIn({ handle: unique('walker') })
      await player.submit(slug, 500 - i)
    }

    const reader = clientFor(keys.public_key)
    await reader.signIn({ handle: unique('reader') })
    const seen: string[] = []
    for await (const row of reader.allStandings(slug, { pageSize: 5 })) seen.push(row.player_id)

    // The reader submitted nothing, so they are not on the board themselves.
    expect(seen).toHaveLength(12)
    expect(new Set(seen).size).toBe(12)
  })

  it('reads the rows around itself', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('around')
    await makeDiscipline(keys, { slug, name: 'Around', trust_tier: 1 })

    for (let i = 0; i < 5; i++) {
      const other = clientFor(keys.public_key)
      await other.signIn({ handle: unique('rival') })
      await other.submit(slug, 900 - i * 100)
    }
    const me = clientFor(keys.public_key)
    await me.signIn({ handle: unique('middling') })
    await me.submit(slug, 650) // between 700 and 600

    const around = await me.around(slug, { span: 1 })
    // 900, 800, 700, then 650, then 600, 500.
    expect(around.rank).toBe(4)
    expect(around.of).toBe(6)
    expect(around.rows.find((r) => r.you)?.value).toBe(650)
    expect(around.rows.map((r) => r.value)).toEqual([700, 650, 600])
  })
})

describe('JavaScript client — every option actually reaches the wire', () => {
  it('passes region, scope, limit and cursor together', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('opts')
    await makeDiscipline(keys, { slug, name: 'Options', trust_tier: 1 })

    const me = clientFor(keys.public_key)
    await me.signIn({ handle: unique('optioner') })
    await me.chooseRegion('hh-altona')
    for (let i = 0; i < 4; i++) await me.submit(slug, 100 + i, { meta: { attempt: i } })

    const friend = clientFor(keys.public_key)
    const buddy = await friend.signIn({ handle: unique('optionfriend') })
    await friend.chooseRegion('hh-altona')
    await friend.submit(slug, 500, { occurredAt: new Date() })
    await me.rivals.add(buddy.player.handle)

    const regional = await me.leaderboard(slug, { region: 'hh-altona', limit: 1 })
    expect(regional.region).toBe('hh-altona')
    expect(regional.entries).toHaveLength(1)
    expect(regional.cursor).toBeTruthy()

    const next = await me.leaderboard(slug, { region: 'hh-altona', limit: 1, cursor: regional.cursor })
    expect(next.entries[0].player_id).not.toBe(regional.entries[0].player_id)

    const friends = await me.leaderboard(slug, { scope: 'friends', limit: 10 })
    expect(friends.scope).toBe('friends')
    expect(friends.entries).toHaveLength(2)

    const around = await me.around(slug, { region: 'hh-altona', span: 1 })
    expect(around.region).toBe('hh-altona')
    expect(around.rows.some((r) => r.you)).toBe(true)
  })

  it('reads a daily seed for a named date and an explicit player profile', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('dated')
    await makeDiscipline(keys, { slug, name: 'Dated', trust_tier: 1 })
    const client = clientFor(keys.public_key)
    const me = await client.signIn({ handle: unique('dater') })

    const named = await client.daily(slug, '2027-01-01')
    const today = await client.daily(slug)
    expect(named.date).toBe('2027-01-01')
    expect(named.seed).not.toBe(today.seed)

    const publicProfile = await client.player(me.player.handle)
    expect(publicProfile.handle).toBe(me.player.handle)
  })
})

describe('JavaScript client — defaults and failure paths', () => {
  it('works with every optional argument omitted', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('bare')
    await makeDiscipline(keys, { slug, name: 'Bare', trust_tier: 1 })

    const client = clientFor(keys.public_key)
    await client.signIn()
    await client.submit(slug, 10)

    expect((await client.leaderboard(slug)).entries).toHaveLength(1)
    expect((await client.around(slug)).rank).toBe(1)
    expect((await client.daily(slug)).date).toHaveLength(10)
    expect((await client.events()).events.length).toBeGreaterThan(0)
    expect((await client.catalog()).disciplines.length).toBeGreaterThan(0)

    // A challenge with no opponent is an open invitation to anybody.
    const open = await client.challenge(slug)
    expect(open.target_value).toBe(10)
    const taker = clientFor(keys.public_key)
    await taker.signIn()
    expect((await taker.accept(open.id)).state).toBe('accepted')
  })

  it('forces a second account when asked to', async () => {
    await freshSeason()
    const keys = await makeApp()
    const client = clientFor(keys.public_key)
    const first = await client.signIn({ handle: unique('first') })
    const second = await client.signIn({ handle: unique('second'), force: true })
    expect(second.player.id).not.toBe(first.player.id)
  })

  it('keeps watching when a poll fails', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('flaky')
    await makeDiscipline(keys, { slug, name: 'Flaky', trust_tier: 1, qualifying_score: 1 })

    let failNext = true
    const flakyFetch: typeof fetch = (input, init) => {
      if (failNext && String(input).includes('/v1/events')) {
        failNext = false
        return Promise.reject(new Error('network gone'))
      }
      return localFetch(input, init)
    }
    const client = createClient({
      baseUrl: 'https://api.test',
      appKey: keys.public_key,
      storage: memoryStore(),
      fetch: flakyFetch,
    })
    await client.signIn()

    const seen: string[] = []
    const stop = client.watchEvents((event) => seen.push(event.type), { intervalMs: 5 })
    await client.submit(slug, 10)
    await new Promise((resolve) => setTimeout(resolve, 60))
    stop()
    // A failed poll must not end the watch; the next one still delivers.
    expect(seen).toContain('qualification.achieved')
  })
})

describe('JavaScript client — the live layer', () => {
  it('reports presence and reads the room', async () => {
    await freshSeason()
    const keys = await makeApp()
    const me = clientFor(keys.public_key)
    const buddy = clientFor(keys.public_key)
    await me.signIn({ handle: unique('host') })
    const friend = await buddy.signIn({ handle: unique('guest') })

    await me.presence.here('playing', 'level 3')
    await buddy.presence.here()
    await me.rivals.add(friend.player.handle)

    const room = await me.presence.list()
    expect(room.online).toBe(2)
    expect(room.rivals.map((r) => r.handle)).toEqual([friend.player.handle])
  })

  it('queues, matches and hands over a join ticket', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('duel')
    await makeDiscipline(keys, { slug, name: 'Duel', trust_tier: 2, head_to_head: true, max_title_level: 2 })

    const one = clientFor(keys.public_key)
    const two = clientFor(keys.public_key)
    await one.signIn({ handle: unique('fighter') })
    const other = await two.signIn({ handle: unique('fighter') })

    const first = await one.queue.join(slug)
    expect(first.state).toBe('waiting')
    const second = await two.queue.join(slug)
    expect(second.state).toBe('matched')

    const state = await one.queue.check(first.ticket)
    expect(state.state).toBe('matched')
    expect(state.opponents?.[0].handle).toBe(other.player.handle)
    expect(state.join_ticket).toBeTruthy()
  })

  it('leaves a queue again', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('duel')
    await makeDiscipline(keys, { slug, name: 'Duel', trust_tier: 2, head_to_head: true, max_title_level: 2 })
    const client = clientFor(keys.public_key)
    await client.signIn({ handle: unique('quitter') })

    const joined = await client.queue.join(slug)
    expect((await client.queue.leave(joined.ticket)).state).toBe('cancelled')
  })

  it('waits for a match and gives up cleanly when none comes', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('lonely')
    await makeDiscipline(keys, { slug, name: 'Lonely', trust_tier: 2, head_to_head: true, max_title_level: 2 })
    const client = clientFor(keys.public_key)
    await client.signIn({ handle: unique('waiting') })

    const outcome = await client.queue.waitForMatch(slug, { pollMs: 10, timeoutMs: 60 })
    expect(outcome.state).toBe('expired')
  })

  it('reads the live stream and stops when told', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('streamed')
    await makeDiscipline(keys, { slug, name: 'Streamed', trust_tier: 1, qualifying_score: 1 })
    const client = clientFor(keys.public_key)
    await client.signIn({ handle: unique('listener') })
    await client.submit(slug, 10)

    const seen: string[] = []
    const stop = client.watchLive((event) => seen.push(event.type))
    await new Promise((resolve) => setTimeout(resolve, 400))
    stop()

    expect(seen).toContain('qualification.achieved')
    const countAtStop = seen.length
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(seen.length).toBe(countAtStop)
  })
})

describe('JavaScript client — live layer, the harder halves', () => {
  it('waits and returns as soon as an opponent arrives', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('duel')
    await makeDiscipline(keys, { slug, name: 'Duel', trust_tier: 2, head_to_head: true, max_title_level: 2 })

    const waiting = clientFor(keys.public_key)
    const arriving = clientFor(keys.public_key)
    await waiting.signIn({ handle: unique('patient') })
    await arriving.signIn({ handle: unique('arriving') })

    const outcome = waiting.queue.waitForMatch(slug, { pollMs: 10, timeoutMs: 3000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await arriving.queue.join(slug)

    const matched = await outcome
    expect(matched.state).toBe('matched')
    expect(matched.join_ticket).toBeTruthy()
  })

  it('reports a stream it cannot open instead of failing silently', async () => {
    await freshSeason()
    const keys = await makeApp()
    const client = clientFor(keys.public_key)
    await client.signIn({ handle: unique('unlucky') })
    client.useToken('0'.repeat(64))

    const errors: unknown[] = []
    const stop = client.watchLive(
      () => {},
      { onError: (error) => errors.push(error) },
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    stop()
    expect(errors.length).toBeGreaterThan(0)
  })

  it('resumes a stream from where it stopped', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('resumed')
    await makeDiscipline(keys, { slug, name: 'Resumed', trust_tier: 1, qualifying_score: 1 })
    const client = clientFor(keys.public_key)
    await client.signIn({ handle: unique('resumer') })
    await client.submit(slug, 10)

    const firstRun: number[] = []
    const stopFirst = client.watchLive((event) => firstRun.push(event.id))
    await new Promise((resolve) => setTimeout(resolve, 300))
    stopFirst()
    expect(firstRun.length).toBeGreaterThan(0)

    // Starting again from the last id delivers nothing that was already seen.
    const secondRun: number[] = []
    const stopSecond = client.watchLive((event) => secondRun.push(event.id), {
      since: Math.max(...firstRun),
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    stopSecond()
    expect(secondRun).toHaveLength(0)
  })
})

describe('JavaScript client — ceremony', () => {
  it('reads a bracket and joins a tournament', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('d')
    await makeDiscipline(keys, { slug, name: 'D', trust_tier: 1 })
    const cupSlug = unique('cup')
    await call('POST', '/v1/tournaments', {
      key: keys.secret_key,
      body: { slug: cupSlug, name: 'Client Cup', discipline: slug },
    })

    const one = clientFor(keys.public_key)
    const two = clientFor(keys.public_key)
    await one.signIn({ handle: unique('entrant') })
    await two.signIn({ handle: unique('entrant') })
    await one.submit(slug, 200)
    await two.submit(slug, 100)

    expect((await one.tournaments.join(cupSlug)).entrants).toBe(1)
    await two.tournaments.join(cupSlug)

    const listed = await one.tournaments.list()
    expect(listed.tournaments.find((t) => t.slug === cupSlug)?.entrants).toBe(2)

    await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })
    const bracket = await one.tournaments.bracket(cupSlug)
    expect(bracket.entrants[0].seed).toBe(1)
    expect(bracket.bracket[0].state).toBe('ready')
  })

  it('lists titles and builds a card URL', async () => {
    const season = await freshSeason()
    const keys = await makeApp()
    const slug = unique('crowned')
    await makeDiscipline(keys, {
      slug, name: 'C', trust_tier: 1, max_title_level: 2, title_min_players: 1,
    })
    const client = clientFor(keys.public_key)
    const me = await client.signIn({ handle: unique('champ') })
    await client.chooseRegion('hh-bergedorf')
    await client.submit(slug, 777)
    await call(`POST`, `/v1/admin/seasons/${season}/close`, { admin: true })

    const archive = await client.titles({ region: 'hh-bergedorf' })
    expect(archive.titles[0].handle).toBe(me.player.handle)
    expect(client.titleCard(archive.titles[0].id)).toContain('/card.svg')
  })
})

describe('JavaScript client — ghosts', () => {
  it('lists ghosts and fetches the bytes of one', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('ghosted')
    await makeDiscipline(keys, { slug, name: 'Ghosted', trust_tier: 1 })

    const worker = (await import('../src/index')).default
    const { bytes, scorer } = await import('./fixtures/wasm')
    await worker.fetch(
      new Request('https://api.test/v1/verifier/modules?name=core', {
        method: 'POST',
        headers: { 'X-App-Key': keys.secret_key },
        body: bytes(scorer),
      }),
      env as any,
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    )
    await call(`POST`, `/v1/disciplines/${slug}/verifier`, {
      key: keys.secret_key,
      body: { module: 'core', export: 'verify' },
    })

    const client = clientFor(keys.public_key)
    await client.signIn({ handle: unique('ghost') })
    const trace = new Uint8Array([4, 2, 4, 2])
    let score = 0n
    for (const byte of trace) score = BigInt.asUintN(64, score * 31n + BigInt(byte))

    const held = await client.submit(slug, Number(score), { trace })
    const job = await env.DB.prepare(`SELECT id FROM verification_jobs WHERE entry_id = ?`)
      .bind(held.entry_id)
      .first<{ id: string }>()
    await call(`POST`, `/v1/verifier/jobs/${job!.id}/result`, {
      admin: true,
      body: { verdict: 'verified', computed_value: Number(score), cpu_ms: 1 },
    })

    const listed = await client.ghosts(slug, { limit: 3 })
    expect(listed.ghosts).toHaveLength(1)
    expect(listed.ghosts[0].entry_id).toBe(held.entry_id)

    const replay = await client.ghostTrace(held.entry_id)
    expect(replay).toEqual(trace)
    await expect(client.ghostTrace('ent_nothing')).rejects.toThrow(/no ghost/)
  })
})
