import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { call, freshSeason, makeApp, makeDiscipline, signup, unique } from './helpers'

async function arena() {
  await freshSeason()
  const keys = await makeApp()
  await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1 })
  const a = await signup(keys)
  const b = await signup(keys)
  const submit = (token: string, value: number) =>
    call('POST', '/v1/entries', { key: keys.public_key, token, body: { discipline: 'd', value } })
  return { keys, a, b, submit }
}

describe('Profile', () => {
  it('sets display name, locale and avatar', async () => {
    const { keys, a } = await arena()
    const res = await call('PATCH', '/v1/me/profile', {
      key: keys.public_key,
      token: a.token,
      body: { display_name: 'Die Schnelle', locale: 'de-DE', avatar: 'fuchs' },
    })
    expect(res.status).toBe(200)
    expect(res.body.display_name).toBe('Die Schnelle')
    const me = await call('GET', '/v1/me', { key: keys.public_key, token: a.token })
    expect(me.body.player.locale).toBe('de-DE')
  })

  it('limits the display name and demands an actual change', async () => {
    const { keys, a } = await arena()
    expect((await call('PATCH', '/v1/me/profile', { key: keys.public_key, token: a.token, body: { display_name: 'x'.repeat(41) } })).status).toBe(400)
    expect((await call('PATCH', '/v1/me/profile', { key: keys.public_key, token: a.token, body: {} })).status).toBe(400)
  })

  it('lets you feature only what you own', async () => {
    const { keys, a } = await arena()
    const fremd = await call('PATCH', '/v1/me/profile', {
      key: keys.public_key,
      token: a.token,
      body: { featured_badge: 'journeyman' },
    })
    expect(fremd.status).toBe(403)
    expect((await call('PATCH', '/v1/me/profile', { key: keys.public_key, token: a.token, body: { featured_title: 'ttl_erfunden' } })).status).toBe(403)
  })

  it('shows an owned badge on the public profile', async () => {
    const { keys, a } = await arena()
    await env.DB.prepare(`INSERT INTO player_badges (player_id, badge_id, earned_at) VALUES (?, 'journeyman', ?)`)
      .bind(a.player_id, new Date().toISOString())
      .run()
    const set = await call('PATCH', '/v1/me/profile', {
      key: keys.public_key,
      token: a.token,
      body: { featured_badge: 'journeyman', display_name: 'Meisterin' },
    })
    expect(set.status).toBe(200)
    const oeffentlich = await call('GET', `/v1/players/${a.handle}`, { key: keys.public_key })
    expect(oeffentlich.body.featured_badge).toBe('journeyman')
    expect(oeffentlich.body.display_name).toBe('Meisterin')
  })
})

describe('Changing a handle', () => {
  it('changes once and locks afterwards', async () => {
    const { keys, a } = await arena()
    const neu = unique('neuername')
    const res = await call('PATCH', '/v1/me/handle', { key: keys.public_key, token: a.token, body: { handle: neu } })
    expect(res.status).toBe(200)
    expect((await call('GET', `/v1/players/${neu}`, { key: keys.public_key })).status).toBe(200)
    const zweite = await call('PATCH', '/v1/me/handle', { key: keys.public_key, token: a.token, body: { handle: unique('nochmal') } })
    expect(zweite.status).toBe(409)
    expect(zweite.body.next_change).toBeDefined()
  })

  it('rejects taken and too-short handles', async () => {
    const { keys, a, b } = await arena()
    expect((await call('PATCH', '/v1/me/handle', { key: keys.public_key, token: a.token, body: { handle: b.handle } })).status).toBe(409)
    expect((await call('PATCH', '/v1/me/handle', { key: keys.public_key, token: a.token, body: { handle: 'ab' } })).status).toBe(400)
  })
})

describe('Rivals', () => {
  it('follows, lists and unfollows', async () => {
    const { keys, a, b } = await arena()
    expect((await call('POST', `/v1/me/follows/${b.handle}`, { key: keys.public_key, token: a.token })).status).toBe(201)
    const list = await call('GET', '/v1/me/follows', { key: keys.public_key, token: a.token })
    expect(list.body.follows.map((f: any) => f.handle)).toContain(b.handle)
    expect((await call('DELETE', `/v1/me/follows/${b.handle}`, { key: keys.public_key, token: a.token })).status).toBe(200)
    expect((await call('DELETE', `/v1/me/follows/${b.handle}`, { key: keys.public_key, token: a.token })).status).toBe(404)
  })

  it('follows neither yourself nor strangers', async () => {
    const { keys, a } = await arena()
    expect((await call('POST', `/v1/me/follows/${a.handle}`, { key: keys.public_key, token: a.token })).status).toBe(400)
    expect((await call('POST', '/v1/me/follows/niemand', { key: keys.public_key, token: a.token })).status).toBe(404)
  })

  it('shows a leaderboard among rivals only', async () => {
    const { keys, a, b, submit } = await arena()
    const fremd = await signup(keys)
    await submit(a.token, 10)
    await submit(b.token, 20)
    await submit(fremd.token, 30)
    await call('POST', `/v1/me/follows/${b.handle}`, { key: keys.public_key, token: a.token })

    const alle = await call('GET', '/v1/leaderboards/d', { key: keys.public_key })
    expect(alle.body.entries).toHaveLength(3)
    const rivalen = await call('GET', '/v1/leaderboards/d?scope=friends', { key: keys.public_key, token: a.token })
    expect(rivalen.body.scope).toBe('friends')
    // Man selbst zaehlt mit, der Fremde nicht.
    expect(rivalen.body.entries.map((e: any) => e.handle).sort()).toEqual([a.handle, b.handle].sort())
    expect((await call('GET', '/v1/leaderboards/d?scope=friends', { key: keys.public_key })).status).toBe(401)
  })
})

describe('Blocks between people', () => {
  it('prevents challenges in both directions', async () => {
    const { keys, a, b, submit } = await arena()
    await submit(a.token, 10)
    await submit(b.token, 10)
    await call('POST', `/v1/me/blocks/${b.handle}`, { key: keys.public_key, token: a.token })
    expect((await call('POST', '/v1/challenges', { key: keys.public_key, token: a.token, body: { discipline: 'd', opponent_handle: b.handle } })).status).toBe(403)
    expect((await call('POST', '/v1/challenges', { key: keys.public_key, token: b.token, body: { discipline: 'd', opponent_handle: a.handle } })).status).toBe(403)
  })

  it('ends existing challenges and rivalries', async () => {
    const { keys, a, b, submit } = await arena()
    await submit(a.token, 10)
    await call('POST', `/v1/me/follows/${b.handle}`, { key: keys.public_key, token: a.token })
    const chl = await call('POST', '/v1/challenges', { key: keys.public_key, token: a.token, body: { discipline: 'd', opponent_handle: b.handle } })
    await call('POST', `/v1/me/blocks/${b.handle}`, { key: keys.public_key, token: a.token })

    const listed = await call('GET', '/v1/challenges', { key: keys.public_key, token: a.token })
    expect(listed.body.challenges.find((x: any) => x.id === chl.body.id).state).toBe('expired')
    expect((await call('GET', '/v1/me/follows', { key: keys.public_key, token: a.token })).body.follows).toHaveLength(0)
  })

  it('hides blocked people from search, in both directions', async () => {
    const { keys } = await arena()
    // Eigene, seltene Praefixe: sonst schneidet das Suchlimit die Probe ab.
    const a = await signup(keys, unique('zwietracht'))
    const b = await signup(keys, unique('zwietracht'))
    await call('POST', `/v1/me/blocks/${b.handle}`, { key: keys.public_key, token: a.token })
    const suchtA = await call('GET', `/v1/players?q=${b.handle.slice(0, 6)}`, { key: keys.public_key, token: a.token })
    expect(suchtA.body.players.map((p: any) => p.handle)).not.toContain(b.handle)
    const suchtB = await call('GET', `/v1/players?q=${a.handle.slice(0, 6)}`, { key: keys.public_key, token: b.token })
    expect(suchtB.body.players.map((p: any) => p.handle)).not.toContain(a.handle)
    // Ohne Anmeldung bleibt die Suche unveraendert.
    const anonym = await call('GET', `/v1/players?q=${b.handle.slice(0, 6)}`, { key: keys.public_key })
    expect(anonym.body.players.map((p: any) => p.handle)).toContain(b.handle)
  })

  it('leaves the leaderboard untouched', async () => {
    const { keys, a, b, submit } = await arena()
    await submit(a.token, 10)
    await submit(b.token, 20)
    await call('POST', `/v1/me/blocks/${b.handle}`, { key: keys.public_key, token: a.token })
    // Eine Sperre ist kein Werkzeug, um Ergebnisse verschwinden zu lassen.
    const board = await call('GET', '/v1/leaderboards/d', { key: keys.public_key })
    expect(board.body.entries.map((e: any) => e.handle)).toContain(b.handle)
  })

  it('lists and lifts blocks', async () => {
    const { keys, a, b } = await arena()
    await call('POST', `/v1/me/blocks/${b.handle}`, { key: keys.public_key, token: a.token })
    expect((await call('GET', '/v1/me/blocks', { key: keys.public_key, token: a.token })).body.blocks).toHaveLength(1)
    expect((await call('DELETE', `/v1/me/blocks/${b.handle}`, { key: keys.public_key, token: a.token })).status).toBe(200)
    expect((await call('GET', '/v1/me/blocks', { key: keys.public_key, token: a.token })).body.blocks).toHaveLength(0)
    expect((await call('DELETE', `/v1/me/blocks/${b.handle}`, { key: keys.public_key, token: a.token })).status).toBe(404)
  })
})

describe('Reports and moderation', () => {
  it('reports once per reporter and subject', async () => {
    const { keys, a, b } = await arena()
    const first = await call('POST', '/v1/reports', { key: keys.public_key, token: a.token, body: { handle: b.handle, reason: 'handle', detail: 'anstoessig' } })
    expect(first.status).toBe(201)
    const zweite = await call('POST', '/v1/reports', { key: keys.public_key, token: a.token, body: { handle: b.handle, reason: 'handle' } })
    expect(zweite.status).toBe(409)
  })

  it('validates reason and subject', async () => {
    const { keys, a, b } = await arena()
    expect((await call('POST', '/v1/reports', { key: keys.public_key, token: a.token, body: { handle: b.handle, reason: 'quatsch' } })).status).toBe(400)
    expect((await call('POST', '/v1/reports', { key: keys.public_key, token: a.token, body: { handle: 'niemand', reason: 'handle' } })).status).toBe(404)
    expect((await call('POST', '/v1/reports', { key: keys.public_key, token: a.token, body: { handle: a.handle, reason: 'handle' } })).status).toBe(400)
  })

  it('renames on decision', async () => {
    const { keys, a, b } = await arena()
    const report = await call('POST', '/v1/reports', { key: keys.public_key, token: a.token, body: { handle: b.handle, reason: 'handle' } })
    const queue = await call('GET', '/v1/admin/reports', { admin: true })
    expect(queue.body.reports.some((r: any) => r.id === report.body.id)).toBe(true)

    const resolved = await call('POST', `/v1/admin/reports/${report.body.id}/resolve`, { admin: true, body: { action: 'rename' } })
    expect(resolved.status).toBe(200)
    expect(resolved.body.handle).toMatch(/^spieler-/)
    expect((await call('GET', `/v1/players/${b.handle}`, { key: keys.public_key })).status).toBe(404)
    expect((await call('GET', `/v1/players/${resolved.body.handle}`, { key: keys.public_key })).status).toBe(200)
    // Ein zweites Mal geht nicht.
    expect((await call('POST', `/v1/admin/reports/${report.body.id}/resolve`, { admin: true, body: { action: 'none' } })).status).toBe(409)
  })

  it('suspends for a time and lets the suspension expire', async () => {
    const { keys, a, b, submit } = await arena()
    const report = await call('POST', '/v1/reports', { key: keys.public_key, token: a.token, body: { handle: b.handle, reason: 'cheating' } })
    await call('POST', `/v1/admin/reports/${report.body.id}/resolve`, { admin: true, body: { action: 'suspend', days: 3, reason: 'Verdacht' } })

    const gesperrt = await submit(b.token, 10)
    expect(gesperrt.status).toBe(403)
    expect((await call('GET', '/v1/me', { key: keys.public_key, token: b.token })).status).toBe(200)

    // Zeit vorspulen: die Sperre hebt sich beim naechsten Zugriff selbst auf.
    await env.DB.prepare(`UPDATE players SET status_until = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), b.player_id)
      .run()
    expect((await submit(b.token, 10)).status).toBe(201)
  })

  it('removes a banned player from leaderboards and profiles', async () => {
    const { keys, a, b, submit } = await arena()
    await submit(a.token, 10)
    await submit(b.token, 99)
    expect((await call('GET', '/v1/leaderboards/d', { key: keys.public_key })).body.entries).toHaveLength(2)

    await call('POST', `/v1/admin/players/${b.handle}/status`, { admin: true, body: { status: 'banned', reason: 'Betrug' } })
    const board = await call('GET', '/v1/leaderboards/d', { key: keys.public_key })
    expect(board.body.entries.map((e: any) => e.handle)).toEqual([a.handle])
    expect((await call('GET', `/v1/players/${b.handle}`, { key: keys.public_key })).status).toBe(404)
    expect((await submit(b.token, 5)).status).toBe(403)

    // Umkehrbar: das Ledger blieb unangetastet.
    await call('POST', `/v1/admin/players/${b.handle}/status`, { admin: true, body: { status: 'active' } })
    expect((await call('GET', '/v1/leaderboards/d', { key: keys.public_key })).body.entries).toHaveLength(2)
  })

  it('rejects unknown reports, players and actions', async () => {
    expect((await call('POST', '/v1/admin/reports/rep_erfunden/resolve', { admin: true, body: { action: 'none' } })).status).toBe(404)
    expect((await call('POST', '/v1/admin/players/niemand/status', { admin: true, body: { status: 'banned' } })).status).toBe(404)
    const { keys, a, b } = await arena()
    const report = await call('POST', '/v1/reports', { key: keys.public_key, token: a.token, body: { handle: b.handle, reason: 'other' } })
    expect((await call('POST', `/v1/admin/reports/${report.body.id}/resolve`, { admin: true, body: { action: 'loeschen' } })).status).toBe(400)
    expect((await call('POST', `/v1/admin/players/${b.handle}/status`, { admin: true, body: { status: 'erfunden' } })).status).toBe(400)
  })
})
