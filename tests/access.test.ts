import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { call, freshSeason, makeApp, signup, unique } from './helpers'

const invites = (keys: any, body: Record<string, unknown> = {}) =>
  call('POST', '/v1/invites', { key: keys.secret_key, body })

const join = (keys: any, code?: string, handle = unique('gast')) =>
  call('POST', '/v1/auth/anonymous', {
    key: keys.public_key,
    body: { handle, ...(code ? { invite_code: code } : {}) },
  })

describe('Invites', () => {
  it('creates codes and shows them exactly once', async () => {
    const keys = await makeApp()
    const res = await invites(keys, { count: 3 })
    expect(res.status).toBe(201)
    expect(res.body.codes).toHaveLength(3)
    const stored = await env.DB.prepare(`SELECT code_hash FROM invites`).all<{ code_hash: string }>()
    expect(stored.results.some((r) => res.body.codes.includes(r.code_hash))).toBe(false)
  })

  it('requires the secret key', async () => {
    const keys = await makeApp()
    expect((await call('POST', '/v1/invites', { key: keys.public_key, body: {} })).status).toBe(403)
  })

  it('locks a closed app without a code', async () => {
    const keys = await makeApp()
    await call('PATCH', `/v1/admin/apps/${keys.slug}`, { admin: true, body: { access_mode: 'invite' } })
    expect((await join(keys)).status).toBe(403)
    const code = (await invites(keys)).body.codes[0]
    const drin = await join(keys, code)
    expect(drin.status).toBe(201)
  })

  it('honours a code only as often as allowed', async () => {
    const keys = await makeApp()
    const code = (await invites(keys, { max_uses: 2 })).body.codes[0]
    expect((await join(keys, code)).status).toBe(201)
    expect((await join(keys, code)).status).toBe(201)
    expect((await join(keys, code)).status).toBe(409)
  })

  it('rejects unknown and expired codes', async () => {
    const keys = await makeApp()
    expect((await join(keys, 'GIBTS-NICHT')).status).toBe(404)
    const code = (await invites(keys, { expires_in_days: -1 })).body.codes[0]
    expect((await join(keys, code)).status).toBe(409)
  })

  it('sets the district from the invite right away', async () => {
    await freshSeason()
    const keys = await makeApp()
    const code = (await invites(keys, { region_id: 'hh-altona' })).body.codes[0]
    const gast = await join(keys, code)
    const me = await call('GET', '/v1/me', { key: keys.public_key, token: gast.body.token })
    expect(me.body.region.id).toBe('hh-altona')
  })

  it('gives players their own allowance and remembers who brought whom', async () => {
    const keys = await makeApp()
    await call('PATCH', `/v1/admin/apps/${keys.slug}`, { admin: true, body: { invites_per_player: 2 } })
    const werber = await signup(keys)

    const stand = await call('GET', '/v1/me/invites', { key: keys.public_key, token: werber.token })
    expect(stand.body.invites_left).toBe(2)

    const eigener = await call('POST', '/v1/me/invites', { key: keys.public_key, token: werber.token })
    expect(eigener.status).toBe(201)
    expect(eigener.body.invites_left).toBe(1)

    const geworben = await join(keys, eigener.body.code)
    expect(geworben.body.invited_by).toBe(werber.player_id)
    const danach = await call('GET', '/v1/me/invites', { key: keys.public_key, token: werber.token })
    expect(danach.body.joined_through_you).toBe(1)
    expect(danach.body.outstanding).toBe(0)
  })

  it('gives nothing from an empty allowance', async () => {
    const keys = await makeApp()
    const player = await signup(keys)
    expect((await call('POST', '/v1/me/invites', { key: keys.public_key, token: player.token })).status).toBe(409)
  })

  it('tells the inviter about the redemption', async () => {
    const keys = await makeApp()
    await call('PATCH', `/v1/admin/apps/${keys.slug}`, { admin: true, body: { invites_per_player: 1 } })
    const werber = await signup(keys)
    const code = (await call('POST', '/v1/me/invites', { key: keys.public_key, token: werber.token })).body.code
    await join(keys, code)
    const events = await call('GET', '/v1/events', { key: keys.public_key, token: werber.token })
    expect(events.body.events.some((e: any) => e.type === 'invite.redeemed')).toBe(true)
  })

  it('shows the operator the invites handed out', async () => {
    const keys = await makeApp()
    await invites(keys, { count: 2, note: 'Pilotgruppe' })
    const list = await call('GET', '/v1/admin/invites', { admin: true })
    expect(list.body.invites.some((i: any) => i.note === 'Pilotgruppe' && i.app === keys.slug)).toBe(true)
  })
})

describe('Waitlists', () => {
  async function closedRegion(threshold: number) {
    const regionId = unique('bezirk')
    await call('POST', '/v1/admin/regions', {
      admin: true,
      body: { id: regionId, parent_id: 'hh-city', level: 1, name: 'Neuland', active: false, unlock_threshold: threshold },
    })
    return regionId
  }

  it('takes people in and counts how many are still missing', async () => {
    await freshSeason()
    const keys = await makeApp()
    const region = await closedRegion(3)
    const player = await signup(keys)

    const res = await call('POST', `/v1/waitlist/${region}`, { key: keys.public_key, token: player.token })
    expect(res.status).toBe(201)
    expect(res.body.waiting).toBe(1)
    expect(res.body.missing).toBe(2)
    expect(res.body.opened).toBe(false)

    // Solange die Region zu ist, kann sie niemand als Heimat waehlen.
    expect((await call('PATCH', '/v1/me/region', { key: keys.public_key, token: player.token, body: { region_id: region } })).status).toBe(404)
  })

  it('counts the same player only once', async () => {
    const keys = await makeApp()
    const region = await closedRegion(5)
    const player = await signup(keys)
    await call('POST', `/v1/waitlist/${region}`, { key: keys.public_key, token: player.token })
    const zweite = await call('POST', `/v1/waitlist/${region}`, { key: keys.public_key, token: player.token })
    expect(zweite.body.waiting).toBe(1)
  })

  it('opens the region itself once the threshold is reached', async () => {
    await freshSeason()
    const keys = await makeApp()
    const region = await closedRegion(3)
    const wartende = []
    for (let i = 0; i < 3; i++) {
      const p = await signup(keys)
      wartende.push(p)
      var res = await call('POST', `/v1/waitlist/${region}`, { key: keys.public_key, token: p.token })
    }
    expect(res!.body.opened).toBe(true)

    // Alle Wartenden erfahren davon, und die Region ist waehlbar.
    for (const p of wartende) {
      const events = await call('GET', '/v1/events', { key: keys.public_key, token: p.token })
      expect(events.body.events.some((e: any) => e.type === 'region.opened' && e.payload.region === region)).toBe(true)
    }
    expect((await call('PATCH', '/v1/me/region', { key: keys.public_key, token: wartende[0].token, body: { region_id: region } })).status).toBe(200)
    expect((await call('POST', `/v1/waitlist/${region}`, { key: keys.public_key, token: wartende[0].token })).status).toBe(409)
  })

  it('never opens on its own without a threshold, but does on command', async () => {
    const keys = await makeApp()
    const region = await closedRegion(0)
    const player = await signup(keys)
    const res = await call('POST', `/v1/waitlist/${region}`, { key: keys.public_key, token: player.token })
    expect(res.body.opened).toBe(false)

    const unlocked = await call('POST', `/v1/admin/regions/${region}/unlock`, { admin: true })
    expect(unlocked.body.notified).toBe(1)
    expect((await call('POST', `/v1/admin/regions/${region}/unlock`, { admin: true })).status).toBe(409)
    expect((await call('POST', '/v1/admin/regions/gibtsnicht/unlock', { admin: true })).status).toBe(404)
  })

  it('lists closed regions by demand', async () => {
    const keys = await makeApp()
    const gefragt = await closedRegion(10)
    const ungefragt = await closedRegion(10)
    const player = await signup(keys)
    await call('POST', `/v1/waitlist/${gefragt}`, { key: keys.public_key, token: player.token })

    const list = await call('GET', '/v1/waitlist', { key: keys.public_key })
    const erste = list.body.regions.find((r: any) => r.id === gefragt)
    const zweite = list.body.regions.find((r: any) => r.id === ungefragt)
    expect(erste.waiting).toBe(1)
    expect(erste.missing).toBe(9)
    expect(zweite.waiting).toBe(0)
    expect(list.body.regions.indexOf(erste)).toBeLessThan(list.body.regions.indexOf(zweite))
  })

  it('does not know unknown regions', async () => {
    const keys = await makeApp()
    const player = await signup(keys)
    expect((await call('POST', '/v1/waitlist/atlantis', { key: keys.public_key, token: player.token })).status).toBe(404)
  })
})
