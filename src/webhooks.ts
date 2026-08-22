import { HonoApp, id, now } from './lib'
import { signDelivery } from './signing'

/**
 * Webhook delivery.
 *
 * An attempt is made immediately, because the common case is that it works and
 * nobody should wait a minute for the normal path. A failure is written down
 * with a next attempt time and picked up by the same cron that sweeps
 * retention — so a delivery survives a customer's deploy, an outage, or a
 * certificate that expired over the weekend.
 */

const BACKOFF_SECONDS = [30, 120, 600, 3600, 21600]
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1

const nextTry = (attempts: number) =>
  new Date(Date.now() + (BACKOFF_SECONDS[attempts - 1] ?? 21600) * 1000).toISOString()

/** Queue an event for every endpoint of an app that wants it, then try once. */
export async function deliver(
  env: HonoApp['Bindings'],
  appId: string,
  type: string,
  payload: unknown,
): Promise<number> {
  const hooks = await env.DB.prepare(`SELECT id, url, secret, events FROM webhooks WHERE app_id = ? AND active = 1`)
    .bind(appId)
    .all<{ id: string; url: string; secret: string; events: string }>()

  const interested = hooks.results.filter(
    (hook) => hook.events === '*' || hook.events.split(',').map((e) => e.trim()).includes(type),
  )
  if (interested.length === 0) return 0

  const body = JSON.stringify({ type, payload, created_at: now() })
  for (const hook of interested) {
    const deliveryId = id('whd')
    await env.DB.prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, next_try_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(deliveryId, hook.id, type, body, now(), now())
      .run()
    await attempt(env, { id: deliveryId, webhook_id: hook.id, payload: body, attempts: 0 }, hook)
  }
  return interested.length
}

type Delivery = { id: string; webhook_id: string; payload: string; attempts: number }
type Hook = { id: string; url: string; secret: string }

async function attempt(env: HonoApp['Bindings'], delivery: Delivery, hook: Hook) {
  const attempts = delivery.attempts + 1
  let status: number | null = null
  let error: string | null = null

  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Challenges-Signature': await signDelivery(hook.secret, delivery.payload),
        'X-Challenges-Event': JSON.parse(delivery.payload).type,
        'X-Challenges-Delivery': delivery.id,
      },
      body: delivery.payload,
    })
    status = response.status
    if (!response.ok) error = `endpoint answered ${response.status}`
  } catch (failure) {
    error = String(failure).slice(0, 200)
  }

  if (!error) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE webhook_deliveries SET state = 'delivered', attempts = ?, last_status = ?, delivered_at = ?
          WHERE id = ?`,
      ).bind(attempts, status, now(), delivery.id),
      env.DB.prepare(`UPDATE webhooks SET last_success = ?, last_error = NULL WHERE id = ?`).bind(
        now(),
        hook.id,
      ),
    ])
    return
  }

  // Giving up is a state, not silence: the delivery stays visible as failed.
  const exhausted = attempts >= MAX_ATTEMPTS
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE webhook_deliveries SET state = ?, attempts = ?, last_status = ?, last_error = ?, next_try_at = ?
        WHERE id = ?`,
    ).bind(exhausted ? 'failed' : 'pending', attempts, status, error, nextTry(attempts), delivery.id),
    env.DB.prepare(`UPDATE webhooks SET last_error = ? WHERE id = ?`).bind(error, hook.id),
  ])
}

/** Retry whatever is due. Called by the cron, and by the operator on demand. */
export async function retryDue(env: HonoApp['Bindings'], limit = 50) {
  const due = await env.DB.prepare(
    `SELECT d.id, d.webhook_id, d.payload, d.attempts, w.url, w.secret
       FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.state = 'pending' AND d.next_try_at <= ? AND w.active = 1
      ORDER BY d.next_try_at LIMIT ?`,
  )
    .bind(now(), limit)
    .all<Delivery & { url: string; secret: string }>()

  for (const row of due.results) {
    await attempt(env, row, { id: row.webhook_id, url: row.url, secret: row.secret })
  }
  return due.results.length
}
