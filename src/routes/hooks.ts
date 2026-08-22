import { Hono } from 'hono'
import { HonoApp, audit, id, now, requireAdmin, requireAppSecret, secret } from '../lib'
import { retryDue } from '../webhooks'

export const hooks = new Hono<HonoApp>()

/**
 * Webhook endpoints belong to an app and are managed with its secret key —
 * a URL that receives events is authority, not decoration.
 */

hooks.post('/v1/webhooks', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const body = await c.req.json<{ url: string; events?: string[] }>()
  let parsed: URL
  try {
    parsed = new URL(body.url)
  } catch {
    return c.json({ error: 'url is not a valid URL' }, 400)
  }
  if (parsed.protocol !== 'https:') return c.json({ error: 'url must be https' }, 400)

  const signingSecret = `whsec_${secret()}`
  const hookId = id('wh')
  await c.env.DB.prepare(
    `INSERT INTO webhooks (id, app_id, url, secret, events, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(hookId, app.id, parsed.toString(), signingSecret, (body.events ?? ['*']).join(','), now())
    .run()
  await audit(c.env.DB, { kind: 'developer', label: app.slug }, 'webhook.created', hookId, {
    url: parsed.host,
  })

  // Shown once, the way every other secret here is.
  return c.json({ id: hookId, url: parsed.toString(), secret: signingSecret }, 201)
})

hooks.get('/v1/webhooks', requireAppSecret, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT w.id, w.url, w.events, w.active, w.created_at, w.last_success, w.last_error,
            (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.state = 'pending') AS pending,
            (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.state = 'failed') AS failed
       FROM webhooks w WHERE w.app_id = ? ORDER BY w.created_at DESC`,
  )
    .bind(c.get('app')!.id)
    .all()
  return c.json({ webhooks: rows.results })
})

hooks.delete('/v1/webhooks/:id', requireAppSecret, async (c) => {
  const res = await c.env.DB.prepare(`UPDATE webhooks SET active = 0 WHERE id = ? AND app_id = ?`)
    .bind(c.req.param('id'), c.get('app')!.id)
    .run()
  if (!res.meta.changes) return c.json({ error: 'unknown webhook' }, 404)
  return c.json({ id: c.req.param('id'), active: false })
})

hooks.get('/v1/webhooks/:id/deliveries', requireAppSecret, async (c) => {
  const hook = await c.env.DB.prepare(`SELECT id FROM webhooks WHERE id = ? AND app_id = ?`)
    .bind(c.req.param('id'), c.get('app')!.id)
    .first()
  if (!hook) return c.json({ error: 'unknown webhook' }, 404)
  const rows = await c.env.DB.prepare(
    `SELECT id, event_type, state, attempts, last_status, last_error, created_at, delivered_at
       FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(c.req.param('id'))
    .all()
  return c.json({ deliveries: rows.results })
})

hooks.post('/v1/admin/webhooks/retry', requireAdmin, async (c) =>
  c.json({ retried: await retryDue(c.env) }),
)
