import { Hono } from 'hono'
import { HonoApp, id, now, record, requireApp, requireAppSecret, requirePlayer } from '../lib'
import { evaluateBadges } from '../badges'

export const collect = new Hono<HonoApp>()

/**
 * Collections are the second half of the generalisation: a collector app does
 * not measure a score but completeness. A badge on a complete collection is
 * the same machine as a title on a leaderboard.
 */

collect.post('/v1/collections', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const body = await c.req.json<{ slug: string; name: string }>()
  const collectionId = id('col')
  await c.env.DB.prepare(
    `INSERT INTO collections (id, app_id, slug, name) VALUES (?, ?, ?, ?)`,
  )
    .bind(collectionId, app.id, body.slug, body.name)
    .run()
  return c.json({ id: collectionId, ...body }, 201)
})

collect.post('/v1/collections/:slug/items', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const collection = await c.env.DB.prepare(
    `SELECT id FROM collections WHERE app_id = ? AND slug = ?`,
  )
    .bind(app.id, c.req.param('slug'))
    .first<{ id: string }>()
  if (!collection) return c.json({ error: 'unknown collection' }, 404)

  const body = await c.req.json<{ items: { slug: string; name: string; rarity?: string }[] }>()
  await c.env.DB.batch(
    body.items.map((item) =>
      c.env.DB.prepare(
        `INSERT INTO collection_items (id, collection_id, slug, name, rarity) VALUES (?, ?, ?, ?, ?)`,
      ).bind(id('itm'), collection.id, item.slug, item.name, item.rarity ?? 'common'),
    ),
  )
  return c.json({ collection: c.req.param('slug'), added: body.items.length }, 201)
})

/** Granting is authority: a client must not gift itself anything. */
collect.post('/v1/collections/:slug/grant', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const body = await c.req.json<{ handle: string; item: string; count?: number }>()
  const row = await c.env.DB.prepare(
    `SELECT ci.id, p.id AS player_id FROM collection_items ci
       JOIN collections c ON c.id = ci.collection_id
       CROSS JOIN players p
      WHERE c.app_id = ? AND c.slug = ? AND ci.slug = ? AND p.handle = ?`,
  )
    .bind(app.id, c.req.param('slug'), body.item, body.handle)
    .first<{ id: string; player_id: string }>()
  if (!row) return c.json({ error: 'unknown item or unknown player' }, 404)

  await c.env.DB.prepare(
    `INSERT INTO player_items (player_id, item_id, count, acquired_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (player_id, item_id) DO UPDATE SET count = player_items.count + excluded.count`,
  )
    .bind(row.player_id, row.id, body.count ?? 1, now())
    .run()
  await record(c.env.DB, app.id, row.player_id, 'item.acquired', {
    collection: c.req.param('slug'),
    item: body.item,
  })

  const badges = await evaluateBadges(c.env.DB, row.player_id, app.id)
  return c.json({ granted: body.item, to: body.handle, badges_earned: badges }, 201)
})

collect.get('/v1/collections/:slug', requireApp, requirePlayer, async (c) => {
  const app = c.get('app')!
  const player = c.get('player')!
  const collection = await c.env.DB.prepare(
    `SELECT id, slug, name FROM collections WHERE app_id = ? AND slug = ?`,
  )
    .bind(app.id, c.req.param('slug'))
    .first<{ id: string; slug: string; name: string }>()
  if (!collection) return c.json({ error: 'unknown collection' }, 404)

  const items = await c.env.DB.prepare(
    `SELECT ci.slug, ci.name, ci.rarity, COALESCE(pi.count, 0) AS owned
       FROM collection_items ci
       LEFT JOIN player_items pi ON pi.item_id = ci.id AND pi.player_id = ?
      WHERE ci.collection_id = ? ORDER BY ci.slug`,
  )
    .bind(player.id, collection.id)
    .all<{ slug: string; owned: number }>()

  const owned = items.results.filter((i) => i.owned > 0).length
  return c.json({
    ...collection,
    total: items.results.length,
    owned,
    complete: items.results.length > 0 && owned === items.results.length,
    items: items.results,
  })
})
