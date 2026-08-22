import { Discipline, id, now, record } from './lib'
import * as projection from './projection'

export type TitleReport = {
  awarded: {
    /** false if the title already existed and this run changed nothing. */
    fresh?: boolean
    discipline: string
    region: string
    level: number
    player_id: string
    handle: string
    value: number
    contenders: number
  }[]
  skipped: { discipline: string; region: string; reason: string; contenders: number }[]
}

/**
 * Season close. A title only exists if the region had enough contenders and
 * there is a unique winner — a district champion without opponents devalues
 * the whole ladder, which is why the minimum is code and not marketing.
 *
 */
export async function awardTitles(
  db: D1Database,
  seasonId: string,
  opts: { dryRun?: boolean } = {},
): Promise<TitleReport> {
  const report: TitleReport = { awarded: [], skipped: [] }

  const disciplines = await db
    .prepare(`SELECT * FROM disciplines WHERE max_title_level >= 1`)
    .all<Discipline>()

  for (const d of disciplines.results) {
    for (let level = 1; level <= d.max_title_level; level++) {
      const regions = await db
        .prepare(`SELECT id, name FROM regions WHERE level = ? AND active = 1`)
        .bind(level)
        .all<{ id: string; name: string }>()

      for (const region of regions.results) {
        // Only the top two rows and the count are needed to decide a title:
        // a winner, whether it is unique, and whether the field was big enough.
        const top = await projection.page(db, d, seasonId, { regionId: region.id, level }, { limit: 2 })
        const rows = top.rows
        if (rows.length === 0) continue

        if (top.total < d.title_min_players) {
          report.skipped.push({
            discipline: d.slug,
            region: region.id,
            reason: `too few contenders (${top.total} of ${d.title_min_players})`,
            contenders: top.total,
          })
          continue
        }
        if (rows.length > 1 && rows[0].value === rows[1].value) {
          report.skipped.push({
            discipline: d.slug,
            region: region.id,
            reason: 'no unique winner',
            contenders: top.total,
          })
          continue
        }

        const winner = rows[0]
        let freshlyAwarded = true
        if (!opts.dryRun) {
          const titleId = id('ttl')
          const inserted = await db
            .prepare(
              `INSERT INTO titles
                 (id, player_id, discipline_id, season_id, region_id, level, value_at, contenders, awarded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT DO NOTHING`,
            )
            .bind(
              titleId,
              winner.player_id,
              d.id,
              seasonId,
              region.id,
              level,
              winner.value,
              top.total,
              now(),
            )
            .run()
          // A title already awarded does not fire a second event.
          freshlyAwarded = inserted.meta.changes > 0
          if (freshlyAwarded)
            await record(db, d.app_id, winner.player_id, 'title.awarded', {
              discipline: d.slug,
              region: region.id,
              level,
              value: winner.value,
              contenders: rows.length,
            })
        }

        report.awarded.push({
          fresh: freshlyAwarded,
          discipline: d.slug,
          region: region.id,
          level,
          player_id: winner.player_id,
          handle: winner.handle,
          value: winner.value,
          contenders: top.total,
        })
      }
    }
  }
  return report
}
