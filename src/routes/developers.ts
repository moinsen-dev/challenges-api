import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context, Next } from 'hono'
import { HonoApp, audit, id, mintKey, now, secret, sha256, KEY_PREFIX } from '../lib'
import { usageForMonth } from '../usage'

export const developers = new Hono<HonoApp>()

const SESSION_COOKIE = 'chapi_dev'
const SESSION_DAYS = 30
const STATE_MINUTES = 10

type Developer = {
  id: string
  provider: string
  session_started?: string
  login: string
  name: string | null
  email: string | null
  avatar_url: string | null
  two_factor: number
  app_quota: number
}

/**
 * Mint one public and one secret key for an app.
 *
 * The value is shown to the caller exactly once and never stored — only its
 * SHA-256 hash and its prefix, so a key can be listed and recognised without
 * ever being readable again.
 */
export async function issueKeyPair(db: D1Database, appId: string, developerId: string | null) {
  const publicKey = mintKey('public')
  const secretKey = mintKey('secret')
  await db.batch([
    db
      .prepare(
        `INSERT INTO api_keys (id, app_id, kind, key_hash, prefix, name, created_by, created_at)
         VALUES (?, ?, 'public', ?, ?, 'initial', ?, ?)`,
      )
      .bind(id('key'), appId, await sha256(publicKey), KEY_PREFIX.public, developerId, now()),
    db
      .prepare(
        `INSERT INTO api_keys (id, app_id, kind, key_hash, prefix, name, created_by, created_at)
         VALUES (?, ?, 'secret', ?, ?, 'initial', ?, ?)`,
      )
      .bind(id('key'), appId, await sha256(secretKey), KEY_PREFIX.secret, developerId, now()),
  ])
  return { public_key: publicKey, secret_key: secretKey }
}

// ------------------------------------------------------------------- session

async function currentDeveloper(c: Context<HonoApp>): Promise<Developer | null> {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null
  const hash = await sha256(token)
  const row = await c.env.DB.prepare(
    `SELECT d.*, s.expires_at, s.revoked_at, s.created_at AS session_started
       FROM developer_sessions s
       JOIN developers d ON d.id = s.developer_id
      WHERE s.token_hash = ?`,
  )
    .bind(hash)
    .first<Developer & { expires_at: string; revoked_at: string | null; session_started: string }>()
  if (!row || row.revoked_at) return null
  if (Date.parse(row.expires_at) < Date.now()) return null
  await c.env.DB.prepare(`UPDATE developer_sessions SET last_seen = ? WHERE token_hash = ?`)
    .bind(now(), hash)
    .run()
  return row
}

export async function requireDeveloper(c: Context<HonoApp>, next: Next) {
  const dev = await currentDeveloper(c)
  if (!dev) return c.json({ error: 'developer sign-in required' }, 401)
  c.set('developer', dev)
  await next()
}

/** An app belongs to exactly one developer account. */
async function ownedApp(c: Context<HonoApp>, slug: string) {
  const dev = c.get('developer')!
  return c.env.DB.prepare(`SELECT id, slug, name, owner_id FROM apps WHERE slug = ? AND owner_id = ?`)
    .bind(slug, dev.id)
    .first<{ id: string; slug: string; name: string }>()
}

/**
 * Who may hold a developer account on this instance.
 *
 * `DEV_ALLOWLIST` is a comma-separated list; an empty or missing value means
 * the instance is open, which is what a self-hoster wants. Entries:
 *
 *   @moinsen.dev        every verified address at that domain
 *   uli@example.com     one exact address
 *   github:octocat      one GitHub login, regardless of address
 *
 * Checked on every sign-in, not only at first contact: removing somebody from
 * the list has to lock them out, or it is not an allowlist.
 */
function allowedToSignIn(
  env: HonoApp['Bindings'],
  who: { provider: 'github' | 'email'; email: string | null; login?: string },
): boolean {
  const entries = (env.DEV_ALLOWLIST ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  if (entries.length === 0) return true

  const email = who.email?.trim().toLowerCase() ?? null
  const login = who.login?.trim().toLowerCase() ?? null
  return entries.some((entry) => {
    if (entry.startsWith('github:')) return who.provider === 'github' && login === entry.slice(7)
    if (entry.startsWith('@')) return Boolean(email && email.endsWith(entry))
    return email === entry
  })
}

/**
 * The address GitHub will vouch for.
 *
 * `/user` also carries an `email`, but it is whatever the person typed into
 * their public profile — unverified, and changeable to anything. Basing access
 * on it would let somebody claim an address they do not own. Only a verified
 * address from `/user/emails` is evidence.
 */
async function verifiedGitHubEmail(accessToken: string): Promise<string | null> {
  const res = await fetch('https://api.github.com/user/emails', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'challenges-api',
    },
  })
  if (!res.ok) return null
  const list = await res.json<{ email: string; primary: boolean; verified: boolean }[]>()
  if (!Array.isArray(list)) return null
  const verified = list.filter((e) => e.verified)
  return (verified.find((e) => e.primary) ?? verified[0])?.email?.toLowerCase() ?? null
}

// -------------------------------------------------------------- GitHub OAuth

developers.get('/v1/dev/auth/github', async (c) => {
  if (!c.env.GITHUB_CLIENT_ID) return c.json({ error: 'GitHub sign-in is not configured' }, 501)

  // Single-use, short-lived, stored server side: a callback cannot be replayed
  // and cannot be triggered from another site.
  const state = secret()
  await c.env.DB.prepare(
    `INSERT INTO oauth_states (state, redirect, created_at, expires_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(
      await sha256(state),
      c.req.query('redirect') ?? null,
      now(),
      new Date(Date.now() + STATE_MINUTES * 60_000).toISOString(),
    )
    .run()

  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID)
  url.searchParams.set('scope', 'read:user user:email')
  url.searchParams.set('state', state)
  if (c.env.GITHUB_CALLBACK_URL) url.searchParams.set('redirect_uri', c.env.GITHUB_CALLBACK_URL)
  return c.redirect(url.toString(), 302)
})

developers.get('/v1/dev/auth/github/callback', async (c) => {
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET)
    return c.json({ error: 'GitHub sign-in is not configured' }, 501)

  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) return c.json({ error: 'code and state required' }, 400)

  const stateHash = await sha256(state)
  const stored = await c.env.DB.prepare(
    `SELECT state, redirect, expires_at, used_at FROM oauth_states WHERE state = ?`,
  )
    .bind(stateHash)
    .first<{ redirect: string | null; expires_at: string; used_at: string | null }>()
  if (!stored || stored.used_at) return c.json({ error: 'invalid state' }, 400)
  if (Date.parse(stored.expires_at) < Date.now()) return c.json({ error: 'state expired' }, 400)
  await c.env.DB.prepare(`UPDATE oauth_states SET used_at = ? WHERE state = ?`)
    .bind(now(), stateHash)
    .run()

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  })
  const tokenBody = await tokenRes.json<{ access_token?: string; error?: string }>()
  if (!tokenBody.access_token)
    return c.json({ error: 'GitHub rejected the code', detail: tokenBody.error ?? null }, 401)

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'challenges-api',
    },
  })
  if (!userRes.ok) return c.json({ error: 'GitHub profile unreadable' }, 401)
  const profile = await userRes.json<{
    id: number
    login: string
    name?: string | null
    email?: string | null
    avatar_url?: string | null
    two_factor_authentication?: boolean
  }>()

  // Only a verified address is evidence of anything.
  const email = await verifiedGitHubEmail(tokenBody.access_token)
  if (!allowedToSignIn(c.env, { provider: 'github', email, login: profile.login })) {
    await audit(c.env.DB, { kind: 'system', label: 'sign-in' }, 'developer.rejected', null, {
      provider: 'github',
      login: profile.login,
    })
    return c.json(
      { error: 'this instance does not accept sign-ins from this account' },
      403,
    )
  }

  const existing = await c.env.DB.prepare(
    `SELECT id FROM developers WHERE provider = 'github' AND provider_id = ?`,
  )
    .bind(String(profile.id))
    .first<{ id: string }>()

  const devId = existing?.id ?? id('dev')
  const twoFactor = profile.two_factor_authentication ? 1 : 0
  if (existing) {
    await c.env.DB.prepare(
      `UPDATE developers SET login = ?, name = ?, email = ?, avatar_url = ?, two_factor = ?, last_seen = ?
        WHERE id = ?`,
    )
      .bind(profile.login, profile.name ?? null, email, profile.avatar_url ?? null, twoFactor, now(), devId)
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO developers (id, provider, provider_id, login, name, email, avatar_url, two_factor, created_at, last_seen)
       VALUES (?, 'github', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(devId, String(profile.id), profile.login, profile.name ?? null, email, profile.avatar_url ?? null, twoFactor, now(), now())
      .run()
    await audit(c.env.DB, { kind: 'developer', id: devId, label: profile.login }, 'developer.created', devId)
  }

  await startSession(c, devId)
  await audit(c.env.DB, { kind: 'developer', id: devId, label: profile.login }, 'developer.signed_in', devId)

  const target = stored.redirect ?? c.env.CONSOLE_ORIGIN
  return target ? c.redirect(target, 302) : c.json({ signed_in: true, login: profile.login })
})

/** One place that mints a console session, used by every sign-in path. */
async function startSession(c: Context<HonoApp>, developerId: string) {
  const token = secret()
  await c.env.DB.prepare(
    `INSERT INTO developer_sessions (token_hash, developer_id, user_agent, created_at, expires_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256(token),
      developerId,
      (c.req.header('User-Agent') ?? '').slice(0, 200),
      now(),
      new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(),
      now(),
    )
    .run()
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  })
}

developers.post('/v1/dev/logout', requireDeveloper, async (c) => {
  const token = getCookie(c, SESSION_COOKIE)!
  await c.env.DB.prepare(`UPDATE developer_sessions SET revoked_at = ? WHERE token_hash = ?`)
    .bind(now(), await sha256(token))
    .run()
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ signed_out: true })
})

developers.get('/v1/dev/me', requireDeveloper, async (c) => {
  const dev = c.get('developer')!
  const apps = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM apps WHERE owner_id = ?`)
    .bind(dev.id)
    .first<{ n: number }>()
  return c.json({
    id: dev.id,
    provider: dev.provider,
    login: dev.login,
    name: dev.name,
    email: dev.email,
    avatar_url: dev.avatar_url,
    two_factor: Boolean(dev.two_factor),
    apps: apps?.n ?? 0,
    app_quota: dev.app_quota,
  })
})

developers.get('/v1/dev/sessions', requireDeveloper, async (c) => {
  const dev = c.get('developer')!
  const rows = await c.env.DB.prepare(
    `SELECT substr(token_hash, 1, 8) AS id, user_agent, created_at, last_seen, expires_at
       FROM developer_sessions
      WHERE developer_id = ? AND revoked_at IS NULL ORDER BY last_seen DESC`,
  )
    .bind(dev.id)
    .all()
  return c.json({ sessions: rows.results })
})

developers.post('/v1/dev/sessions/revoke-others', requireDeveloper, async (c) => {
  const dev = c.get('developer')!
  const token = getCookie(c, SESSION_COOKIE)!
  const res = await c.env.DB.prepare(
    `UPDATE developer_sessions SET revoked_at = ?
      WHERE developer_id = ? AND revoked_at IS NULL AND token_hash != ?`,
  )
    .bind(now(), dev.id, await sha256(token))
    .run()
  await audit(c.env.DB, { kind: 'developer', id: dev.id, label: dev.login }, 'sessions.revoked_others', dev.id)
  return c.json({ revoked: res.meta.changes })
})

// -------------------------------------------------------- Email magic link

const LINK_MINUTES = 15
const CODE_ATTEMPTS = 5
const LINKS_PER_HOUR = 5
/** How fresh a session must be before an email account may mint a secret key. */
const STEP_UP_MINUTES = 15

const normaliseEmail = (raw: string) => raw.trim().toLowerCase()
const looksLikeEmail = (raw: string) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(raw)
const sixDigits = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0')

async function sendMagicLink(
  env: HonoApp['Bindings'],
  to: string,
  link: string,
  code: string,
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to,
      subject: `Your sign-in code: ${code}`,
      text: [
        'Sign in to the Challenges API console.',
        '',
        `Open this link:  ${link}`,
        `Or type this code in the tab you started from:  ${code}`,
        '',
        `Both expire in ${LINK_MINUTES} minutes and work once.`,
        'If you did not ask for this, you can ignore this mail — nothing happened.',
      ].join('\n'),
    }),
  })
  return res.ok
}

developers.post('/v1/dev/auth/email', async (c) => {
  const body = await c.req.json<{ email: string; redirect?: string }>().catch(() => ({}) as { email?: string })
  const email = normaliseEmail(body.email ?? '')
  if (!looksLikeEmail(email)) return c.json({ error: 'a valid email address is required' }, 400)
  if (!c.env.RESEND_API_KEY || !c.env.MAIL_FROM)
    return c.json({ error: 'email sign-in is not configured' }, 501)

  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?`,
  )
    .bind(email, new Date(Date.now() - 3600_000).toISOString())
    .first<{ n: number }>()

  // The answer is the same whether we sent anything or not: this endpoint must
  // never become a way to ask whether an address has an account here.
  const accepted = { sent: true, expires_in_minutes: LINK_MINUTES }
  if ((recent?.n ?? 0) >= LINKS_PER_HOUR) return c.json(accepted, 202)
  // Not on the list: same answer, no mail. Nobody learns who may sign in here,
  // and nobody outside gets a mail they did not ask for.
  if (!allowedToSignIn(c.env, { provider: 'email', email })) return c.json(accepted, 202)

  const token = secret()
  const code = sixDigits()
  await c.env.DB.prepare(
    `INSERT INTO login_tokens (id, email, token_hash, code_hash, redirect, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id('lgn'),
      email,
      await sha256(token),
      await sha256(`${email}:${code}`),
      body.redirect ?? null,
      now(),
      new Date(Date.now() + LINK_MINUTES * 60_000).toISOString(),
    )
    .run()

  const base = c.env.MAIL_LINK_BASE ?? new URL(c.req.url).origin
  await sendMagicLink(c.env, email, `${base}/v1/dev/auth/email/callback?token=${token}`, code)
  return c.json(accepted, 202)
})

/** Turn a valid login token into a developer and a session. */
async function completeEmailSignIn(c: Context<HonoApp>, row: { id: string; email: string; redirect: string | null }) {
  await c.env.DB.prepare(`UPDATE login_tokens SET used_at = ? WHERE id = ?`).bind(now(), row.id).run()
  // Using one link invalidates the others: a forwarded older mail is dead.
  await c.env.DB.prepare(
    `UPDATE login_tokens SET used_at = ? WHERE email = ? AND used_at IS NULL`,
  )
    .bind(now(), row.email)
    .run()

  const existing = await c.env.DB.prepare(
    `SELECT id, login FROM developers WHERE provider = 'email' AND provider_id = ?`,
  )
    .bind(row.email)
    .first<{ id: string; login: string }>()

  const devId = existing?.id ?? id('dev')
  if (existing) {
    await c.env.DB.prepare(`UPDATE developers SET last_seen = ? WHERE id = ?`).bind(now(), devId).run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO developers (id, provider, provider_id, login, email, two_factor, created_at, last_seen)
       VALUES (?, 'email', ?, ?, ?, 0, ?, ?)`,
    )
      .bind(devId, row.email, row.email.split('@')[0], row.email, now(), now())
      .run()
    await audit(c.env.DB, { kind: 'developer', id: devId, label: row.email }, 'developer.created', devId)
  }

  await startSession(c, devId)
  await audit(c.env.DB, { kind: 'developer', id: devId, label: row.email }, 'developer.signed_in', devId)
  return devId
}

developers.get('/v1/dev/auth/email/callback', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'token required' }, 400)
  const row = await c.env.DB.prepare(
    `SELECT id, email, redirect, expires_at, used_at FROM login_tokens WHERE token_hash = ?`,
  )
    .bind(await sha256(token))
    .first<{ id: string; email: string; redirect: string | null; expires_at: string; used_at: string | null }>()
  if (!row || row.used_at) return c.json({ error: 'this link is no longer valid' }, 400)
  if (Date.parse(row.expires_at) < Date.now()) return c.json({ error: 'this link has expired' }, 400)

  await completeEmailSignIn(c, row)
  const target = row.redirect ?? c.env.CONSOLE_ORIGIN
  return target ? c.redirect(target, 302) : c.json({ signed_in: true, email: row.email })
})

/**
 * The code path, for the common case where the mail opens on a different
 * device than the browser you started in. Same-browser by construction.
 */
developers.post('/v1/dev/auth/email/verify', async (c) => {
  const body = await c.req.json<{ email: string; code: string }>().catch(() => ({}) as Record<string, string>)
  const email = normaliseEmail(body.email ?? '')
  if (!looksLikeEmail(email) || !/^\d{6}$/.test(body.code ?? ''))
    return c.json({ error: 'email and a six-digit code are required' }, 400)

  const row = await c.env.DB.prepare(
    `SELECT id, email, redirect, code_hash, attempts, expires_at, used_at
       FROM login_tokens WHERE email = ? AND used_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email)
    .first<{
      id: string
      email: string
      redirect: string | null
      code_hash: string
      attempts: number
      expires_at: string
    }>()
  if (!row || Date.parse(row.expires_at) < Date.now())
    return c.json({ error: 'no valid code for this address' }, 400)

  if ((await sha256(`${email}:${body.code}`)) !== row.code_hash) {
    const attempts = row.attempts + 1
    // Six digits are a million possibilities. Without this they are decoration.
    if (attempts >= CODE_ATTEMPTS) {
      await c.env.DB.prepare(`UPDATE login_tokens SET used_at = ?, attempts = ? WHERE id = ?`)
        .bind(now(), attempts, row.id)
        .run()
      return c.json({ error: 'too many attempts, request a new code' }, 429)
    }
    await c.env.DB.prepare(`UPDATE login_tokens SET attempts = ? WHERE id = ?`)
      .bind(attempts, row.id)
      .run()
    return c.json({ error: 'wrong code', attempts_left: CODE_ATTEMPTS - attempts }, 401)
  }

  await completeEmailSignIn(c, row)
  return c.json({ signed_in: true, email })
})

// ----------------------------------------------------------------- own apps

developers.post('/v1/dev/apps', requireDeveloper, async (c) => {
  const dev = c.get('developer')!
  const { slug, name } = await c.req.json<{ slug: string; name: string }>()
  if (!/^[a-z0-9][a-z0-9-]{2,38}$/.test(slug ?? ''))
    return c.json({ error: 'slug must be 3-39 characters of a-z, 0-9 and dashes' }, 400)

  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM apps WHERE owner_id = ?`)
    .bind(dev.id)
    .first<{ n: number }>()
  if ((count?.n ?? 0) >= dev.app_quota)
    return c.json({ error: 'app quota reached', quota: dev.app_quota }, 409)

  if (await c.env.DB.prepare(`SELECT id FROM apps WHERE slug = ?`).bind(slug).first())
    return c.json({ error: 'slug taken' }, 409)

  const appId = id('app')
  await c.env.DB.prepare(
    `INSERT INTO apps (id, slug, name, access_mode, invites_per_player, owner_id, created_at)
     VALUES (?, ?, ?, 'open', 0, ?, ?)`,
  )
    .bind(appId, slug, name ?? slug, dev.id, now())
    .run()
  const keys = await issueKeyPair(c.env.DB, appId, dev.id)
  await audit(c.env.DB, { kind: 'developer', id: dev.id, label: dev.login }, 'app.created', appId, { slug })

  return c.json({ id: appId, slug, name: name ?? slug, ...keys }, 201)
})

developers.get('/v1/dev/apps', requireDeveloper, async (c) => {
  const dev = c.get('developer')!
  const rows = await c.env.DB.prepare(
    `SELECT a.slug, a.name, a.access_mode, a.created_at,
            (SELECT COUNT(*) FROM disciplines d WHERE d.app_id = a.id) AS disciplines,
            (SELECT COUNT(*) FROM player_apps pa WHERE pa.app_id = a.id) AS players,
            (SELECT COUNT(*) FROM api_keys k WHERE k.app_id = a.id AND k.revoked_at IS NULL) AS live_keys
       FROM apps a WHERE a.owner_id = ? ORDER BY a.created_at DESC`,
  )
    .bind(dev.id)
    .all()
  return c.json({ apps: rows.results })
})

// --------------------------------------------------------------------- keys

developers.get('/v1/dev/apps/:slug/keys', requireDeveloper, async (c) => {
  const app = await ownedApp(c, c.req.param('slug'))
  if (!app) return c.json({ error: 'unknown app' }, 404)
  const rows = await c.env.DB.prepare(
    `SELECT k.id, k.kind, k.prefix, k.name, k.created_at, k.last_used_at,
            k.expires_at, k.revoked_at, k.revoke_reason, d.login AS created_by
       FROM api_keys k LEFT JOIN developers d ON d.id = k.created_by
      WHERE k.app_id = ? ORDER BY k.created_at DESC`,
  )
    .bind(app.id)
    .all()
  // The key itself is never returned again — only what you need to decide
  // whether it is still in use and safe to retire.
  return c.json({ app: app.slug, keys: rows.results })
})

developers.post('/v1/dev/apps/:slug/keys', requireDeveloper, async (c) => {
  const dev = c.get('developer')!
  const app = await ownedApp(c, c.req.param('slug'))
  if (!app) return c.json({ error: 'unknown app' }, 404)
  const body = await c.req.json<{ kind: 'public' | 'secret'; name?: string; expires_in_days?: number }>()
  if (!['public', 'secret'].includes(body.kind))
    return c.json({ error: 'kind must be "public" or "secret"' }, 400)

  // A secret key can take an entire competition apart, so minting one asks for
  // a second, recent proof — never just a cookie that has been lying around.
  //
  //   GitHub account  -> two-factor at the provider
  //   Email account   -> a sign-in from the last few minutes, which means
  //                      somebody just proved they hold the mailbox
  //
  // Public keys stay available either way, so nobody is locked out of their app.
  if (body.kind === 'secret') {
    const fresh =
      dev.session_started && Date.now() - Date.parse(dev.session_started) < STEP_UP_MINUTES * 60_000
    if (dev.provider === 'email' && !fresh)
      return c.json(
        {
          error: 'sign in again to mint a secret key',
          reason: `an email account must have signed in within the last ${STEP_UP_MINUTES} minutes`,
        },
        403,
      )
    if (dev.provider !== 'email' && !dev.two_factor)
      return c.json(
        { error: 'a secret key requires two-factor authentication on your sign-in provider' },
        403,
      )
  }

  const value = mintKey(body.kind)
  const keyId = id('key')
  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, app_id, kind, key_hash, prefix, name, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      keyId,
      app.id,
      body.kind,
      await sha256(value),
      KEY_PREFIX[body.kind],
      body.name ?? 'rotated',
      dev.id,
      now(),
      body.expires_in_days ? new Date(Date.now() + body.expires_in_days * 86_400_000).toISOString() : null,
    )
    .run()
  await audit(c.env.DB, { kind: 'developer', id: dev.id, label: dev.login }, 'key.created', keyId, {
    app: app.slug,
    kind: body.kind,
  })

  // Both keys stay valid until the old one is revoked. Rotation without a gap
  // is the only kind anybody actually performs.
  return c.json({ id: keyId, kind: body.kind, key: value, name: body.name ?? 'rotated' }, 201)
})

developers.post('/v1/dev/keys/:id/revoke', requireDeveloper, async (c) => {
  const dev = c.get('developer')!
  const { reason } = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string })
  const key = await c.env.DB.prepare(
    `SELECT k.id, k.kind, k.revoked_at, a.slug, a.owner_id
       FROM api_keys k JOIN apps a ON a.id = k.app_id WHERE k.id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; kind: string; revoked_at: string | null; slug: string; owner_id: string | null }>()
  if (!key || key.owner_id !== dev.id) return c.json({ error: 'unknown key' }, 404)
  if (key.revoked_at) return c.json({ error: 'already revoked' }, 409)

  const live = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM api_keys k JOIN apps a ON a.id = k.app_id
      WHERE a.slug = ? AND k.kind = ? AND k.revoked_at IS NULL`,
  )
    .bind(key.slug, key.kind)
    .first<{ n: number }>()
  // Refusing to revoke the last live key of a kind is not paternalism: it is
  // the difference between rotating a key and taking a game offline.
  if ((live?.n ?? 0) <= 1)
    return c.json({ error: `create a replacement ${key.kind} key before revoking the last one` }, 409)

  await c.env.DB.prepare(
    `UPDATE api_keys SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?`,
  )
    .bind(now(), dev.id, reason ?? null, key.id)
    .run()
  await audit(c.env.DB, { kind: 'developer', id: dev.id, label: dev.login }, 'key.revoked', key.id, {
    app: key.slug,
    reason: reason ?? null,
  })
  return c.json({ id: key.id, revoked: true })
})

/**
 * What this app has consumed this month, against the free allowance.
 *
 * Every line the pricing page meters, as a number the owner can look at. It
 * charges nothing — there is no rate switched on — but "free up to 100,000
 * entries" is a promise, and a promise nobody can check is just a sentence.
 */
developers.get('/v1/dev/apps/:slug/usage', requireDeveloper, async (c) => {
  const app = await ownedApp(c, c.req.param('slug'))
  if (!app) return c.json({ error: 'unknown app' }, 404)
  const month = c.req.query('month') ?? now().slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: 'month must be YYYY-MM' }, 400)
  return c.json({ app: app.slug, ...(await usageForMonth(c.env.DB, app.id, month)) })
})

developers.get('/v1/dev/audit', requireDeveloper, async (c) => {
  const dev = c.get('developer')!
  const rows = await c.env.DB.prepare(
    `SELECT action, subject, detail, created_at FROM audit_log
      WHERE actor_kind = 'developer' AND actor_id = ? ORDER BY id DESC LIMIT 100`,
  )
    .bind(dev.id)
    .all<{ detail: string | null }>()
  return c.json({
    entries: rows.results.map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null })),
  })
})
