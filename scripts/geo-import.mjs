#!/usr/bin/env node
/**
 * Builds the geography of the ladder as one SQL file.
 *
 * The boundaries are not committed to this repository. They belong to their
 * sources, this repository is CC0, and a shape file would dwarf the code. The
 * script fetches, simplifies and emits; the operator applies the result:
 *
 *   node scripts/geo-import.mjs > .geo/regions.sql
 *   npx wrangler d1 execute challenges --local  --file=.geo/regions.sql
 *   npx wrangler d1 execute challenges --remote --file=.geo/regions.sql
 *
 * Sources, both free for commercial use, both requiring attribution:
 *
 *   Bundeslaender and Kreise  Eurostat GISCO, NUTS 2024 at 1:1 million.
 *                             (C) EuroGeographics for the administrative
 *                             boundaries. NUTS 1 is exactly the sixteen
 *                             Bundeslaender, NUTS 3 exactly the 400 Kreise.
 *   Hamburg districts         OpenStreetMap contributors, ODbL. The seven
 *                             Bezirke have no NUTS code; Hamburg is one
 *                             region at every European level.
 *
 * Everything outside Hamburg is imported CLOSED, with a threshold. That is not
 * caution, it is the product: a title from an empty district is worth less than
 * no title, and a closed region is what the waitlist in migration 0003 has been
 * waiting for since the day it was written.
 */

const GISCO = (level) =>
  `https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/NUTS_RG_01M_2024_4326_LEVL_${level}.geojson`
const OVERPASS = 'https://overpass-api.de/api/interpreter'
const UA = 'challenges-api-geo-import/1.0 (+https://github.com/moinsen-dev/challenges-api)'

/** From the vision: a district ladder needs eleven people to mean anything. */
const THRESHOLD = 11

/** Simplification tolerance in degrees. Roughly 100 m at this latitude. */
const TOLERANCE = 0.001

/**
 * Rows that already exist from migration 0002 and must keep their ids: players,
 * titles and invites point at them. The import updates them instead of adding
 * a second Hamburg next to the first.
 */
const EXISTING = {
  DE6: 'hh', // Bundesland Hamburg
  DE600: 'hh-city', // Hamburg as a Kreis
  30243: 'hh-eimsbuettel',
  30223: 'hh-altona',
  30352: 'hh-nord',
  28971: 'hh-mitte',
  30353: 'hh-wandsbek',
  28936: 'hh-bergedorf',
  28964: 'hh-harburg',
}

// --------------------------------------------------------------------- Fetch

const log = (...a) => console.error(...a)

async function getJSON(url, init, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...init?.headers } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (error) {
      // Overpass answers a transient 502 often enough that a single try would
      // silently book a region as "not found".
      if (i >= attempts) throw error
      log(`  retry ${i}/${attempts - 1} after ${error.message}`)
      await new Promise((r) => setTimeout(r, 2000 * i))
    }
  }
}

// ---------------------------------------------------------------- Geometry

/** Douglas-Peucker. A Kreis boundary does not need survey precision to say who lives in it. */
function simplify(ring, tolerance) {
  if (ring.length <= 4) return ring
  const sqTol = tolerance * tolerance
  const keep = new Uint8Array(ring.length)
  keep[0] = keep[ring.length - 1] = 1
  const stack = [[0, ring.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()
    let index = -1
    let maxSq = sqTol
    const [x1, y1] = ring[first]
    const [x2, y2] = ring[last]
    for (let i = first + 1; i < last; i++) {
      const [x, y] = ring[i]
      let dx = x2 - x1
      let dy = y2 - y1
      let t = dx || dy ? ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy) : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      dx = x - (x1 + t * (x2 - x1))
      dy = y - (y1 + t * (y2 - y1))
      const sq = dx * dx + dy * dy
      if (sq > maxSq) {
        index = i
        maxSq = sq
      }
    }
    if (index > 0) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  const out = ring.filter((_, i) => keep[i])
  // A ring that simplifies away entirely would swallow everyone inside it.
  return out.length >= 4 ? out : ring
}

/** Outer rings only; holes are handled by resolving smallest-box-first. */
function outerRings(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]
  return polys.map((poly) => poly[0])
}

/** One entry per ring: a ring cannot have an exclave, a region can. */
function shapesOf(rings) {
  return rings.map((ring) => {
    const s = simplify(ring, TOLERANCE).map(([lon, lat]) => [round(lon), round(lat)])
    let minLat = 90
    let minLon = 180
    let maxLat = -90
    let maxLon = -180
    for (const [lon, lat] of s) {
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lon < minLon) minLon = lon
      if (lon > maxLon) maxLon = lon
    }
    return {
      min_lat: minLat,
      min_lon: minLon,
      max_lat: maxLat,
      max_lon: maxLon,
      area: (maxLat - minLat) * (maxLon - minLon),
      ring: s,
    }
  })
}

const round = (n) => Math.round(n * 1e5) / 1e5

// ------------------------------------------------------------------- Naming

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** "Stuttgart, Stadtkreis" is the disambiguated form; the district is called Stuttgart. */
const displayName = (nutsName) => nutsName.replace(/,\s*(Stadtkreis|Landkreis|Kreisfreie Stadt)$/i, '')

// --------------------------------------------------------------- Assembling

/** Overpass hands back loose ways; a boundary is what you get after joining them. */
function stitch(members) {
  const ways = members
    .filter((m) => m.type === 'way' && m.role !== 'inner' && Array.isArray(m.geometry))
    .map((m) => m.geometry.map((p) => [p.lon, p.lat]))
  const rings = []
  const pool = ways.slice()
  while (pool.length) {
    let ring = pool.shift()
    let joined = true
    while (joined) {
      joined = false
      for (let i = 0; i < pool.length; i++) {
        const head = ring[0]
        const tail = ring[ring.length - 1]
        const cand = pool[i]
        const cHead = cand[0]
        const cTail = cand[cand.length - 1]
        const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7
        if (same(tail, cHead)) ring = ring.concat(cand.slice(1))
        else if (same(tail, cTail)) ring = ring.concat(cand.slice(0, -1).reverse())
        else if (same(head, cTail)) ring = cand.slice(0, -1).concat(ring)
        else if (same(head, cHead)) ring = cand.slice(1).reverse().concat(ring)
        else continue
        pool.splice(i, 1)
        joined = true
        break
      }
    }
    if (ring.length >= 4) rings.push(ring)
  }
  return rings
}

const sql = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)

function emit(region, shapes) {
  const { id, parent_id, level, name, active, threshold, code, source } = region
  const lines = [
    `INSERT INTO regions (id, parent_id, level, name, active, unlock_threshold, code, source)`,
    `VALUES (${sql(id)}, ${sql(parent_id)}, ${level}, ${sql(name)}, ${active}, ${threshold}, ${sql(code)}, ${sql(source)})`,
    `ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, level = excluded.level,`,
    `  name = excluded.name, code = excluded.code, source = excluded.source;`,
    `DELETE FROM region_shapes WHERE region_id = ${sql(id)};`,
  ]
  shapes.forEach((s, part) => {
    lines.push(
      `INSERT INTO region_shapes (region_id, part, min_lat, min_lon, max_lat, max_lon, area, ring)`,
      `VALUES (${sql(id)}, ${part}, ${s.min_lat}, ${s.min_lon}, ${s.max_lat}, ${s.max_lon}, ${s.area}, ${sql(JSON.stringify(s.ring))});`,
    )
  })
  return lines.join('\n')
}

// -------------------------------------------------------------------- Import

const out = []
let points = 0
let parts = 0

/**
 * Every id is claimed exactly once. Three Bundeslaender are also a Kreis —
 * Berlin, Bremen and Hamburg carry the same name at both levels — and the
 * first run of this script silently overwrote Berlin with itself. Hamburg had
 * survived only because migration 0002 had already named it hh and hh-city by
 * hand. A city that is its own district gets that same -city suffix.
 */
const taken = new Map()
function claim(preferred, { parent, code }) {
  if (!taken.has(preferred)) {
    taken.set(preferred, code)
    return preferred
  }
  const suffixed = preferred === parent ? `${preferred}-city` : `${preferred}-${code.toLowerCase()}`
  if (taken.has(suffixed)) throw new Error(`cannot place ${code}: ${preferred} and ${suffixed} both taken`)
  taken.set(suffixed, code)
  return suffixed
}

out.push(
  '-- Generated by scripts/geo-import.mjs. Do not edit.',
  '-- Boundaries: (C) EuroGeographics for the administrative boundaries (NUTS 2024),',
  '-- and (C) OpenStreetMap contributors, ODbL, for the districts of Hamburg.',
  '',
)

for (const [code, id] of Object.entries(EXISTING)) taken.set(id, code)

log('NUTS 1 — Bundeslaender')
const nuts1 = await getJSON(GISCO(1))
for (const f of nuts1.features.filter((x) => x.properties.CNTR_CODE === 'DE')) {
  const code = f.properties.NUTS_ID
  const id = EXISTING[code] ?? claim(slug(f.properties.NAME_LATN), { parent: 'de', code })
  const shapes = shapesOf(outerRings(f.geometry))
  points += shapes.reduce((n, s) => n + s.ring.length, 0)
  parts += shapes.length
  out.push(
    emit(
      {
        id,
        parent_id: 'de',
        level: 3,
        name: f.properties.NAME_LATN,
        // Hamburg is the one place that is already open, and stays that way.
        active: id === 'hh' ? 1 : 0,
        threshold: id === 'hh' ? 0 : THRESHOLD,
        code,
        source: 'nuts',
      },
      shapes,
    ),
  )
}
log(`  ${nuts1.features.filter((x) => x.properties.CNTR_CODE === 'DE').length} written`)

log('NUTS 3 — Kreise')
const nuts3 = await getJSON(GISCO(3))
const kreise = nuts3.features.filter((x) => x.properties.CNTR_CODE === 'DE')
const landById = new Map(
  nuts1.features
    .filter((x) => x.properties.CNTR_CODE === 'DE')
    .map((x) => [x.properties.NUTS_ID, EXISTING[x.properties.NUTS_ID] ?? slug(x.properties.NAME_LATN)]),
)
for (const f of kreise) {
  const code = f.properties.NUTS_ID
  const parent = landById.get(code.slice(0, 3)) ?? 'de'
  const id = EXISTING[code] ?? claim(slug(displayName(f.properties.NAME_LATN)), { parent, code })
  const shapes = shapesOf(outerRings(f.geometry))
  points += shapes.reduce((n, s) => n + s.ring.length, 0)
  parts += shapes.length
  out.push(
    emit(
      {
        id,
        parent_id: parent,
        level: 2,
        name: displayName(f.properties.NAME_LATN),
        active: id === 'hh-city' ? 1 : 0,
        threshold: id === 'hh-city' ? 0 : THRESHOLD,
        code,
        source: 'nuts',
      },
      shapes,
    ),
  )
}
log(`  ${kreise.length} written`)

log('OSM — Bezirke of Hamburg')
const query =
  '[out:json][timeout:180];relation(id:' +
  Object.keys(EXISTING)
    .filter((k) => /^\d+$/.test(k))
    .join(',') +
  ');out geom;'
const osm = await getJSON(OVERPASS, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain' },
  body: query,
})
for (const el of osm.elements) {
  const id = EXISTING[el.id]
  if (!id) continue
  const rings = stitch(el.members)
  if (!rings.length) throw new Error(`no ring stitched for ${el.tags?.name} (${el.id})`)
  const shapes = shapesOf(rings)
  points += shapes.reduce((n, s) => n + s.ring.length, 0)
  parts += shapes.length
  out.push(
    emit(
      {
        id,
        parent_id: 'hh-city',
        level: 1,
        name: el.tags.name,
        active: 1,
        threshold: 0,
        code: `osm:${el.id}`,
        source: 'osm',
      },
      shapes,
    ),
  )
}
log(`  ${osm.elements.length} written`)

const expected = 16 + kreise.length + 7
if (taken.size !== expected)
  throw new Error(`expected ${expected} distinct regions, placed ${taken.size} — a region was overwritten`)

console.log(out.join('\n\n'))
log(`\ndone — ${taken.size} regions, ${parts.toLocaleString('de-DE')} rings, ${points.toLocaleString('de-DE')} boundary points`)
