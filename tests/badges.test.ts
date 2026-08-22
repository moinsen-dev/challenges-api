import { describe, expect, it } from 'vitest'
import { call, freshSeason, makeApp, makeDiscipline, signup, unique } from './helpers'

/** Plattformweites Badge: wird in jeder App ausgewertet. */
const platformBadge = (rule: unknown, id = unique('badge')) =>
  call('POST', '/v1/admin/badges', {
    admin: true,
    body: { id, name: id, description: 'Test', rule },
  }).then(() => id)

/** App-eigenes Badge: wird nur ausgewertet, solange der Spieler in dieser App handelt. */
const badge = (keys: any, rule: unknown, id = unique('badge')) =>
  call('POST', '/v1/badges', {
    key: keys.secret_key,
    body: { id, name: id, description: 'Test', rule },
  }).then(() => id)

const submit = (keys: any, token: string, discipline: string, value: number, extra = {}) =>
  call('POST', '/v1/entries', { key: keys.public_key, token, body: { discipline, value, ...extra } })

const badgesOf = async (keys: any, token: string) =>
  (await call('GET', '/v1/me', { key: keys.public_key, token })).body.badges.map((b: any) => b.id)

describe('Badge rules', () => {
  it('qualified_in_n_apps counts apps, not disciplines', async () => {
    await freshSeason()
    const a = await makeApp()
    const b = await makeApp()
    // Eine app-uebergreifende Regel gehoert an ein plattformweites Badge —
    // ein App-Badge wird nur ausgewertet, wenn der Spieler in dieser App handelt.
    const id = await platformBadge({ type: 'qualified_in_n_apps', n: 2 })
    await makeDiscipline(a, { slug: 'x', name: 'X', trust_tier: 1, qualifying_score: 10 })
    await makeDiscipline(a, { slug: 'y', name: 'Y', trust_tier: 1, qualifying_score: 10 })
    await makeDiscipline(b, { slug: 'z', name: 'Z', trust_tier: 1, qualifying_score: 10 })
    const player = await signup(a)

    await submit(a, player.token, 'x', 50)
    await submit(a, player.token, 'y', 50)
    expect(await badgesOf(a, player.token)).not.toContain(id)
    // Zwei Disziplinen in einer App reichen nicht — es braucht die zweite App.
    await submit(b, player.token, 'z', 50)
    expect(await badgesOf(a, player.token)).toContain(id)
  })

  it('qualified_in_category demands every discipline in the category', async () => {
    await freshSeason()
    const keys = await makeApp()
    const category = unique('kat')
    const id = await badge(keys, { type: 'qualified_in_category', category })
    await makeDiscipline(keys, { slug: 'a', name: 'A', category, trust_tier: 1, qualifying_score: 10 })
    await makeDiscipline(keys, { slug: 'b', name: 'B', category, trust_tier: 1, qualifying_score: 10 })
    const player = await signup(keys)
    await submit(keys, player.token, 'a', 50)
    expect(await badgesOf(keys, player.token)).not.toContain(id)
    await submit(keys, player.token, 'b', 50)
    expect(await badgesOf(keys, player.token)).toContain(id)
  })

  it('discipline_mastery honours the score direction', async () => {
    await freshSeason()
    const keys = await makeApp()
    const id = await badge(keys, { type: 'discipline_mastery', factor: 2 })
    await makeDiscipline(keys, {
      slug: 'schnell', name: 'Schnell', trust_tier: 1,
      score_direction: 'asc', qualifying_score: 60,
    })
    const knapp = await signup(keys)
    await submit(keys, knapp.token, 'schnell', 45)
    expect(await badgesOf(keys, knapp.token)).not.toContain(id)
    const meister = await signup(keys)
    // Bei asc ist das Doppelte die Haelfte der Zeit.
    await submit(keys, meister.token, 'schnell', 29)
    expect(await badgesOf(keys, meister.token)).toContain(id)
  })

  it('streak_days demands consecutive days', async () => {
    await freshSeason()
    const keys = await makeApp()
    const id = await badge(keys, { type: 'streak_days', days: 3 })
    await makeDiscipline(keys, { slug: 'tag', name: 'Tag', trust_tier: 1, aggregation: 'streak' })
    const player = await signup(keys)
    const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString()
    await submit(keys, player.token, 'tag', 1, { occurred_at: day(-5) })
    await submit(keys, player.token, 'tag', 1, { occurred_at: day(-3) })
    expect(await badgesOf(keys, player.token)).not.toContain(id)
    await submit(keys, player.token, 'tag', 1, { occurred_at: day(-2) })
    await submit(keys, player.token, 'tag', 1, { occurred_at: day(-1) })
    expect(await badgesOf(keys, player.token)).toContain(id)
  })

  it('active_on_n_days counts distinct days', async () => {
    await freshSeason()
    const keys = await makeApp()
    const id = await badge(keys, { type: 'active_on_n_days', n: 3 })
    await makeDiscipline(keys, { slug: 'tag', name: 'Tag', trust_tier: 1 })
    const player = await signup(keys)
    const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString()
    await submit(keys, player.token, 'tag', 1, { occurred_at: day(-9) })
    await submit(keys, player.token, 'tag', 1, { occurred_at: day(-9) })
    await submit(keys, player.token, 'tag', 1, { occurred_at: day(-4) })
    expect(await badgesOf(keys, player.token)).not.toContain(id)
    await submit(keys, player.token, 'tag', 1, { occurred_at: day(-1) })
    expect(await badgesOf(keys, player.token)).toContain(id)
  })

  it('total_at_least sums regardless of the aggregation', async () => {
    await freshSeason()
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'km', name: 'KM', trust_tier: 1, aggregation: 'best' })
    const id = await badge(keys, { type: 'total_at_least', discipline: `${keys.slug}/km`, value: 100 })
    const player = await signup(keys)
    await submit(keys, player.token, 'km', 60)
    expect(await badgesOf(keys, player.token)).not.toContain(id)
    await submit(keys, player.token, 'km', 50)
    expect(await badgesOf(keys, player.token)).toContain(id)
  })

  it('combines rules with all_of and any_of', async () => {
    await freshSeason()
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'a', name: 'A', trust_tier: 1, qualifying_score: 10 })
    const beides = await badge(keys, {
      type: 'all_of',
      rules: [
        { type: 'total_at_least', discipline: `${keys.slug}/a`, value: 10 },
        { type: 'active_on_n_days', n: 2 },
      ],
    })
    const eines = await badge(keys, {
      type: 'any_of',
      rules: [
        { type: 'total_at_least', discipline: `${keys.slug}/a`, value: 10 },
        { type: 'active_on_n_days', n: 99 },
      ],
    })
    const player = await signup(keys)
    await submit(keys, player.token, 'a', 50)
    const nachEinemTag = await badgesOf(keys, player.token)
    expect(nachEinemTag).toContain(eines)
    expect(nachEinemTag).not.toContain(beides)
    await submit(keys, player.token, 'a', 5, { occurred_at: new Date(Date.now() - 86400000).toISOString() })
    expect(await badgesOf(keys, player.token)).toContain(beides)
  })

  it('stays quiet on an unknown discipline or collection', async () => {
    await freshSeason()
    const keys = await makeApp()
    const id = await badge(keys, { type: 'total_at_least', discipline: 'gibtsnicht/auch-nicht', value: 1 })
    const id2 = await badge(keys, { type: 'collection_complete', collection: 'gibtsnicht/auch-nicht' })
    await makeDiscipline(keys, { slug: 'a', name: 'A', trust_tier: 1 })
    const player = await signup(keys)
    const res = await submit(keys, player.token, 'a', 1)
    expect(res.status).toBe(201)
    const held = await badgesOf(keys, player.token)
    expect(held).not.toContain(id)
    expect(held).not.toContain(id2)
  })

  it('awards a badge only once', async () => {
    await freshSeason()
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'a', name: 'A', trust_tier: 1 })
    const id = await badge(keys, { type: 'active_on_n_days', n: 1 })
    const player = await signup(keys)
    const first = await submit(keys, player.token, 'a', 1)
    const second = await submit(keys, player.token, 'a', 2)
    expect(first.body.badges_earned.map((b: any) => b.id)).toContain(id)
    expect(second.body.badges_earned).toEqual([])
    expect((await badgesOf(keys, player.token)).filter((b: string) => b === id)).toHaveLength(1)
  })

  it('keeps app badges away from other apps', async () => {
    await freshSeason()
    const a = await makeApp()
    const b = await makeApp()
    const id = await badge(a, { type: 'active_on_n_days', n: 1 })
    await makeDiscipline(b, { slug: 'x', name: 'X', trust_tier: 1 })
    const player = await signup(b)
    const res = await submit(b, player.token, 'x', 1)
    expect(res.body.badges_earned.map((x: any) => x.id)).not.toContain(id)
  })
})

describe('Collections', () => {
  async function collection() {
    const keys = await makeApp()
    const slug = unique('sammlung')
    await call('POST', '/v1/collections', { key: keys.secret_key, body: { slug, name: 'Sammlung' } })
    await call('POST', `/v1/collections/${slug}/items`, {
      key: keys.secret_key,
      body: { items: [{ slug: 'eins', name: 'Eins' }, { slug: 'zwei', name: 'Zwei', rarity: 'rare' }] },
    })
    const player = await signup(keys)
    const grant = (item: string) =>
      call('POST', `/v1/collections/${slug}/grant`, {
        key: keys.secret_key,
        body: { handle: player.handle, item },
      })
    const read = () => call('GET', `/v1/collections/${slug}`, { key: keys.public_key, token: player.token })
    return { keys, slug, player, grant, read }
  }

  it('shows holdings and completeness', async () => {
    const { grant, read } = await collection()
    const leer = await read()
    expect(leer.body.total).toBe(2)
    expect(leer.body.owned).toBe(0)
    expect(leer.body.complete).toBe(false)
    await grant('eins')
    expect((await read()).body.owned).toBe(1)
    await grant('zwei')
    const voll = await read()
    expect(voll.body.owned).toBe(2)
    expect(voll.body.complete).toBe(true)
  })

  it('stacks duplicate grants without doubling the holdings', async () => {
    const { grant, read } = await collection()
    await grant('eins')
    await grant('eins')
    const body = (await read()).body
    expect(body.owned).toBe(1)
    expect(body.items.find((i: any) => i.slug === 'eins').owned).toBe(2)
  })

  it('rejects unknown items, players and collections', async () => {
    const { keys, slug, player, grant } = await collection()
    expect((await grant('gibtsnicht')).status).toBe(404)
    const fremd = await call('POST', `/v1/collections/${slug}/grant`, {
      key: keys.secret_key,
      body: { handle: 'niemand', item: 'eins' },
    })
    expect(fremd.status).toBe(404)
    expect((await call('GET', '/v1/collections/gibtsnicht', { key: keys.public_key, token: player.token })).status).toBe(404)
    expect((await call('POST', '/v1/collections/gibtsnicht/items', { key: keys.secret_key, body: { items: [] } })).status).toBe(404)
  })

  it('awards a badge on a complete collection', async () => {
    const { keys, slug, grant } = await collection()
    const id = await badge(keys, { type: 'collection_complete', collection: `${keys.slug}/${slug}` })
    await grant('eins')
    const letzte = await grant('zwei')
    expect(letzte.body.badges_earned.map((b: any) => b.id)).toContain(id)
  })
})
