import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { call, freshSeason, makeApp, makeDiscipline, signup, unique } from './helpers'

describe('Without an open season', () => {
  async function closedWorld() {
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1 })
    const player = await signup(keys)
    await env.DB.prepare(`UPDATE seasons SET status = 'closed'`).run()
    return { keys, player }
  }

  it('accepts no entries', async () => {
    const { keys, player } = await closedWorld()
    const res = await call('POST', '/v1/entries', {
      key: keys.public_key,
      token: player.token,
      body: { discipline: 'd', value: 1 },
    })
    expect(res.status).toBe(409)
  })

  it('allows neither a challenge nor a home region', async () => {
    const { keys, player } = await closedWorld()
    expect((await call('POST', '/v1/challenges', { key: keys.public_key, token: player.token, body: { discipline: 'd' } })).status).toBe(409)
    expect((await call('PATCH', '/v1/me/region', { key: keys.public_key, token: player.token, body: { region_id: 'hh-altona' } })).status).toBe(409)
  })

  it('returns neither leaderboard nor own standing', async () => {
    const { keys, player } = await closedWorld()
    expect((await call('GET', '/v1/leaderboards/d', { key: keys.public_key })).status).toBe(409)
    expect((await call('GET', '/v1/disciplines/d/me', { key: keys.public_key, token: player.token })).status).toBe(409)
  })

  it('still lets the profile be read', async () => {
    const { keys, player } = await closedWorld()
    const me = await call('GET', '/v1/me', { key: keys.public_key, token: player.token })
    expect(me.status).toBe(200)
    expect(me.body.season).toBe(null)
    expect(me.body.region).toBe(null)
  })
})

describe('Creating regions and seasons', () => {
  it('unlocks a new region and takes it into the leaderboard', async () => {
    await freshSeason()
    const regionId = unique('bezirk')
    const created = await call('POST', '/v1/admin/regions', {
      admin: true,
      body: { id: regionId, parent_id: 'hh-city', level: 1, name: 'Testbezirk' },
    })
    expect(created.status).toBe(201)

    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1 })
    const player = await signup(keys)
    expect((await call('PATCH', '/v1/me/region', { key: keys.public_key, token: player.token, body: { region_id: regionId } })).status).toBe(200)
    await call('POST', '/v1/entries', { key: keys.public_key, token: player.token, body: { discipline: 'd', value: 7 } })

    const bezirk = await call('GET', `/v1/leaderboards/d?region=${regionId}`, { key: keys.public_key })
    expect(bezirk.body.entries).toHaveLength(1)
    // Der neue Bezirk rollt in die Stadt hoch.
    const stadt = await call('GET', '/v1/leaderboards/d?region=hh-city', { key: keys.public_key })
    expect(stadt.body.entries).toHaveLength(1)
  })

  it('creates a season that immediately becomes the current one', async () => {
    await env.DB.prepare(`UPDATE seasons SET status = 'closed'`).run()
    const id = unique('saison')
    const created = await call('POST', '/v1/admin/seasons', {
      admin: true,
      body: { id, name: 'Neue Saison', starts_at: '2099-01-01T00:00:00Z', ends_at: '2099-12-31T00:00:00Z' },
    })
    expect(created.status).toBe(201)
    expect(created.body.status).toBe('open')
    const keys = await makeApp()
    const catalog = await call('GET', '/v1/catalog', { key: keys.public_key })
    expect(catalog.body.season.id).toBe(id)
  })
})

describe('The qualification value is carried along', () => {
  it('raises the stored value when the player improves', async () => {
    await freshSeason()
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1, qualifying_score: 10 })
    const player = await signup(keys)
    await call('POST', '/v1/entries', { key: keys.public_key, token: player.token, body: { discipline: 'd', value: 20 } })
    await call('POST', '/v1/entries', { key: keys.public_key, token: player.token, body: { discipline: 'd', value: 80 } })
    const me = await call('GET', '/v1/me', { key: keys.public_key, token: player.token })
    expect(me.body.qualifications[0].value_at).toBe(80)
  })

  it('does not lower it on a weaker run', async () => {
    await freshSeason()
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1, qualifying_score: 10 })
    const player = await signup(keys)
    await call('POST', '/v1/entries', { key: keys.public_key, token: player.token, body: { discipline: 'd', value: 80 } })
    await call('POST', '/v1/entries', { key: keys.public_key, token: player.token, body: { discipline: 'd', value: 15 } })
    const me = await call('GET', '/v1/me', { key: keys.public_key, token: player.token })
    expect(me.body.qualifications[0].value_at).toBe(80)
  })
})

describe('Error handling', () => {
  it('answers broken JSON with an error instead of a crash', async () => {
    const keys = await makeApp()
    const player = await signup(keys)
    const app = (await import('../src/index')).default
    const res = await app.fetch(
      new Request('https://test.local/v1/entries', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-App-Key': keys.public_key,
          Authorization: `Bearer ${player.token}`,
        },
        body: '{kaputt',
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    )
    expect(res.status).toBe(500)
    const body: any = await res.json()
    expect(body.error).toBe('internal error')
  })

  it('names capabilities in the status', async () => {
    const res = await call('GET', '/v1/status')
    expect(res.body.capabilities).toContain('ratings:glicko2')
    expect(res.body.capabilities).toContain('aggregations:best,sum,count,streak')
  })
})
