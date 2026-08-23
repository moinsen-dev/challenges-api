import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Env, HonoApp, audit } from './lib'
import { sweepRetention } from './retention'
import { retryDue } from './webhooks'
import { admin } from './routes/admin'
import { identity } from './routes/identity'
import { compete } from './routes/compete'
import { collect } from './routes/collect'
import { social } from './routes/social'
import { access } from './routes/access'
import { developers } from './routes/developers'
import { recovery } from './routes/recovery'
import { live } from './routes/live'
import { hooks } from './routes/hooks'
import { verify } from './routes/verify'
import { tournaments } from './routes/tournaments'
import { ceremony } from './routes/ceremony'
import { meta } from './routes/meta'
import { console_ } from './routes/console'

const app = new Hono<HonoApp>()

app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Content-Type', 'Authorization', 'X-App-Key', 'X-Admin-Key'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
)

app.get('/v1/status', (c) =>
  c.json({
    service: 'challenges-api',
    version: '1.0.0',
    persistence: 'd1',
    capabilities: [
      'identity',
      'regions',
      'entries',
      'aggregations:best,sum,count,streak',
      'qualifications',
      'leaderboards',
      'challenges',
      'matches',
      'ratings:glicko2',
      'titles',
      'badges',
      'collections',
      'events',
      'daily-seed',
      'profiles',
      'follows',
      'blocks',
      'reports',
      'invites',
      'waitlists',
      'developer-accounts',
      'sign-in:github,email-link',
      'key-rotation',
      'audit-log',
      'passkeys',
      'player-sessions',
      'account-recovery',
      'sse',
      'presence',
      'matchmaking',
      'join-tickets',
      'webhooks',
      'replay-verification',
      'usage-metering',
      'tournaments',
      'ghosts',
      'title-cards',
      'openapi',
      'health',
    ],
  }),
)

app.route('/', admin)
app.route('/', identity)
app.route('/', compete)
app.route('/', collect)
app.route('/', social)
app.route('/', access)
app.route('/', developers)
app.route('/', console_)
app.route('/', recovery)
app.route('/', live)
app.route('/', hooks)
app.route('/', verify)
app.route('/', tournaments)
app.route('/', ceremony)
app.route('/', meta)

app.notFound((c) => c.json({ error: 'unknown route' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal error', detail: String(err) }, 500)
})

/**
 * The retention sweep belongs on a schedule, not in somebody's memory. Once a
 * day is enough: nothing here is urgent, and everything here is a promise we
 * printed in a privacy policy.
 */
const scheduled: ExportedHandlerScheduledHandler<Env> = async (event, env, ctx) => {
  ctx.waitUntil(
    (async () => {
      const purged = await sweepRetention(env.DB)
      // Deliveries that failed earlier get their next attempt here, so a
      // customer's outage does not turn into lost events.
      const retried = await retryDue(env)
      await audit(env.DB, { kind: 'system', label: 'cron' }, 'retention.swept', event.cron, {
        ...purged,
        webhooks_retried: retried,
      })
      console.log('cron', JSON.stringify({ ...purged, webhooks_retried: retried }))
    })(),
  )
}

export default { fetch: app.fetch, scheduled }

/** The Hono instance itself, so the OpenAPI document can be checked against it. */
export { app }
