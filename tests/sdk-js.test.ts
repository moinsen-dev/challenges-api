import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'
import { ChallengesError, createClient, type TokenStore } from '../packages/js/src/index'
import { call, freshSeason, makeApp, makeDiscipline, unique } from './helpers'

/** Point the SDK at the worker in this runtime instead of at the network. */
const localFetch: typeof fetch = (input, init) =>
  worker.fetch(new Request(input as RequestInfo, init), env as any, {
    waitUntil() {},
    passThroughOnException() {},
  } as ExecutionContext)

function memoryStore(): TokenStore {
  let token: string | null = null
  return { get: () => token, set: (t) => void (token = t), clear: () => void (token = null) }
}

async function arena(disc: Record<string, unknown> = {}) {
  await freshSeason()
  const keys = await makeApp()
  const slug = unique('d')
  await makeDiscipline(keys, { slug, name: 'D', trust_tier: 1, ...disc })
  const client = createClient({
    baseUrl: 'https://api.test',
    appKey: keys.public_key,
    storage: memoryStore(),
    fetch: localFetch,
  })
  return { keys, slug, client }
}

describe('JavaScript client', () => {
  it('refuses a secret key outright', () => {
    expect(() =>
      createClient({ baseUrl: 'https://api.test', appKey: 'chapi_sk_' + '0'.repeat(64), fetch: localFetch }),
    ).toThrow(/secret key/)
  })

  it('signs in, remembers the token, and reuses it', async () => {
    const { client } = await arena()
    const me = await client.signIn({ handle: unique('sdk') })
    expect(me.player.handle).toMatch(/^sdk/)
    const token = client.token
    expect(token).toBeTruthy()

    const again = await client.signIn()
    expect(again.player.id).toBe(me.player.id)
    expect(client.token).toBe(token)
  })

  it('walks the whole loop a game actually performs', async () => {
    const { client, slug } = await arena({ qualifying_score: 100 })
    await client.signIn({ handle: unique('player') })
    await client.chooseRegion('hh-altona')

    const weak = await client.submit(slug, 40)
    expect(weak.qualified).toBe(false)
    expect((await client.leaderboard(slug, { region: 'hh-altona' })).entries).toHaveLength(0)

    const passed = await client.submit(slug, 500)
    expect(passed.qualified_now).toBe(true)
    expect(passed.rank?.region?.rank).toBe(1)

    const board = await client.leaderboard(slug, { region: 'hh-altona' })
    expect(board.entries[0].handle).toBe((await client.me()).player.handle)
    expect(board.title_eligible).toBe(false)

    const status = await client.status(slug)
    expect(status.value).toBe(500)
    expect(status.qualified).toBe(true)
  })

  it('carries occurred_at as a Date and idempotency keys', async () => {
    const { client, slug } = await arena({ aggregation: 'sum' })
    await client.signIn()
    const key = unique('idem')
    const first = await client.submit(slug, 10, { idemKey: key, occurredAt: new Date() })
    const second = await client.submit(slug, 10, { idemKey: key })
    expect(first.entry_id).toBe(second.entry_id)
    expect(second.duplicate).toBe(true)
    expect((await client.status(slug)).value).toBe(10)
  })

  it('reads a daily seed and a catalog', async () => {
    const { client, slug } = await arena()
    const catalog = await client.catalog()
    expect(catalog.disciplines.map((d) => d.slug)).toContain(slug)
    expect(catalog.regions.length).toBeGreaterThan(5)

    const a = await client.daily(slug, '2026-09-01')
    const b = await client.daily(slug, '2026-09-01')
    expect(a.seed).toBe(b.seed)
  })

  it('drives challenges between two clients', async () => {
    const { keys, slug, client } = await arena()
    const other = createClient({
      baseUrl: 'https://api.test',
      appKey: keys.public_key,
      storage: memoryStore(),
      fetch: localFetch,
    })
    const mine = await client.signIn({ handle: unique('a') })
    const theirs = await other.signIn({ handle: unique('b') })

    await client.submit(slug, 100)
    const challenge = await client.challenge(slug, { opponent: theirs.player.handle })
    expect(challenge.target_value).toBe(100)

    await other.accept(challenge.id)
    expect((await other.submit(slug, 50)).settled_challenges).toEqual([])
    expect((await other.submit(slug, 150)).settled_challenges).toContain(challenge.id)

    const listed = await client.challenges()
    const settled = listed.challenges.find((c) => c.id === challenge.id)
    expect(settled?.state).toBe('settled')
    expect(settled?.winner).toBe(theirs.player.handle)
    expect(settled?.challenger).toBe(mine.player.handle)
  })

  it('handles profile, rivals and a friends board', async () => {
    const { keys, slug, client } = await arena()
    const friend = createClient({
      baseUrl: 'https://api.test',
      appKey: keys.public_key,
      storage: memoryStore(),
      fetch: localFetch,
    })
    await client.signIn({ handle: unique('me') })
    const buddy = await friend.signIn({ handle: unique('buddy') })
    const stranger = createClient({
      baseUrl: 'https://api.test',
      appKey: keys.public_key,
      storage: memoryStore(),
      fetch: localFetch,
    })
    await stranger.signIn({ handle: unique('stranger') })

    await client.profile.update({ display_name: 'The Quick One', locale: 'de-DE' })
    expect((await client.me()).player.display_name).toBe('The Quick One')

    await client.submit(slug, 10)
    await friend.submit(slug, 20)
    await stranger.submit(slug, 30)
    await client.rivals.add(buddy.player.handle)
    expect((await client.rivals.list()).follows.map((f) => f.handle)).toContain(buddy.player.handle)

    const friends = await client.leaderboard(slug, { scope: 'friends' })
    expect(friends.scope).toBe('friends')
    expect(friends.entries).toHaveLength(2)
  })

  it('blocks, reports and searches', async () => {
    const { keys, client } = await arena()
    const other = createClient({
      baseUrl: 'https://api.test',
      appKey: keys.public_key,
      storage: memoryStore(),
      fetch: localFetch,
    })
    await client.signIn({ handle: unique('quiet') })
    const loud = await other.signIn({ handle: unique('loud') })

    expect((await client.report(loud.player.handle, 'harassment', 'shouting')).state).toBe('open')
    await client.blocks.add(loud.player.handle)
    expect((await client.blocks.list()).blocks.map((b) => b.handle)).toContain(loud.player.handle)
    const found = await client.players(loud.player.handle.slice(0, 8))
    expect(found.players.map((p) => p.handle)).not.toContain(loud.player.handle)
    await client.blocks.remove(loud.player.handle)
  })

  it('moves an identity to another device with a link code', async () => {
    const { keys, slug, client } = await arena()
    const me = await client.signIn({ handle: unique('mobile') })
    await client.submit(slug, 7)

    const secondDevice = createClient({
      baseUrl: 'https://api.test',
      appKey: keys.public_key,
      storage: memoryStore(),
      fetch: localFetch,
    })
    const code = await client.linkCode()
    const same = await secondDevice.redeemLinkCode(code.code)
    expect(same.player.id).toBe(me.player.id)
    expect((await secondDevice.status(slug)).value).toBe(7)
  })

  it('turns an API error into something a caller can act on', async () => {
    const { client } = await arena()
    await client.signIn()
    await expect(client.submit(unique('nope'), 1)).rejects.toBeInstanceOf(ChallengesError)
    try {
      await client.submit(unique('nope'), 1)
    } catch (error) {
      const failure = error as ChallengesError
      expect(failure.status).toBe(404)
      expect(failure.message).toBe('unknown discipline')
      expect(failure.needsSignIn).toBe(false)
    }
  })

  it('forgets a token the server no longer accepts', async () => {
    const { client } = await arena()
    await client.signIn()
    client.useToken('0'.repeat(64))
    await expect(client.me()).rejects.toThrow()
    // A dead token is cleared, so the next signIn() starts clean instead of looping.
    expect(client.token).toBeNull()
    const fresh = await client.signIn()
    expect(fresh.player.id).toBeTruthy()
  })

  it('exports and deletes an account', async () => {
    const { client, slug } = await arena()
    await client.signIn()
    await client.submit(slug, 3)
    const exported = await client.exportData()
    expect((exported.entries as unknown[]).length).toBe(1)

    await client.deleteAccount()
    expect(client.token).toBeNull()
  })

  it('watches events and stops when told', async () => {
    const { client, slug } = await arena({ qualifying_score: 1 })
    await client.signIn()
    const seen: string[] = []
    const stop = client.watchEvents((event) => seen.push(event.type), { intervalMs: 5 })
    await client.submit(slug, 10)
    await new Promise((resolve) => setTimeout(resolve, 40))
    stop()
    const countAtStop = seen.length
    expect(seen).toContain('qualification.achieved')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(seen.length).toBe(countAtStop)
  })

  it('joins a waitlist and reads what is missing', async () => {
    const { client } = await arena()
    await client.signIn()
    const regionId = unique('bezirk')
    await call('POST', '/v1/admin/regions', {
      admin: true,
      body: { id: regionId, parent_id: 'hh-city', level: 1, name: 'New', active: false, unlock_threshold: 4 },
    })
    const joined = await client.waitlist.join(regionId)
    expect(joined.waiting).toBe(1)
    expect(joined.missing).toBe(3)
    expect((await client.waitlist.regions()).regions.some((r) => r.id === regionId)).toBe(true)
  })
})
