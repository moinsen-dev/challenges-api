import { Hono } from 'hono'
import { HonoApp, currentSeason, discipline, requireApp } from '../lib'
import * as projection from '../projection'

export const ceremony = new Hono<HonoApp>()

// ------------------------------------------------------------------ ghosts

/**
 * Ghosts.
 *
 * A verified run already carries the input trace that produced it — that is
 * what phase 6 stores in order to re-simulate it. So racing the district
 * champion while they sleep is not a new system, it is a read over data that
 * already exists, and it only exists for runs somebody has actually proved.
 */
ceremony.get('/v1/ghosts/:discipline', requireApp, async (c) => {
  const app = c.get('app')!
  const d = await discipline(c.env.DB, app.id, c.req.param('discipline'))
  if (!d) return c.json({ error: 'unknown discipline' }, 404)
  if (!d.module_id) return c.json({ error: 'this discipline does not verify runs, so it has no ghosts' }, 409)
  const season = await currentSeason(c.env.DB)
  if (!season) return c.json({ error: 'no open season' }, 409)

  const regionId = c.req.query('region')
  const limit = Math.min(Number(c.req.query('limit') ?? 5), 20)
  const scope = regionId
    ? {
        regionId,
        level: (
          await c.env.DB.prepare(`SELECT level FROM regions WHERE id = ?`).bind(regionId).first<{
            level: number
          }>()
        )?.level,
      }
    : {}
  if (regionId && !scope.level) return c.json({ error: 'unknown region' }, 404)

  const board = await projection.page(c.env.DB, d, season.id, scope, { limit })
  const ghosts = []
  for (const [index, row] of board.rows.entries()) {
    // The run that produced their standing, and only if it was verified.
    const entry = await c.env.DB.prepare(
      `SELECT id, value, created_at FROM entries
        WHERE player_id = ? AND discipline_id = ? AND season_id = ?
          AND verification = 'verified' AND value = ?
        ORDER BY created_at LIMIT 1`,
    )
      .bind(row.player_id, d.id, season.id, row.value)
      .first<{ id: string; value: number; created_at: string }>()
    if (!entry) continue
    ghosts.push({
      rank: index + 1,
      handle: row.handle,
      value: row.value,
      entry_id: entry.id,
      recorded_at: entry.created_at,
      trace: `/v1/ghosts/trace/${entry.id}`,
    })
  }
  return c.json({ discipline: d.slug, region: regionId ?? 'global', ghosts })
})

ceremony.get('/v1/ghosts/trace/:entry', requireApp, async (c) => {
  const app = c.get('app')!
  const entry = await c.env.DB.prepare(
    `SELECT e.id, e.verification, d.app_id FROM entries e
       JOIN disciplines d ON d.id = e.discipline_id WHERE e.id = ?`,
  )
    .bind(c.req.param('entry'))
    .first<{ id: string; verification: string; app_id: string }>()
  // Only a proved run is a ghost, and only inside the app it belongs to.
  if (!entry || entry.app_id !== app.id || entry.verification !== 'verified')
    return c.json({ error: 'no ghost for that entry' }, 404)

  const object = await c.env.BLOBS.get(`traces/${entry.id}.bin`)
  if (!object) return c.json({ error: 'trace is gone' }, 404)
  return new Response(object.body, {
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000' },
  })
})

// ------------------------------------------------------------------ titles

ceremony.get('/v1/titles', requireApp, async (c) => {
  const app = c.get('app')!
  const region = c.req.query('region')
  const season = c.req.query('season')
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.level, t.value_at, t.contenders, t.awarded_at, t.season_id,
            p.handle, r.name AS region, r.id AS region_id, d.slug AS discipline
       FROM titles t
       JOIN players p ON p.id = t.player_id
       JOIN regions r ON r.id = t.region_id
       JOIN disciplines d ON d.id = t.discipline_id
      WHERE d.app_id = ?
        AND (? IS NULL OR t.region_id = ?)
        AND (? IS NULL OR t.season_id = ?)
      ORDER BY t.awarded_at DESC LIMIT 100`,
  )
    .bind(app.id, region ?? null, region ?? null, season ?? null, season ?? null)
    .all()
  return c.json({ titles: rows.results })
})

const escape = (value: string) =>
  String(value).replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

/**
 * A title as an image.
 *
 * Deliberately an SVG built by hand: it needs no library, no font file and no
 * build step, it renders in every browser and in most chat clients, and it is
 * the difference between a row in a database and something somebody posts.
 *
 * No authentication: a title is public by nature, and an image nobody can
 * embed is not a shareable image.
 */
ceremony.get('/v1/titles/:id/card.svg', async (c) => {
  const title = await c.env.DB.prepare(
    `SELECT t.level, t.value_at, t.contenders, t.awarded_at, p.handle,
            r.name AS region, d.slug AS discipline, d.unit, s.name AS season
       FROM titles t
       JOIN players p ON p.id = t.player_id
       JOIN regions r ON r.id = t.region_id
       JOIN disciplines d ON d.id = t.discipline_id
       JOIN seasons s ON s.id = t.season_id
      WHERE t.id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{
      level: number
      value_at: number
      contenders: number
      awarded_at: string
      handle: string
      region: string
      discipline: string
      unit: string | null
      season: string
    }>()
  if (!title) return c.json({ error: 'unknown title' }, 404)

  const levelName =
    ['district', 'city', 'state', 'country', 'continent', 'world'][title.level - 1] ?? 'region'
  const value = title.value_at.toLocaleString('en-US') + (title.unit ? ` ${title.unit}` : '')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escape(title.handle)} is ${levelName} champion of ${escape(title.region)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0b0d"/><stop offset="1" stop-color="#14171c"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f0c862"/><stop offset="1" stop-color="#b08324"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1010" cy="120" r="240" fill="#e9b949" opacity="0.06"/>
  <rect x="0" y="0" width="1200" height="6" fill="url(#gold)"/>

  <text x="80" y="130" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="22"
        letter-spacing="6" fill="#e9b949">${escape(levelName.toUpperCase())} CHAMPION</text>

  <text x="80" y="270" font-family="Georgia,'Times New Roman',serif" font-size="104" fill="#f2f5f9">${escape(
    title.handle,
  )}</text>
  <text x="80" y="350" font-family="Georgia,'Times New Roman',serif" font-size="52" fill="#b8c2ce">${escape(
    title.region,
  )}</text>

  <line x1="80" y1="410" x2="1120" y2="410" stroke="#232830" stroke-width="2"/>

  <text x="80" y="470" font-family="system-ui,sans-serif" font-size="26" fill="#7f8b99">Discipline</text>
  <text x="80" y="512" font-family="ui-monospace,Menlo,monospace" font-size="30" fill="#eaeef4">${escape(
    title.discipline,
  )}</text>

  <text x="440" y="470" font-family="system-ui,sans-serif" font-size="26" fill="#7f8b99">Result</text>
  <text x="440" y="512" font-family="ui-monospace,Menlo,monospace" font-size="30" fill="#e9b949">${escape(
    value,
  )}</text>

  <text x="800" y="470" font-family="system-ui,sans-serif" font-size="26" fill="#7f8b99">Contenders</text>
  <text x="800" y="512" font-family="ui-monospace,Menlo,monospace" font-size="30" fill="#eaeef4">${
    title.contenders
  }</text>

  <text x="80" y="580" font-family="system-ui,sans-serif" font-size="22" fill="#5d6874">${escape(
    title.season,
  )} · ${escape(title.awarded_at.slice(0, 10))} · challenges.moinsen.dev</text>
</svg>`

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // A title never changes, so it may be cached for a long time.
      'Cache-Control': 'public, max-age=86400',
    },
  })
})
