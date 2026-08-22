import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { call, freshSeason, makeApp, makeDiscipline, signup } from './helpers'

describe('Export and deletion', () => {
  async function busyPlayer() {
    await freshSeason()
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1, qualifying_score: 5 })
    const player = await signup(keys)
    const gegner = await signup(keys)
    await call('PATCH', '/v1/me/region', { key: keys.public_key, token: player.token, body: { region_id: 'hh-altona' } })
    await call('POST', '/v1/entries', { key: keys.public_key, token: player.token, body: { discipline: 'd', value: 50 } })
    await call('POST', '/v1/challenges', { key: keys.public_key, token: player.token, body: { discipline: 'd', opponent_handle: gegner.handle } })
    await call('POST', '/v1/me/link-code', { key: keys.public_key, token: player.token })
    return { keys, player, gegner }
  }

  it('returns every table in the export', async () => {
    const { keys, player } = await busyPlayer()
    const res = await call('GET', '/v1/me/export', { key: keys.public_key, token: player.token })
    expect(res.status).toBe(200)
    for (const key of ['player', 'entries', 'qualifications', 'regions', 'titles', 'badges', 'items', 'ratings', 'matches', 'challenges', 'apps', 'events']) {
      expect(res.body, key).toHaveProperty(key)
    }
    expect(res.body.entries).toHaveLength(1)
    expect(res.body.regions).toHaveLength(1)
    expect(res.body.challenges).toHaveLength(1)
  })

  it('deletes everything and makes the token worthless', async () => {
    const { keys, player } = await busyPlayer()
    const del = await call('DELETE', '/v1/me', { key: keys.public_key, token: player.token })
    expect(del.status).toBe(200)
    expect((await call('GET', '/v1/me', { key: keys.public_key, token: player.token })).status).toBe(401)
    expect((await call('GET', `/v1/players/${player.handle}`, { key: keys.public_key })).status).toBe(404)

    for (const table of ['entries', 'qualifications', 'player_regions', 'player_apps', 'sessions', 'link_codes', 'events', 'player_badges', 'challenge_entries']) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE player_id = ?`)
        .bind(player.player_id)
        .first<{ n: number }>()
      expect(row!.n, table).toBe(0)
    }
    const chl = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM challenges WHERE challenger_id = ? OR opponent_id = ?`,
    )
      .bind(player.player_id, player.player_id)
      .first<{ n: number }>()
    expect(chl!.n).toBe(0)
  })

  it('frees the handle again after deletion', async () => {
    const { keys, player } = await busyPlayer()
    await call('DELETE', '/v1/me', { key: keys.public_key, token: player.token })
    const neu = await call('POST', '/v1/auth/anonymous', { key: keys.public_key, body: { handle: player.handle } })
    expect(neu.status).toBe(201)
  })
})

describe('Retention limits', () => {
  it('purges used codes, old events and old sessions', async () => {
    const keys = await makeApp()
    const player = await signup(keys)
    const code = await call('POST', '/v1/me/link-code', { key: keys.public_key, token: player.token })
    await call('POST', '/v1/auth/redeem', { key: keys.public_key, body: { code: code.body.code } })

    const alt = new Date(Date.now() - 400 * 86400000).toISOString()
    await env.DB.prepare(`UPDATE events SET created_at = ? WHERE player_id = ?`).bind(alt, player.player_id).run()
    const uralt = new Date(Date.now() - 800 * 86400000).toISOString()
    await env.DB.prepare(`UPDATE sessions SET last_seen = ? WHERE player_id = ?`).bind(uralt, player.player_id).run()

    const dry = await call('POST', '/v1/admin/maintenance?dry_run=1', { admin: true })
    expect(dry.body.purged.link_codes).toBeGreaterThan(0)
    expect(dry.body.purged.events).toBeGreaterThan(0)
    expect(dry.body.purged.sessions).toBeGreaterThan(0)
    // Trockenlauf loescht nichts.
    expect((await call('POST', '/v1/admin/maintenance?dry_run=1', { admin: true })).body.purged.events).toBe(dry.body.purged.events)

    await call('POST', '/v1/admin/maintenance', { admin: true })
    const zweiter = await call('POST', '/v1/admin/maintenance?dry_run=1', { admin: true })
    expect(Object.values(zweiter.body.purged).every((n) => n === 0)).toBe(true)
    expect(Object.keys(zweiter.body.purged)).toContain('login_tokens')
  })

  it('leaves fresh sessions and entries untouched', async () => {
    await freshSeason()
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1 })
    const player = await signup(keys)
    await call('POST', '/v1/entries', { key: keys.public_key, token: player.token, body: { discipline: 'd', value: 1 } })
    await call('POST', '/v1/admin/maintenance', { admin: true })
    expect((await call('GET', '/v1/me', { key: keys.public_key, token: player.token })).status).toBe(200)
    const entries = await env.DB.prepare(`SELECT COUNT(*) AS n FROM entries WHERE player_id = ?`)
      .bind(player.player_id)
      .first<{ n: number }>()
    expect(entries!.n).toBe(1)
  })
})

describe('Operational views', () => {
  async function busyApp() {
    await freshSeason()
    const keys = await makeApp('Betrieb')
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1, qualifying_score: 10, max_value: 100 })
    const player = await signup(keys)
    await call('PATCH', '/v1/me/region', { key: keys.public_key, token: player.token, body: { region_id: 'hh-harburg' } })
    await call('POST', '/v1/entries', { key: keys.public_key, token: player.token, body: { discipline: 'd', value: 50 } })
    const flagged = await call('POST', '/v1/entries', { key: keys.public_key, token: player.token, body: { discipline: 'd', value: 9999 } })
    return { keys, player, flaggedId: flagged.body.entry_id }
  }

  it('counts apps, players and entries', async () => {
    const { keys } = await busyApp()
    const list = await call('GET', '/v1/admin/apps', { admin: true })
    const row = list.body.apps.find((a: any) => a.slug === keys.slug)
    expect(row.players).toBe(1)
    expect(row.entries).toBe(2)
    expect(row.disciplines).toBe(1)
  })

  it('shows disciplines, activity and review cases', async () => {
    const { keys, player } = await busyApp()
    const detail = await call('GET', `/v1/admin/apps/${keys.slug}`, { admin: true })
    expect(detail.body.disciplines[0].qualified).toBe(1)
    expect(detail.body.activity[0].entries).toBe(2)
    expect(detail.body.flagged).toHaveLength(1)
    expect(detail.body.flagged[0].handle).toBe(player.handle)
  })

  it('does not know unknown apps', async () => {
    expect((await call('GET', '/v1/admin/apps/gibtsnicht', { admin: true })).status).toBe(404)
  })

  it('decides review cases and then lets them count', async () => {
    const { keys, flaggedId } = await busyApp()
    const board = await call('GET', '/v1/leaderboards/d', { key: keys.public_key })
    expect(board.body.entries[0].value).toBe(50)

    const decided = await call('POST', `/v1/admin/entries/${flaggedId}/review`, { admin: true, body: { decision: 'counted' } })
    expect(decided.status).toBe(200)
    const danach = await call('GET', '/v1/leaderboards/d', { key: keys.public_key })
    expect(danach.body.entries[0].value).toBe(9999)
    expect((await call('GET', `/v1/admin/apps/${keys.slug}`, { admin: true })).body.flagged).toHaveLength(0)
  })

  it('rejects invalid decisions and unknown entries', async () => {
    const { flaggedId } = await busyApp()
    expect((await call('POST', `/v1/admin/entries/${flaggedId}/review`, { admin: true, body: { decision: 'vielleicht' } })).status).toBe(400)
    expect((await call('POST', '/v1/admin/entries/ent_gibtsnicht/review', { admin: true, body: { decision: 'counted' } })).status).toBe(404)
    // Ein bereits entschiedener Eintrag ist kein Prueffall mehr.
    await call('POST', `/v1/admin/entries/${flaggedId}/review`, { admin: true, body: { decision: 'rejected' } })
    expect((await call('POST', `/v1/admin/entries/${flaggedId}/review`, { admin: true, body: { decision: 'counted' } })).status).toBe(404)
  })

  it('counts regional density per season', async () => {
    const { player } = await busyApp()
    const jetzt = await call('GET', '/v1/admin/regions/density', { admin: true })
    expect(jetzt.body.regions.find((r: any) => r.id === 'hh-harburg').players).toBe(1)

    const naechste = await freshSeason()
    const spaeter = await call('GET', `/v1/admin/regions/density?season=${naechste}`, { admin: true })
    expect(spaeter.body.regions.every((r: any) => r.players === 0)).toBe(true)
    expect((await call('GET', '/v1/admin/regions/density?season=gibtsnicht', { admin: true })).status).toBe(404)
  })

  it('lists seasons with counters and events with payloads', async () => {
    const { keys } = await busyApp()
    const seasons = await call('GET', '/v1/admin/seasons', { admin: true })
    expect(seasons.body.seasons.some((s: any) => s.status === 'open')).toBe(true)
    const events = await call('GET', '/v1/admin/events', { admin: true })
    expect(events.body.events.length).toBeGreaterThan(0)
    expect(events.body.events[0]).toHaveProperty('payload')
    expect(events.body.events.some((e: any) => e.type === 'entry.flagged' && e.app === keys.slug)).toBe(true)
  })
})

describe('Event stream for clients', () => {
  it('returns own events and advances the cursor', async () => {
    await freshSeason()
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1, qualifying_score: 5 })
    const player = await signup(keys)
    await call('POST', '/v1/entries', { key: keys.public_key, token: player.token, body: { discipline: 'd', value: 50 } })

    const first = await call('GET', '/v1/events', { key: keys.public_key, token: player.token })
    expect(first.body.events.some((e: any) => e.type === 'qualification.achieved')).toBe(true)
    expect(typeof first.body.events[0].payload).toBe('object')
    const tail = await call('GET', `/v1/events?since=${first.body.cursor}`, { key: keys.public_key, token: player.token })
    expect(tail.body.events).toHaveLength(0)
    expect(tail.body.cursor).toBe(first.body.cursor)
  })

  it('shows no events belonging to others', async () => {
    await freshSeason()
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1 })
    const a = await signup(keys)
    const b = await signup(keys)
    await call('POST', '/v1/entries', { key: keys.public_key, token: b.token, body: { discipline: 'd', value: 1 } })
    const mine = await call('GET', '/v1/events', { key: keys.public_key, token: a.token })
    expect(mine.body.events.every((e: any) => e.type === 'player.created')).toBe(true)
  })
})

describe('Catalog and profiles', () => {
  it('shows only its own disciplines, regions, season and collections', async () => {
    await freshSeason()
    const keys = await makeApp()
    const fremd = await makeApp()
    await makeDiscipline(keys, { slug: 'meins', name: 'Meins', trust_tier: 1 })
    await makeDiscipline(fremd, { slug: 'fremd', name: 'Fremd', trust_tier: 1 })
    const catalog = await call('GET', '/v1/catalog', { key: keys.public_key })
    expect(catalog.body.disciplines.map((d: any) => d.slug)).toEqual(['meins'])
    expect(catalog.body.regions.length).toBeGreaterThan(5)
    expect(catalog.body.season.status).toBe('open')
  })

  it('finds players by handle prefix', async () => {
    const keys = await makeApp()
    const player = await signup(keys)
    const prefix = player.handle.slice(0, 6)
    const found = await call('GET', `/v1/players?q=${prefix}`, { key: keys.public_key })
    expect(found.body.players.some((p: any) => p.handle === player.handle)).toBe(true)
    expect((await call('GET', '/v1/players?q=a', { key: keys.public_key })).status).toBe(400)
  })

  it('shows neither region nor ledger on the public profile', async () => {
    await freshSeason()
    const keys = await makeApp()
    await makeDiscipline(keys, { slug: 'd', name: 'D', trust_tier: 1 })
    const player = await signup(keys)
    await call('PATCH', '/v1/me/region', { key: keys.public_key, token: player.token, body: { region_id: 'hh-altona' } })
    await call('POST', '/v1/entries', { key: keys.public_key, token: player.token, body: { discipline: 'd', value: 1 } })
    const oeffentlich = await call('GET', `/v1/players/${player.handle}`, { key: keys.public_key })
    expect(oeffentlich.body).toHaveProperty('badges')
    expect(oeffentlich.body).toHaveProperty('titles')
    expect(oeffentlich.body).not.toHaveProperty('region')
    expect(oeffentlich.body).not.toHaveProperty('entries')
  })

  it('answers unknown routes with 404', async () => {
    const res = await call('GET', '/v1/gibtsnicht')
    expect(res.status).toBe(404)
    expect(res.body.error).toBeDefined()
  })
})

describe('Scheduled retention sweep', () => {
  it('runs from a cron trigger and records what it purged', async () => {
    const keys = await makeApp()
    const player = await signup(keys)
    const code = await call('POST', '/v1/me/link-code', { key: keys.public_key, token: player.token })
    await call('POST', '/v1/auth/redeem', { key: keys.public_key, body: { code: code.body.code } })
    await env.DB.prepare(`UPDATE link_codes SET created_at = ? WHERE player_id = ?`)
      .bind(new Date(Date.now() - 3 * 86400000).toISOString(), player.player_id)
      .run()

    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM link_codes WHERE used_at IS NOT NULL`)
      .first<{ n: number }>()
    expect(before!.n).toBeGreaterThan(0)

    const worker = (await import('../src/index')).default
    const ctx = createExecutionContext()
    await worker.scheduled!({ cron: '17 3 * * *', scheduledTime: Date.now(), noRetry() {} } as any, env as any, ctx)
    await waitOnExecutionContext(ctx)

    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM link_codes WHERE used_at IS NOT NULL`)
      .first<{ n: number }>()
    expect(after!.n).toBe(0)

    const logged = await env.DB.prepare(
      `SELECT detail FROM audit_log WHERE action = 'retention.swept' ORDER BY id DESC LIMIT 1`,
    ).first<{ detail: string }>()
    expect(JSON.parse(logged!.detail).link_codes).toBeGreaterThan(0)
  })
})
