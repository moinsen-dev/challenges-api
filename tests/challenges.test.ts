import { describe, expect, it } from 'vitest'
import { call, makeApp, makeDiscipline, signup } from './helpers'

async function arena(disc: Record<string, unknown> = {}) {
  const keys = await makeApp()
  await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1, ...disc })
  const a = await signup(keys)
  const b = await signup(keys)
  const submit = (token: string, value: number) =>
    call('POST', '/v1/entries', { key: keys.public_key, token, body: { discipline: 'd', value } })
  const challenge = (token: string, opponent?: string) =>
    call('POST', '/v1/challenges', {
      key: keys.public_key,
      token,
      body: { discipline: 'd', ...(opponent ? { opponent_handle: opponent } : {}) },
    })
  const accept = (token: string, id: string) =>
    call('POST', `/v1/challenges/${id}/accept`, { key: keys.public_key, token })
  const list = (token: string) => call('GET', '/v1/challenges', { key: keys.public_key, token })
  return { keys, a, b, submit, challenge, accept, list }
}

describe('Creating a challenge', () => {
  it('requires an entry of your own', async () => {
    const { a, challenge } = await arena()
    expect((await challenge(a.token)).status).toBe(409)
  })

  it('takes your own aggregate as the target', async () => {
    const { a, b, submit, challenge } = await arena()
    await submit(a.token, 100)
    await submit(a.token, 130)
    const created = await challenge(a.token, b.handle)
    expect(created.body.target_value).toBe(130)
  })

  it('marks unqualified challenges as unranked', async () => {
    const { a, b, submit, challenge } = await arena({ qualifying_score: 1000 })
    await submit(a.token, 10)
    expect((await challenge(a.token, b.handle)).body.ranked).toBe(false)
  })

  it('rejects unknown opponents and self-challenges', async () => {
    const { a, submit, challenge } = await arena()
    await submit(a.token, 10)
    expect((await challenge(a.token, 'niemand')).status).toBe(404)
    expect((await challenge(a.token, a.handle)).status).toBe(400)
  })
})

describe('Accepting a challenge', () => {
  it('lets only the addressee accept', async () => {
    const { keys, a, b, submit, challenge, accept } = await arena()
    await submit(a.token, 10)
    const dritter = await signup(keys)
    const chl = await challenge(a.token, b.handle)
    expect((await accept(dritter.token, chl.body.id)).status).toBe(403)
    expect((await accept(b.token, chl.body.id)).status).toBe(200)
  })

  it('lets anyone accept an open invitation', async () => {
    const { a, b, submit, challenge, accept } = await arena()
    await submit(a.token, 10)
    const chl = await challenge(a.token)
    expect((await accept(b.token, chl.body.id)).status).toBe(200)
  })

  it('prevents the challenger from accepting', async () => {
    const { a, submit, challenge, accept } = await arena()
    await submit(a.token, 10)
    const chl = await challenge(a.token)
    expect((await accept(a.token, chl.body.id)).status).toBe(400)
  })

  it('does not know unknown challenges', async () => {
    const { a, accept } = await arena()
    expect((await accept(a.token, 'chl_gibtsnicht')).status).toBe(404)
  })
})

describe('Settling a challenge', () => {
  it('counts performance after acceptance only', async () => {
    const { a, b, submit, challenge, accept, list } = await arena()
    await submit(b.token, 500) // Bob ist vorher schon besser
    await submit(a.token, 100)
    const chl = await challenge(a.token, b.handle)
    await accept(b.token, chl.body.id)
    // Ein schwacher Lauf nach der Annahme entscheidet nichts, obwohl Bobs
    // Bestwert das Ziel laengst schlaegt.
    const weak = await submit(b.token, 5)
    expect(weak.body.settled_challenges).toEqual([])
    const strong = await submit(b.token, 101)
    expect(strong.body.settled_challenges).toContain(chl.body.id)
    const entry = (await list(a.token)).body.challenges.find((x: any) => x.id === chl.body.id)
    expect(entry.state).toBe('settled')
    expect(entry.winner).toBe(b.handle)
  })

  it('does not settle an unaccepted challenge', async () => {
    const { a, b, submit, challenge } = await arena()
    await submit(a.token, 100)
    const chl = await challenge(a.token, b.handle)
    const res = await submit(b.token, 9999)
    expect(res.body.settled_challenges).toEqual([])
  })

  it('sums from acceptance on for sum disciplines', async () => {
    const { a, b, submit, challenge, accept } = await arena({ aggregation: 'sum' })
    await submit(a.token, 50)
    const chl = await challenge(a.token, b.handle)
    await accept(b.token, chl.body.id)
    expect((await submit(b.token, 30)).body.settled_challenges).toEqual([])
    expect((await submit(b.token, 25)).body.settled_challenges).toContain(chl.body.id)
  })

  it('lets whoever gets smaller win on asc', async () => {
    const { a, b, submit, challenge, accept } = await arena({ score_direction: 'asc' })
    await submit(a.token, 60)
    const chl = await challenge(a.token, b.handle)
    await accept(b.token, chl.body.id)
    expect((await submit(b.token, 70)).body.settled_challenges).toEqual([])
    expect((await submit(b.token, 59)).body.settled_challenges).toContain(chl.body.id)
  })

  it('rejects accepting an expired challenge', async () => {
    const { a, b, submit, accept, keys } = await arena()
    await submit(a.token, 100)
    const chl = await call('POST', '/v1/challenges', {
      key: keys.public_key,
      token: a.token,
      body: { discipline: 'd', opponent_handle: b.handle, expires_in_hours: -1 },
    })
    expect((await accept(b.token, chl.body.id)).status).toBe(409)
  })

  it('awards expired challenges to the challenger on read', async () => {
    const { a, b, submit, list, keys } = await arena()
    await submit(a.token, 100)
    const chl = await call('POST', '/v1/challenges', {
      key: keys.public_key,
      token: a.token,
      body: { discipline: 'd', opponent_handle: b.handle, expires_in_hours: -1 },
    })
    const listed = await list(a.token)
    const entry = listed.body.challenges.find((x: any) => x.id === chl.body.id)
    expect(entry.state).toBe('expired')
    expect(entry.winner).toBe(a.handle)
  })
})
