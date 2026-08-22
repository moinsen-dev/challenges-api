import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'
import { call, freshSeason, makeApp, makeDiscipline, signup, unique } from './helpers'
import { bytes, scorer } from './fixtures/wasm'

const ctx = { waitUntil() {}, passThroughOnException() {} } as ExecutionContext

function expectedScore(trace: Uint8Array): number {
  let score = 0n
  for (const byte of trace) score = BigInt.asUintN(64, score * 31n + BigInt(byte))
  return Number(score)
}
const toBase64 = (input: Uint8Array) => btoa(String.fromCharCode(...input))

async function provedArena() {
  await freshSeason()
  const keys = await makeApp()
  const slug = unique('ghosted')
  await makeDiscipline(keys, { slug, name: 'Ghosted', trust_tier: 1, max_title_level: 2 })
  await worker.fetch(
    new Request('https://api.test/v1/verifier/modules?name=core', {
      method: 'POST',
      headers: { 'X-App-Key': keys.secret_key },
      body: bytes(scorer),
    }),
    env as any,
    ctx,
  )
  await call(`POST`, `/v1/disciplines/${slug}/verifier`, {
    key: keys.secret_key,
    body: { module: 'core', export: 'verify' },
  })
  return { keys, slug }
}

/** Submit a run and have it verified, the way the verifier would. */
async function provedRun(keys: any, slug: string, trace: Uint8Array, region?: string) {
  const player = await signup(keys)
  if (region)
    await call('PATCH', '/v1/me/region', {
      key: keys.public_key,
      token: player.token,
      body: { region_id: region },
    })
  const score = expectedScore(trace)
  const entry = await call('POST', '/v1/entries', {
    key: keys.public_key,
    token: player.token,
    body: { discipline: slug, value: score, trace: toBase64(trace) },
  })
  const job = await env.DB.prepare(`SELECT id FROM verification_jobs WHERE entry_id = ?`)
    .bind(entry.body.entry_id)
    .first<{ id: string }>()
  await call(`POST`, `/v1/verifier/jobs/${job!.id}/result`, {
    admin: true,
    body: { verdict: 'verified', computed_value: score, cpu_ms: 1 },
  })
  return { player, entryId: entry.body.entry_id, score }
}

describe('Ghosts', () => {
  it('offers the traces of the runs at the top of a board', async () => {
    const { keys, slug } = await provedArena()
    const fast = await provedRun(keys, slug, new Uint8Array([9, 9, 9]))
    const slow = await provedRun(keys, slug, new Uint8Array([1]))

    const ghosts = await call(`GET`, `/v1/ghosts/${slug}`, { key: keys.public_key })
    expect(ghosts.body.ghosts).toHaveLength(2)
    expect(ghosts.body.ghosts[0].handle).toBe(fast.player.handle)
    expect(ghosts.body.ghosts[0].rank).toBe(1)
    expect(ghosts.body.ghosts[0].entry_id).toBe(fast.entryId)
    expect(ghosts.body.ghosts[1].handle).toBe(slow.player.handle)
  })

  it('hands back the exact bytes the run was made of', async () => {
    const { keys, slug } = await provedArena()
    const trace = new Uint8Array([3, 1, 4, 1, 5])
    const run = await provedRun(keys, slug, trace)

    const res = await worker.fetch(
      new Request(`https://api.test/v1/ghosts/trace/${run.entryId}`, {
        headers: { 'X-App-Key': keys.public_key },
      }),
      env as any,
      ctx,
    )
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(trace)
    // A ghost never changes, so it may be cached for a long time.
    expect(res.headers.get('Cache-Control')).toContain('max-age')
  })

  it('narrows to a region, and refuses one that does not exist', async () => {
    const { keys, slug } = await provedArena()
    await provedRun(keys, slug, new Uint8Array([8, 8]), 'hh-altona')
    await provedRun(keys, slug, new Uint8Array([7]), 'hh-nord')

    const altona = await call(`GET`, `/v1/ghosts/${slug}?region=hh-altona`, { key: keys.public_key })
    expect(altona.body.ghosts).toHaveLength(1)
    const city = await call(`GET`, `/v1/ghosts/${slug}?region=hh-city`, { key: keys.public_key })
    expect(city.body.ghosts).toHaveLength(2)
    expect((await call(`GET`, `/v1/ghosts/${slug}?region=atlantis`, { key: keys.public_key })).status).toBe(404)
  })

  it('says plainly that a discipline without verification has no ghosts', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('trusting')
    await makeDiscipline(keys, { slug, name: 'Trusting', trust_tier: 1 })
    const res = await call(`GET`, `/v1/ghosts/${slug}`, { key: keys.public_key })
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('does not verify')
  })

  it('refuses a trace for a run nobody proved, and for another app', async () => {
    const { keys, slug } = await provedArena()
    const player = await signup(keys)
    const unproved = await call('POST', '/v1/entries', {
      key: keys.public_key,
      token: player.token,
      body: { discipline: slug, value: 1, trace: toBase64(new Uint8Array([1])) },
    })

    const pending = await worker.fetch(
      new Request(`https://api.test/v1/ghosts/trace/${unproved.body.entry_id}`, {
        headers: { 'X-App-Key': keys.public_key },
      }),
      env as any,
      ctx,
    )
    expect(pending.status).toBe(404)

    const stranger = await makeApp()
    const run = await provedRun(keys, slug, new Uint8Array([2, 2]))
    const foreign = await worker.fetch(
      new Request(`https://api.test/v1/ghosts/trace/${run.entryId}`, {
        headers: { 'X-App-Key': stranger.public_key },
      }),
      env as any,
      ctx,
    )
    expect(foreign.status).toBe(404)
  })
})

describe('A title somebody can show', () => {
  async function awardedTitle() {
    const season = await freshSeason()
    const keys = await makeApp()
    const slug = unique('crowned')
    await makeDiscipline(keys, {
      slug,
      name: 'Crowned',
      trust_tier: 1,
      max_title_level: 2,
      title_min_players: 2,
      unit: 'pts',
    })
    const players = []
    for (const value of [900, 500]) {
      const player = await signup(keys)
      await call('PATCH', '/v1/me/region', {
        key: keys.public_key,
        token: player.token,
        body: { region_id: 'hh-altona' },
      })
      await call('POST', '/v1/entries', {
        key: keys.public_key,
        token: player.token,
        body: { discipline: slug, value },
      })
      players.push(player)
    }
    await call(`POST`, `/v1/admin/seasons/${season}/close`, { admin: true })
    const title = await env.DB.prepare(
      `SELECT t.id FROM titles t JOIN disciplines d ON d.id = t.discipline_id
        WHERE d.slug = ? AND t.level = 1`,
    )
      .bind(slug)
      .first<{ id: string }>()
    return { keys, slug, season, players, titleId: title!.id }
  }

  it('lists the archive, filtered by region and season', async () => {
    const { keys, slug, season, players } = await awardedTitle()
    const all = await call('GET', '/v1/titles', { key: keys.public_key })
    expect(all.body.titles.length).toBeGreaterThan(0)
    expect(all.body.titles[0].handle).toBe(players[0].handle)
    expect(all.body.titles[0].discipline).toBe(slug)

    const altona = await call('GET', '/v1/titles?region=hh-altona', { key: keys.public_key })
    expect(altona.body.titles.every((t: any) => t.region_id === 'hh-altona')).toBe(true)
    const wrongSeason = await call('GET', '/v1/titles?season=nothing', { key: keys.public_key })
    expect(wrongSeason.body.titles).toHaveLength(0)
  })

  it('draws a card anybody can embed', async () => {
    const { titleId, players, slug } = await awardedTitle()
    // No key and no token: a title is public, and an image nobody can embed
    // is not a shareable image.
    const res = await worker.fetch(
      new Request(`https://api.test/v1/titles/${titleId}/card.svg`),
      env as any,
      ctx,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('image/svg+xml')
    expect(res.headers.get('Cache-Control')).toContain('max-age')

    const svg = await res.text()
    expect(svg).toContain('<svg')
    expect(svg).toContain(players[0].handle)
    expect(svg).toContain('DISTRICT CHAMPION')
    expect(svg).toContain('Altona')
    expect(svg).toContain(slug)
    expect(svg).toContain('900 pts')
    // The contender count is on the card, because a title without a field
    // behind it is worth saying less about.
    expect(svg).toContain('>2<')
  })

  it('escapes whatever somebody put in their handle', async () => {
    const season = await freshSeason()
    const keys = await makeApp()
    const slug = unique('xss')
    await makeDiscipline(keys, {
      slug, name: 'X', trust_tier: 1, max_title_level: 2, title_min_players: 1,
    })
    const nasty = await signup(keys, `x<script>alert(1)</${unique('s')}`)
    await call('PATCH', '/v1/me/region', {
      key: keys.public_key, token: nasty.token, body: { region_id: 'hh-harburg' },
    })
    await call('POST', '/v1/entries', {
      key: keys.public_key, token: nasty.token, body: { discipline: slug, value: 10 },
    })
    await call(`POST`, `/v1/admin/seasons/${season}/close`, { admin: true })

    const title = await env.DB.prepare(
      `SELECT t.id FROM titles t JOIN disciplines d ON d.id = t.discipline_id WHERE d.slug = ?`,
    )
      .bind(slug)
      .first<{ id: string }>()
    const svg = await (
      await worker.fetch(new Request(`https://api.test/v1/titles/${title!.id}/card.svg`), env as any, ctx)
    ).text()
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&#60;script&#62;')
  })

  it('refuses a card for a title that does not exist', async () => {
    const res = await worker.fetch(
      new Request('https://api.test/v1/titles/ttl_nothing/card.svg'),
      env as any,
      ctx,
    )
    expect(res.status).toBe(404)
  })
})

describe('Corners of the ceremony', () => {
  it('needs an open season for ghosts', async () => {
    const { keys, slug } = await provedArena()
    await env.DB.prepare(`UPDATE seasons SET status = 'closed'`).run()
    const res = await call(`GET`, `/v1/ghosts/${slug}`, { key: keys.public_key })
    expect(res.status).toBe(409)
  })

  it('skips a standing whose run was never proved', async () => {
    const { keys, slug } = await provedArena()
    const proved = await provedRun(keys, slug, new Uint8Array([5, 5]))

    // Somebody on the board whose entry was counted without verification.
    const other = await signup(keys)
    await env.DB.prepare(
      `INSERT INTO entries (id, discipline_id, season_id, player_id, value, day, occurred_at,
                            trust_tier, status, verification, created_at)
       SELECT 'ent_unproved', d.id, s.id, ?, 99999, '2026-01-01', '2026-01-01T00:00:00Z', 1,
              'counted', 'none', '2026-01-01T00:00:00Z'
         FROM disciplines d, seasons s WHERE d.slug = ? AND s.status = 'open'`,
    )
      .bind(other.player_id, slug)
      .run()
    const d = await env.DB.prepare(`SELECT * FROM disciplines WHERE slug = ?`).bind(slug).first<any>()
    const season = await env.DB.prepare(`SELECT id FROM seasons WHERE status = 'open'`).first<any>()
    const { refresh } = await import('../src/projection')
    await refresh(env.DB, d, season.id, other.player_id, null)

    const ghosts = await call(`GET`, `/v1/ghosts/${slug}`, { key: keys.public_key })
    // They lead the board but have no ghost, so they are simply absent here.
    expect(ghosts.body.ghosts.map((g: any) => g.handle)).not.toContain(other.handle)
    expect(ghosts.body.ghosts.map((g: any) => g.handle)).toContain(proved.player.handle)
  })

  it('refuses a ghost for an unknown entry and an unknown discipline', async () => {
    const { keys } = await provedArena()
    const res = await worker.fetch(
      new Request('https://api.test/v1/ghosts/trace/ent_nothing', {
        headers: { 'X-App-Key': keys.public_key },
      }),
      env as any,
      ctx,
    )
    expect(res.status).toBe(404)
    expect((await call('GET', '/v1/ghosts/not-a-discipline', { key: keys.public_key })).status).toBe(404)
  })
})
