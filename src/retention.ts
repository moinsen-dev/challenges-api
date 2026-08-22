import { now } from './lib'

/**
 * Storage limitation as code instead of as a statement of intent
 * (Art. 5(1)(e) GDPR). Run by a cron trigger once a day, and callable by the
 * operator for a dry run.
 *
 * Deliberately conservative: only what has demonstrably served its purpose is
 * deleted. Entries and titles stay — they are the competition itself and
 * disappear with the account, not with time.
 */
export const RETENTION_POLICY = {
  link_codes: 'used or expired, older than 1 day',
  events: 'older than 180 days',
  sessions: 'unused for 730 days',
  developer_sessions: 'expired or revoked, older than 30 days',
  login_tokens: 'used or expired, older than 1 day',
  oauth_states: 'used or expired, older than 1 day',
  entries: 'kept until the account is deleted',
} as const

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

export async function sweepRetention(db: D1Database, opts: { dryRun?: boolean } = {}) {
  const jobs = [
    {
      name: 'link_codes',
      where: `used_at IS NOT NULL OR expires_at < ?`,
      binds: [daysAgo(1)],
    },
    { name: 'events', where: `created_at < ?`, binds: [daysAgo(180)] },
    { name: 'sessions', where: `last_seen < ?`, binds: [daysAgo(730)] },
    {
      name: 'developer_sessions',
      where: `(revoked_at IS NOT NULL OR expires_at < ?) AND created_at < ?`,
      binds: [now(), daysAgo(30)],
    },
    {
      name: 'login_tokens',
      where: `(used_at IS NOT NULL OR expires_at < ?) AND created_at < ?`,
      binds: [now(), daysAgo(1)],
    },
    {
      name: 'oauth_states',
      where: `(used_at IS NOT NULL OR expires_at < ?) AND created_at < ?`,
      binds: [now(), daysAgo(1)],
    },
  ]

  const purged: Record<string, number> = {}
  for (const job of jobs) {
    const found = await db
      .prepare(`SELECT COUNT(*) AS n FROM ${job.name} WHERE ${job.where}`)
      .bind(...job.binds)
      .first<{ n: number }>()
    purged[job.name] = found?.n ?? 0
    if (!opts.dryRun && purged[job.name] > 0)
      await db
        .prepare(`DELETE FROM ${job.name} WHERE ${job.where}`)
        .bind(...job.binds)
        .run()
  }
  return purged
}
