import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { call, freshSeason, makeApp, makeDiscipline, signup, unique } from './helpers'

async function field(count: number, values: number[], disc: Record<string, unknown> = {}) {
  const season = await freshSeason()
  const keys = await makeApp()
  // Eigener Disziplin-Slug je Test: der Abschlussbericht umfasst die ganze
  // Saison, Zusicherungen muessen deshalb auf die eigene Disziplin zielen.
  const slug = unique('d')
  await makeDiscipline(keys, {
    slug,
    name: 'D',
    trust_tier: 1,
    max_title_level: 2,
    title_min_players: 5,
    ...disc,
  })
  const players = []
  for (let i = 0; i < count; i++) {
    const p = await signup(keys)
    await call('PATCH', '/v1/me/region', { key: keys.public_key, token: p.token, body: { region_id: 'hh-altona' } })
    await call('POST', '/v1/entries', { key: keys.public_key, token: p.token, body: { discipline: slug, value: values[i] } })
    players.push(p)
  }
  return { keys, players, slug, season }
}

const close = (season: string, dry = true, body?: unknown) =>
  call('POST', `/v1/admin/seasons/${season}/close${dry ? '?dry_run=1' : ''}`, { admin: true, body })

describe('Awarding titles', () => {
  it('awards nothing below the minimum contenders', async () => {
    const { slug, season } = await field(4, [10, 20, 30, 40])
    const report = await close(season)
    const altona = report.body.skipped.find((s: any) => s.region === 'hh-altona' && s.discipline === slug)
    expect(altona.reason).toContain('too few')
    expect(report.body.awarded.filter((a: any) => a.discipline === slug)).toHaveLength(0)
  })

  it('awards exactly from the minimum contenders on', async () => {
    const { players, slug, season } = await field(5, [10, 20, 30, 40, 50])
    const report = await close(season)
    const title = report.body.awarded.find((a: any) => a.discipline === slug && a.level === 1)
    expect(title.handle).toBe(players[4].handle)
    expect(title.contenders).toBe(5)
  })

  it('awards nothing on a tie at the top', async () => {
    const { slug, season } = await field(5, [10, 20, 30, 50, 50])
    const report = await close(season)
    const altona = report.body.skipped.find((s: any) => s.discipline === slug && s.region === 'hh-altona')
    expect(altona.reason).toBe('no unique winner')
  })

  it('is untroubled by a tie below the top', async () => {
    const { slug, season } = await field(5, [10, 20, 20, 20, 99])
    const report = await close(season)
    expect(report.body.awarded.some((a: any) => a.discipline === slug && a.region === 'hh-altona')).toBe(true)
  })

  it('crowns the smallest value on asc', async () => {
    const { players, slug, season } = await field(5, [90, 80, 70, 60, 42], { score_direction: 'asc' })
    const report = await close(season)
    const title = report.body.awarded.find((a: any) => a.discipline === slug && a.level === 1)
    expect(title.handle).toBe(players[4].handle)
  })

  it('awards no titles above the permitted level', async () => {
    const { slug, season } = await field(5, [10, 20, 30, 40, 50])
    const report = await close(season)
    const mine = report.body.awarded.filter((a: any) => a.discipline === slug)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((a: any) => a.level <= 2)).toBe(true)
    expect(mine.some((a: any) => a.region === 'de')).toBe(false)
  })

  it('awards no title at all with max_title_level 0', async () => {
    const { slug, season } = await field(5, [10, 20, 30, 40, 50], { max_title_level: 0, trust_tier: 0 })
    const report = await close(season)
    expect(report.body.awarded.filter((a: any) => a.discipline === slug)).toHaveLength(0)
    expect(report.body.skipped.filter((s: any) => s.discipline === slug)).toHaveLength(0)
  })

  it('awards nothing on a dry run and does not close the season', async () => {
    const { keys, players, season } = await field(5, [10, 20, 30, 40, 50])
    await close(season)
    const me = await call('GET', '/v1/me', { key: keys.public_key, token: players[4].token })
    expect(me.body.titles).toHaveLength(0)
    expect(me.body.season.status).toBe('open')
  })

  it('awards on a real close and closes the season', async () => {
    const { keys, players, slug, season } = await field(5, [10, 20, 30, 40, 50])
    const report = await close(season, false)
    expect(report.body.awarded.filter((a: any) => a.discipline === slug).every((a: any) => a.fresh)).toBe(true)
    const champion = await call('GET', `/v1/players/${players[4].handle}`, { key: keys.public_key })
    expect(champion.body.titles.length).toBeGreaterThan(0)
    const row = await env.DB.prepare(`SELECT status FROM seasons WHERE id = ?`).bind(season).first<{ status: string }>()
    expect(row!.status).toBe('closed')
  })

  it('creates neither duplicate title nor duplicate event on a second close', async () => {
    const { keys, players, slug, season } = await field(5, [10, 20, 30, 40, 50])
    const first = await close(season, false)
    const before = (await call('GET', `/v1/players/${players[4].handle}`, { key: keys.public_key })).body.titles.length
    const second = await close(season, false)
    const after = (await call('GET', `/v1/players/${players[4].handle}`, { key: keys.public_key })).body.titles.length
    expect(after).toBe(before)
    expect(second.body.awarded.every((a: any) => a.fresh === false)).toBe(true)
    const events = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE type = 'title.awarded' AND payload LIKE ?`,
    )
      .bind(`%"discipline":"${slug}"%`)
      .first<{ n: number }>()
    expect(events!.n).toBe(first.body.awarded.filter((a: any) => a.discipline === slug).length)
  })

  it('opens the next season in the same move on request', async () => {
    const { keys, players, slug, season } = await field(5, [10, 20, 30, 40, 50], { qualifying_score: 5 })
    const next = { id: unique('s'), name: 'Saison 2', starts_at: '2027-01-01T00:00:00Z', ends_at: '2027-03-31T23:59:59Z' }
    const report = await close(season, false, { next })
    expect(report.body.next.id).toBe(next.id)
    // Die neue Saison beginnt ohne Qualifikationen und ohne Heimatregionen.
    const status = await call('GET', `/v1/disciplines/${slug}/me`, { key: keys.public_key, token: players[4].token })
    expect(status.body.value).toBe(null)
    expect(status.body.qualified).toBe(false)
    const me = await call('GET', '/v1/me', { key: keys.public_key, token: players[4].token })
    expect(me.body.region).toBe(null)
    expect(me.body.titles.length).toBeGreaterThan(0)
  })

  it('does not know unknown seasons', async () => {
    expect((await close('gibtsnicht')).status).toBe(404)
  })

  it('counts only qualified players as contenders', async () => {
    const season = await freshSeason()
    const keys = await makeApp()
    const slug = unique('d')
    await makeDiscipline(keys, {
      slug, name: 'D', trust_tier: 1, max_title_level: 2,
      title_min_players: 5, qualifying_score: 100,
    })
    for (let i = 0; i < 6; i++) {
      const p = await signup(keys)
      await call('PATCH', '/v1/me/region', { key: keys.public_key, token: p.token, body: { region_id: 'hh-nord' } })
      // Nur vier schaffen die Pruefung.
      await call('POST', '/v1/entries', { key: keys.public_key, token: p.token, body: { discipline: slug, value: i < 4 ? 200 + i : 10 } })
    }
    const report = await close(season)
    const nord = report.body.skipped.find((s: any) => s.discipline === slug && s.region === 'hh-nord')
    expect(nord.contenders).toBe(4)
    expect(nord.reason).toContain('too few')
  })
})
