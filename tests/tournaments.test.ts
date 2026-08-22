import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { call, freshSeason, makeApp, makeDiscipline, signup, unique } from './helpers'
import { advancesTo, bracketSize, firstRound, roundCount, seedOrder } from '../src/bracket'

describe('Bracket arithmetic', () => {
  it('pairs the best against the worst, all the way down', () => {
    expect(seedOrder(2)).toEqual([1, 2])
    expect(seedOrder(4)).toEqual([1, 4, 2, 3])
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6])
    // The two strongest can only meet in the final, which is the whole point.
    const sixteen = seedOrder(16)
    expect(sixteen.indexOf(1) < 8).toBe(true)
    expect(sixteen.indexOf(2) >= 8).toBe(true)
  })

  it('rounds a field up to the next power of two', () => {
    expect(bracketSize(2)).toBe(2)
    expect(bracketSize(5)).toBe(8)
    expect(bracketSize(8)).toBe(8)
    expect(bracketSize(9)).toBe(16)
    expect(roundCount(5)).toBe(3)
  })

  it('gives the byes to the top seeds', () => {
    const round = firstRound(5)
    expect(round).toHaveLength(4)
    const byes = round.filter((pair) => pair.a === null || pair.b === null)
    const advancing = byes.map((pair) => pair.a ?? pair.b)
    // Five entrants means three byes, and they go to seeds 1, 2 and 3.
    expect(byes).toHaveLength(3)
    expect(advancing.sort((a, b) => a! - b!)).toEqual([1, 2, 3])
    // Seeds 4 and 5 actually have to play.
    const contested = round.find((pair) => pair.a !== null && pair.b !== null)
    expect([contested!.a, contested!.b].sort((a, b) => a! - b!)).toEqual([4, 5])
  })

  it('knows where a winner goes next, and where the road ends', () => {
    expect(advancesTo(1, 1, 8)).toEqual({ round: 2, slot: 1, side: 'a' })
    expect(advancesTo(1, 2, 8)).toEqual({ round: 2, slot: 1, side: 'b' })
    expect(advancesTo(2, 2, 8)).toEqual({ round: 3, slot: 1, side: 'b' })
    expect(advancesTo(3, 1, 8)).toBeNull()
  })
})

async function cup(entrantCount: number, disc: Record<string, unknown> = {}) {
  await freshSeason()
  const keys = await makeApp()
  const slug = unique('cup-disc')
  await makeDiscipline(keys, { slug, name: 'Cup', trust_tier: 1, ...disc })

  const players = []
  for (let i = 0; i < entrantCount; i++) {
    const player = await signup(keys)
    // Descending scores, so seeding is predictable.
    await call('POST', '/v1/entries', {
      key: keys.public_key,
      token: player.token,
      body: { discipline: slug, value: 1000 - i * 10 },
    })
    players.push(player)
  }

  const cupSlug = unique('cup')
  await call('POST', '/v1/tournaments', {
    key: keys.secret_key,
    body: { slug: cupSlug, name: 'The Cup', discipline: slug },
  })
  for (const player of players)
    await call(`POST`, `/v1/tournaments/${cupSlug}/join`, { key: keys.public_key, token: player.token })

  return { keys, slug, cupSlug, players }
}

const bracketOf = async (keys: any, cupSlug: string) =>
  (await call(`GET`, `/v1/tournaments/${cupSlug}`, { key: keys.public_key })).body

const report = (keys: any, cupSlug: string, matchId: string, winner: string) =>
  call(`POST`, `/v1/tournaments/${cupSlug}/matches/${matchId}/result`, {
    key: keys.secret_key,
    body: { winner },
  })

describe('Running a tournament', () => {
  it('seeds from the standings and hands byes to the strongest', async () => {
    const { keys, cupSlug, players } = await cup(5)
    const started = await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })
    expect(started.body.entrants).toBe(5)
    expect(started.body.rounds).toBe(3)

    const bracket = await bracketOf(keys, cupSlug)
    expect(bracket.entrants[0].handle).toBe(players[0].handle)
    expect(bracket.entrants[0].seed).toBe(1)

    const firstRoundMatches = bracket.bracket.filter((m: any) => m.round === 1)
    expect(firstRoundMatches).toHaveLength(4)
    const byes = firstRoundMatches.filter((m: any) => m.state === 'bye')
    expect(byes).toHaveLength(3)
    // The top seed did not have to play a first round.
    expect(byes.map((m: any) => m.winner)).toContain(players[0].handle)

    // Their byes have already been pushed into round two.
    const secondRound = bracket.bracket.filter((m: any) => m.round === 2)
    const seated = secondRound.flatMap((m: any) => [m.player_a, m.player_b]).filter(Boolean)
    expect(seated).toHaveLength(3)
  })

  it('plays all the way to a champion', async () => {
    const { keys, cupSlug, players } = await cup(4)
    await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })

    let bracket = await bracketOf(keys, cupSlug)
    // Round one: the higher seed wins both.
    for (const match of bracket.bracket.filter((m: any) => m.round === 1)) {
      await report(keys, cupSlug, match.id, match.player_a)
    }

    bracket = await bracketOf(keys, cupSlug)
    const final = bracket.bracket.find((m: any) => m.round === 2)
    expect(final.state).toBe('ready')
    expect(final.player_a).toBe(players[0].handle)

    const decided = await report(keys, cupSlug, final.id, final.player_b)
    expect(decided.body.tournament).toBe('finished')

    const finished = await bracketOf(keys, cupSlug)
    expect(finished.state).toBe('finished')
    // The final decides it, not the seeding.
    expect(finished.champion).toBe(players[1].handle)
  })

  it('refuses a result for a match that is not ready, or already decided', async () => {
    const { keys, cupSlug } = await cup(4)
    await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })
    const bracket = await bracketOf(keys, cupSlug)

    const final = bracket.bracket.find((m: any) => m.round === 2)
    const early = await report(keys, cupSlug, final.id, bracket.entrants[0].handle)
    expect(early.status).toBe(409)
    expect(early.body.error).toContain('waiting')

    const first = bracket.bracket.find((m: any) => m.round === 1)
    await report(keys, cupSlug, first.id, first.player_a)
    const again = await report(keys, cupSlug, first.id, first.player_b)
    expect(again.status).toBe(409)
  })

  it('refuses a winner who was not in the match', async () => {
    const { keys, cupSlug } = await cup(4)
    await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })
    const bracket = await bracketOf(keys, cupSlug)
    const first = bracket.bracket.find((m: any) => m.round === 1)
    const other = bracket.bracket.find((m: any) => m.round === 1 && m.id !== first.id)

    const wrong = await report(keys, cupSlug, first.id, other.player_a)
    expect(wrong.status).toBe(400)
    expect(wrong.body.error).toContain('one of the two players')
    expect((await report(keys, cupSlug, first.id, 'nobody-at-all')).status).toBe(400)
  })

  it('lets nobody join once it has started, and needs two to start at all', async () => {
    const { keys, cupSlug } = await cup(2)
    await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })

    const latecomer = await signup(keys)
    const late = await call(`POST`, `/v1/tournaments/${cupSlug}/join`, {
      key: keys.public_key,
      token: latecomer.token,
    })
    expect(late.status).toBe(409)
    expect((await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })).status).toBe(409)

    const empty = await cup(0)
    const tooSmall = await call(`POST`, `/v1/tournaments/${empty.cupSlug}/start`, {
      key: empty.keys.secret_key,
    })
    expect(tooSmall.status).toBe(409)
  })

  it('keeps out anybody who has not passed the exam', async () => {
    const { keys, cupSlug } = await cup(2, { qualifying_score: 5000 })
    const unqualified = await signup(keys)
    const refused = await call(`POST`, `/v1/tournaments/${cupSlug}/join`, {
      key: keys.public_key,
      token: unqualified.token,
    })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toContain('qualified')
  })

  it('respects the entrant limit', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('d')
    await makeDiscipline(keys, { slug, name: 'D', trust_tier: 1 })
    const cupSlug = unique('small')
    await call('POST', '/v1/tournaments', {
      key: keys.secret_key,
      body: { slug: cupSlug, discipline: slug, max_entrants: 2 },
    })
    for (let i = 0; i < 2; i++) {
      const player = await signup(keys)
      expect((await call(`POST`, `/v1/tournaments/${cupSlug}/join`, { key: keys.public_key, token: player.token })).status).toBe(201)
    }
    const third = await signup(keys)
    const full = await call(`POST`, `/v1/tournaments/${cupSlug}/join`, {
      key: keys.public_key,
      token: third.token,
    })
    expect(full.status).toBe(409)
    expect(full.body.error).toContain('full')
  })

  it('validates the slug, the discipline and refuses a duplicate', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('d')
    await makeDiscipline(keys, { slug, name: 'D', trust_tier: 1 })

    expect((await call('POST', '/v1/tournaments', { key: keys.secret_key, body: { slug: 'no', discipline: slug } })).status).toBe(400)
    expect((await call('POST', '/v1/tournaments', { key: keys.secret_key, body: { slug: unique('x'), discipline: 'nope' } })).status).toBe(404)

    const taken = unique('dup')
    await call('POST', '/v1/tournaments', { key: keys.secret_key, body: { slug: taken, discipline: slug } })
    expect((await call('POST', '/v1/tournaments', { key: keys.secret_key, body: { slug: taken, discipline: slug } })).status).toBe(409)
  })

  it('needs the secret key to create, start or decide', async () => {
    const { keys, cupSlug } = await cup(2)
    expect((await call('POST', '/v1/tournaments', { key: keys.public_key, body: { slug: unique('x'), discipline: 'd' } })).status).toBe(403)
    expect((await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.public_key })).status).toBe(403)
    expect((await call(`POST`, `/v1/tournaments/${cupSlug}/matches/tm_x/result`, { key: keys.public_key, body: { winner: 'x' } })).status).toBe(403)
  })

  it('lists tournaments with their entrant counts and champion', async () => {
    const { keys, cupSlug, players } = await cup(2)
    await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })
    const bracket = await bracketOf(keys, cupSlug)
    await report(keys, cupSlug, bracket.bracket[0].id, players[1].handle)

    const listed = await call('GET', '/v1/tournaments', { key: keys.public_key })
    const row = listed.body.tournaments.find((t: any) => t.slug === cupSlug)
    expect(row.entrants).toBe(2)
    expect(row.state).toBe('finished')
    expect(row.champion).toBe(players[1].handle)
    expect((await call('GET', '/v1/tournaments/not-a-cup', { key: keys.public_key })).status).toBe(404)
  })

  it('handles an eight-player field from first round to champion', async () => {
    const { keys, cupSlug, players } = await cup(8)
    await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })

    for (let round = 1; round <= 3; round++) {
      const bracket = await bracketOf(keys, cupSlug)
      const ready = bracket.bracket.filter((m: any) => m.round === round && m.state === 'ready')
      expect(ready.length, `round ${round}`).toBe(2 ** (3 - round))
      for (const match of ready) await report(keys, cupSlug, match.id, match.player_a)
    }

    const finished = await bracketOf(keys, cupSlug)
    expect(finished.state).toBe('finished')
    // Every higher seed won, so the top seed takes it.
    expect(finished.champion).toBe(players[0].handle)
    expect(finished.bracket.filter((m: any) => m.state === 'done')).toHaveLength(7)
  })
})

describe('Corners of a tournament', () => {
  it('seeds a regional cup from the regional standings', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('regional')
    await makeDiscipline(keys, { slug, name: 'Regional', trust_tier: 1, max_title_level: 2 })

    const players = []
    for (const [value, region] of [[100, 'hh-altona'], [900, 'hh-nord'], [500, 'hh-altona']] as const) {
      const player = await signup(keys)
      await call('PATCH', '/v1/me/region', {
        key: keys.public_key,
        token: player.token,
        body: { region_id: region },
      })
      await call('POST', '/v1/entries', {
        key: keys.public_key,
        token: player.token,
        body: { discipline: slug, value },
      })
      players.push(player)
    }

    const cupSlug = unique('altona-cup')
    await call('POST', '/v1/tournaments', {
      key: keys.secret_key,
      body: { slug: cupSlug, discipline: slug, region: 'hh-altona' },
    })
    for (const player of players)
      await call(`POST`, `/v1/tournaments/${cupSlug}/join`, { key: keys.public_key, token: player.token })

    await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })
    const bracket = await call(`GET`, `/v1/tournaments/${cupSlug}`, { key: keys.public_key })
    // Seeded on the Altona board, so the outsider with the highest global
    // score does not get the top seed.
    expect(bracket.body.entrants[0].handle).toBe(players[2].handle)
    expect(bracket.body.region).toBe('hh-altona')
  })

  it('accepts a winner named by id as well as by handle', async () => {
    const { keys, cupSlug, players } = await cup(2)
    await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })
    const bracket = await bracketOf(keys, cupSlug)
    const decided = await report(keys, cupSlug, bracket.bracket[0].id, players[1].player_id)
    expect(decided.body.tournament).toBe('finished')
  })

  it('refuses to work without an open season, and on an unknown tournament', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('d')
    await makeDiscipline(keys, { slug, name: 'D', trust_tier: 1 })
    await env.DB.prepare(`UPDATE seasons SET status = 'closed'`).run()

    const res = await call('POST', '/v1/tournaments', {
      key: keys.secret_key,
      body: { slug: unique('late'), discipline: slug },
    })
    expect(res.status).toBe(409)

    const player = await signup(keys)
    expect((await call('POST', '/v1/tournaments/nope/join', { key: keys.public_key, token: player.token })).status).toBe(404)
    expect((await call('POST', '/v1/tournaments/nope/start', { key: keys.secret_key })).status).toBe(404)
    expect((await call('POST', '/v1/tournaments/nope/matches/tm_x/result', { key: keys.secret_key, body: { winner: 'x' } })).status).toBe(404)
  })

  it('refuses a result once the tournament is over', async () => {
    const { keys, cupSlug, players } = await cup(2)
    await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })
    const bracket = await bracketOf(keys, cupSlug)
    await report(keys, cupSlug, bracket.bracket[0].id, players[0].handle)

    const late = await report(keys, cupSlug, bracket.bracket[0].id, players[1].handle)
    expect(late.status).toBe(409)
    expect(late.body.error).toContain('finished')
  })

  it('refuses an unknown match inside a real tournament', async () => {
    const { keys, cupSlug } = await cup(2)
    await call(`POST`, `/v1/tournaments/${cupSlug}/start`, { key: keys.secret_key })
    expect((await report(keys, cupSlug, 'tm_nothing', 'x')).status).toBe(404)
  })
})
