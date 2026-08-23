/**
 * Turning a position into a district.
 *
 * The rule from the vision holds here: a district is the finest resolution
 * that ever gets stored, and a coordinate is never written down. This module
 * is the one place a latitude and longitude are looked at, and it looks at
 * them without keeping them.
 */

export type ResolvedRegion = {
  id: string
  name: string
  level: number
  parent_id: string | null
  active: number
  unlock_threshold: number
}

/**
 * Ray casting against a ring of [lon, lat] pairs. A point on the boundary is
 * arbitrary but consistent, which is all a district assignment needs.
 */
export function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * The smallest region whose boundary contains the point.
 *
 * Candidates are RINGS, ordered small to large, so the first ring that contains
 * the point belongs to the finest region that does. Ordering whole regions this
 * way looks equivalent and is not: a district with a distant exclave carries a
 * bounding box wider than the city around it, and resolves to the city.
 *
 * The level breaks a tie, and it has to: a city state is one boundary filed
 * twice, as a Bundesland and as a Kreis, with a box identical to the last
 * decimal. Berlin resolved to its Bundesland until this was ordered.
 */
export async function resolveRegion(
  db: D1Database,
  lat: number,
  lon: number,
): Promise<ResolvedRegion | null> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.name, r.level, r.parent_id, r.active, r.unlock_threshold, s.ring
         FROM region_shapes s JOIN regions r ON r.id = s.region_id
        WHERE ? BETWEEN s.min_lat AND s.max_lat
          AND ? BETWEEN s.min_lon AND s.max_lon
        ORDER BY s.area ASC, r.level ASC`,
    )
    .bind(lat, lon)
    .all<ResolvedRegion & { ring: string }>()

  for (const row of results) {
    if (inRing(lon, lat, JSON.parse(row.ring) as number[][])) {
      const { ring: _drop, ...region } = row
      return region
    }
  }
  return null
}

/**
 * The chain from a region up to the world, nearest first.
 *
 * One query rather than a walk: a district sits six levels below the world, and
 * six sequential round trips is a poor way to spend an edge request. The depth
 * bound is a cycle guard — nothing enforces that a parent is not also a child.
 */
export async function regionChain(
  db: D1Database,
  regionId: string,
): Promise<{ id: string; name: string; level: number; active: number }[]> {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE chain(id, name, level, active, parent_id, depth) AS (
         SELECT id, name, level, active, parent_id, 0 FROM regions WHERE id = ?
         UNION ALL
         SELECT r.id, r.name, r.level, r.active, r.parent_id, c.depth + 1
           FROM regions r JOIN chain c ON r.id = c.parent_id
          WHERE c.depth < 8
       )
       SELECT id, name, level, active FROM chain ORDER BY depth`,
    )
    .bind(regionId)
    .all<{ id: string; name: string; level: number; active: number }>()
  return results
}
