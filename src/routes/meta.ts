import { Hono } from 'hono'
import { HonoApp, now } from './../lib'
import { buildDocument } from '../openapi'

export const meta = new Hono<HonoApp>()

/** The machine-readable description of this instance. */
meta.get('/v1/openapi.json', (c) => c.json(buildDocument(new URL(c.req.url).origin)))

/**
 * Health, with the checks actually performed rather than a hardcoded "ok".
 *
 * A status endpoint that cannot fail is decoration. This one touches the
 * database and the blob store, and reports the queue depths somebody would
 * want to see before asking whether something is wrong.
 */
meta.get('/v1/health', async (c) => {
  const checks: Record<string, { ok: boolean; ms: number; detail?: string }> = {}

  const timed = async (name: string, work: () => Promise<unknown>) => {
    const started = Date.now()
    try {
      await work()
      checks[name] = { ok: true, ms: Date.now() - started }
    } catch (error) {
      checks[name] = { ok: false, ms: Date.now() - started, detail: String(error).slice(0, 120) }
    }
  }

  await timed('database', () => c.env.DB.prepare(`SELECT 1 AS ok`).first())
  await timed('blobs', () => c.env.BLOBS.head('health-probe'))

  const [season, queues, cron] = await Promise.all([
    c.env.DB.prepare(`SELECT id, name, ends_at FROM seasons WHERE status = 'open' LIMIT 1`).first(),
    c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM verification_jobs WHERE state = 'queued') AS verification,
         (SELECT COUNT(*) FROM webhook_deliveries WHERE state = 'pending') AS webhooks,
         (SELECT COUNT(*) FROM entries WHERE status = 'review') AS review,
         (SELECT COUNT(*) FROM reports WHERE state = 'open') AS reports`,
    ).first(),
    c.env.DB.prepare(
      `SELECT created_at FROM audit_log WHERE action = 'retention.swept' ORDER BY id DESC LIMIT 1`,
    ).first<{ created_at: string }>(),
  ])

  const healthy = Object.values(checks).every((check) => check.ok)
  return c.json(
    {
      status: healthy ? 'ok' : 'degraded',
      checked_at: now(),
      checks,
      season,
      queues,
      last_maintenance: cron?.created_at ?? null,
    },
    healthy ? 200 : 503,
  )
})
