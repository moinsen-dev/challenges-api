import { Hono } from 'hono'
import {
  HonoApp,
  audit,
  currentSeason,
  id,
  now,
  record,
  requireApp,
  requirePlayer,
  secret,
  sha256,
} from '../lib'
import { checkClientData, fromBase64Url, verifyAssertion } from '../webauthn'

export const recovery = new Hono<HonoApp>()

const CHALLENGE_MINUTES = 5
const RECOVERY_MINUTES = 15
const RECOVERY_PER_HOUR = 5

const origins = (env: HonoApp['Bindings']) =>
  (env.RP_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)
const rpId = (env: HonoApp['Bindings']) => env.RP_ID ?? ''

async function mintChallenge(
  db: D1Database,
  purpose: 'register' | 'authenticate',
  playerId: string | null,
) {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const challenge = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  await db
    .prepare(
      `INSERT INTO webauthn_challenges (challenge, player_id, purpose, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      challenge,
      playerId,
      purpose,
      now(),
      new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString(),
    )
    .run()
  return challenge
}

/** Burn a challenge and report whether it was usable. Single use, always. */
async function claimChallenge(db: D1Database, challenge: string, purpose: string) {
  const row = await db
    .prepare(`SELECT challenge, player_id, purpose, expires_at, used_at FROM webauthn_challenges WHERE challenge = ?`)
    .bind(challenge)
    .first<{ player_id: string | null; purpose: string; expires_at: string; used_at: string | null }>()
  if (!row || row.used_at || row.purpose !== purpose) return null
  if (Date.parse(row.expires_at) < Date.now()) return null
  await db.prepare(`UPDATE webauthn_challenges SET used_at = ? WHERE challenge = ?`).bind(now(), challenge).run()
  return row
}

// ---------------------------------------------------------------- passkeys

recovery.post('/v1/me/passkeys/challenge', requireApp, requirePlayer, async (c) => {
  if (!rpId(c.env) || origins(c.env).length === 0)
    return c.json({ error: 'passkeys are not configured on this instance' }, 501)
  const player = c.get('player')!
  const existing = await c.env.DB.prepare(`SELECT credential_id FROM passkeys WHERE player_id = ?`)
    .bind(player.id)
    .all<{ credential_id: string }>()
  return c.json({
    challenge: await mintChallenge(c.env.DB, 'register', player.id),
    rp: { id: rpId(c.env), name: 'Challenges' },
    user: { id: player.id, name: player.handle, displayName: player.handle },
    // Offering the ones already registered stops a duplicate for the same key.
    exclude: existing.results.map((r) => r.credential_id),
    timeout_ms: CHALLENGE_MINUTES * 60_000,
  })
})

recovery.post('/v1/me/passkeys', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const body = await c.req.json<{
    credential_id: string
    public_key: string
    algorithm?: number
    client_data_json: string
    label?: string
  }>()
  if (!body.credential_id || !body.public_key || !body.client_data_json)
    return c.json({ error: 'credential_id, public_key and client_data_json are required' }, 400)

  let clientData
  try {
    clientData = JSON.parse(new TextDecoder().decode(fromBase64Url(body.client_data_json)))
  } catch {
    return c.json({ error: 'client data is not readable' }, 400)
  }

  const claimed = await claimChallenge(c.env.DB, clientData.challenge, 'register')
  if (!claimed || claimed.player_id !== player.id)
    return c.json({ error: 'challenge is unknown, used or expired' }, 400)

  const checked = checkClientData(clientData, {
    type: 'webauthn.create',
    challenge: clientData.challenge,
    origins: origins(c.env),
  })
  if (!checked.ok) return c.json({ error: checked.error }, 400)

  // Verify the key is one we can actually check a signature with — better to
  // fail here than on the day somebody needs to sign in.
  try {
    await crypto.subtle.importKey(
      'spki',
      fromBase64Url(body.public_key),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
  } catch {
    return c.json({ error: 'public key is not a usable P-256 key' }, 400)
  }

  const passkeyId = id('pk')
  try {
    await c.env.DB.prepare(
      `INSERT INTO passkeys (id, player_id, credential_id, public_key, algorithm, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        passkeyId,
        player.id,
        body.credential_id,
        body.public_key,
        body.algorithm ?? -7,
        (body.label ?? 'passkey').slice(0, 40),
        now(),
      )
      .run()
  } catch {
    return c.json({ error: 'this passkey is already registered' }, 409)
  }

  await record(c.env.DB, c.get('app')!.id, player.id, 'passkey.added', { id: passkeyId })
  return c.json({ id: passkeyId, label: body.label ?? 'passkey' }, 201)
})

recovery.get('/v1/me/passkeys', requireApp, requirePlayer, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, label, created_at, last_used_at FROM passkeys WHERE player_id = ? ORDER BY created_at`,
  )
    .bind(c.get('player')!.id)
    .all()
  return c.json({ passkeys: rows.results })
})

recovery.delete('/v1/me/passkeys/:id', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const res = await c.env.DB.prepare(`DELETE FROM passkeys WHERE id = ? AND player_id = ?`)
    .bind(c.req.param('id'), player.id)
    .run()
  if (!res.meta.changes) return c.json({ error: 'unknown passkey' }, 404)
  await record(c.env.DB, c.get('app')!.id, player.id, 'passkey.removed', { id: c.req.param('id') })
  return c.json({ removed: c.req.param('id') })
})

recovery.post('/v1/auth/passkey/challenge', requireApp, async (c) => {
  if (!rpId(c.env) || origins(c.env).length === 0)
    return c.json({ error: 'passkeys are not configured on this instance' }, 501)
  const body = await c.req.json<{ handle?: string }>().catch(() => ({}) as { handle?: string })

  let allow: string[] = []
  if (body.handle) {
    const rows = await c.env.DB.prepare(
      `SELECT k.credential_id FROM passkeys k JOIN players p ON p.id = k.player_id WHERE p.handle = ?`,
    )
      .bind(body.handle)
      .all<{ credential_id: string }>()
    allow = rows.results.map((r) => r.credential_id)
  }
  // An empty list is also the honest answer for a handle with no passkeys:
  // this endpoint must not become a way to ask who exists.
  return c.json({
    challenge: await mintChallenge(c.env.DB, 'authenticate', null),
    rp_id: rpId(c.env),
    allow,
    timeout_ms: CHALLENGE_MINUTES * 60_000,
  })
})

recovery.post('/v1/auth/passkey', requireApp, async (c) => {
  const app = c.get('app')!
  const body = await c.req.json<{
    credential_id: string
    client_data_json: string
    authenticator_data: string
    signature: string
  }>()

  const stored = await c.env.DB.prepare(
    `SELECT k.id, k.player_id, k.public_key, k.sign_count, p.status
       FROM passkeys k JOIN players p ON p.id = k.player_id WHERE k.credential_id = ?`,
  )
    .bind(body.credential_id ?? '')
    .first<{ id: string; player_id: string; public_key: string; sign_count: number; status: string }>()
  if (!stored) return c.json({ error: 'unknown passkey' }, 401)

  let clientData
  try {
    clientData = JSON.parse(new TextDecoder().decode(fromBase64Url(body.client_data_json)))
  } catch {
    return c.json({ error: 'client data is not readable' }, 400)
  }
  if (!(await claimChallenge(c.env.DB, clientData.challenge, 'authenticate')))
    return c.json({ error: 'challenge is unknown, used or expired' }, 400)

  const verified = await verifyAssertion({
    publicKeySpkiBase64: stored.public_key,
    clientDataJSON: body.client_data_json,
    authenticatorData: body.authenticator_data,
    signature: body.signature,
    storedSignCount: stored.sign_count,
    expect: { challenge: clientData.challenge, origins: origins(c.env), rpId: rpId(c.env) },
  })
  if (!verified.ok) {
    await audit(c.env.DB, { kind: 'system', label: 'passkey' }, 'passkey.rejected', stored.player_id, {
      reason: verified.error,
    })
    return c.json({ error: verified.error }, 401)
  }
  if (stored.status === 'banned') return c.json({ error: 'account is banned' }, 403)

  await c.env.DB.prepare(`UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?`)
    .bind(verified.signCount, now(), stored.id)
    .run()

  const token = await startPlayerSession(c.env.DB, stored.player_id, c.req.header('User-Agent'), 'passkey')
  await c.env.DB.prepare(
    `INSERT INTO player_apps (player_id, app_id, first_seen) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(stored.player_id, app.id, now())
    .run()
  await record(c.env.DB, app.id, stored.player_id, 'session.started', { via: 'passkey' })

  const player = await c.env.DB.prepare(`SELECT id, handle FROM players WHERE id = ?`)
    .bind(stored.player_id)
    .first()
  return c.json({ ...player, token }, 201)
})

// ------------------------------------------------------------- sessions

/** One place that mints a player session, used by every sign-in path. */
export async function startPlayerSession(
  db: D1Database,
  playerId: string,
  userAgent: string | undefined,
  label: string,
) {
  const token = secret()
  await db
    .prepare(
      `INSERT INTO sessions (token_hash, player_id, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(await sha256(token), playerId, `${label} · ${(userAgent ?? '').slice(0, 60)}`, now(), now())
    .run()
  return token
}

recovery.get('/v1/me/sessions', requireApp, requirePlayer, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT substr(token_hash, 1, 8) AS id, label, created_at, last_seen
       FROM sessions WHERE player_id = ? AND revoked_at IS NULL ORDER BY last_seen DESC`,
  )
    .bind(c.get('player')!.id)
    .all()
  return c.json({ sessions: rows.results })
})

recovery.post('/v1/me/sessions/revoke-others', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const auth = c.req.header('Authorization') ?? ''
  const current = await sha256(auth.slice(7))
  const res = await c.env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE player_id = ? AND revoked_at IS NULL AND token_hash != ?`,
  )
    .bind(now(), player.id, current)
    .run()
  await record(c.env.DB, c.get('app')!.id, player.id, 'sessions.revoked_others', {
    count: res.meta.changes,
  })
  // The lost phone stops being a way in, from the device still in your hand.
  return c.json({ revoked: res.meta.changes })
})

export { origins as allowedOrigins, rpId as relyingPartyId }

// ------------------------------------------------------- email as a rescue

/**
 * An account still needs no personal data. This is opt-in, exists for one
 * purpose — getting back in — and is the only place a player address is ever
 * stored. An address that was never verified can never recover anything.
 */

const normalise = (raw: string) => raw.trim().toLowerCase()
const looksLikeEmail = (raw: string) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(raw)

async function sendRecoveryMail(
  env: HonoApp['Bindings'],
  to: string,
  subject: string,
  lines: string[],
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text: lines.join('\n') }),
  })
  return res.ok
}

recovery.post('/v1/me/recovery-email', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const body = await c.req.json<{ email: string }>().catch(() => ({}) as { email?: string })
  const email = normalise(body.email ?? '')
  if (!looksLikeEmail(email)) return c.json({ error: 'a valid email address is required' }, 400)
  if (!c.env.RESEND_API_KEY || !c.env.MAIL_FROM)
    return c.json({ error: 'email recovery is not configured on this instance' }, 501)

  const token = secret()
  await c.env.DB.prepare(
    `INSERT INTO recovery_tokens (id, player_id, email, token_hash, purpose, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'verify', ?, ?)`,
  )
    .bind(
      id('rec'),
      player.id,
      email,
      await sha256(token),
      now(),
      new Date(Date.now() + RECOVERY_MINUTES * 60_000).toISOString(),
    )
    .run()

  const base = c.env.MAIL_LINK_BASE ?? new URL(c.req.url).origin
  await sendRecoveryMail(c.env, email, 'Confirm your rescue address', [
    `Confirm this address as the rescue route for "${player.handle}".`,
    '',
    `${base}/v1/auth/recovery/confirm?token=${token}`,
    '',
    `The link expires in ${RECOVERY_MINUTES} minutes and works once.`,
    'If you did not ask for this, ignore this mail — nothing was stored against you.',
  ])
  return c.json({ sent: true, expires_in_minutes: RECOVERY_MINUTES }, 202)
})

recovery.get('/v1/auth/recovery/confirm', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'token required' }, 400)
  const row = await c.env.DB.prepare(
    `SELECT id, player_id, email, expires_at, used_at FROM recovery_tokens
      WHERE token_hash = ? AND purpose = 'verify'`,
  )
    .bind(await sha256(token))
    .first<{ id: string; player_id: string; email: string; expires_at: string; used_at: string | null }>()
  if (!row || row.used_at) return c.json({ error: 'this link is no longer valid' }, 400)
  if (Date.parse(row.expires_at) < Date.now()) return c.json({ error: 'this link has expired' }, 400)

  const taken = await c.env.DB.prepare(
    `SELECT id FROM players WHERE recovery_email = ? AND id != ?`,
  )
    .bind(row.email, row.player_id)
    .first()
  if (taken) return c.json({ error: 'that address already rescues another account' }, 409)

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE recovery_tokens SET used_at = ? WHERE id = ?`).bind(now(), row.id),
    c.env.DB.prepare(
      `UPDATE players SET recovery_email = ?, recovery_verified_at = ? WHERE id = ?`,
    ).bind(row.email, now(), row.player_id),
  ])
  await record(c.env.DB, null, row.player_id, 'recovery.email_verified', {})
  return c.json({ verified: true, email: row.email })
})

recovery.delete('/v1/me/recovery-email', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  await c.env.DB.prepare(
    `UPDATE players SET recovery_email = NULL, recovery_verified_at = NULL WHERE id = ?`,
  )
    .bind(player.id)
    .run()
  await record(c.env.DB, c.get('app')!.id, player.id, 'recovery.email_removed', {})
  return c.json({ removed: true })
})

recovery.post('/v1/auth/recover', requireApp, async (c) => {
  const body = await c.req.json<{ email: string }>().catch(() => ({}) as { email?: string })
  const email = normalise(body.email ?? '')
  if (!looksLikeEmail(email)) return c.json({ error: 'a valid email address is required' }, 400)
  if (!c.env.RESEND_API_KEY || !c.env.MAIL_FROM)
    return c.json({ error: 'email recovery is not configured on this instance' }, 501)

  // Identical answer whether or not that address rescues anything.
  const accepted = { sent: true, expires_in_minutes: RECOVERY_MINUTES }

  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM recovery_tokens WHERE email = ? AND created_at > ?`,
  )
    .bind(email, new Date(Date.now() - 3600_000).toISOString())
    .first<{ n: number }>()
  if ((recent?.n ?? 0) >= RECOVERY_PER_HOUR) return c.json(accepted, 202)

  const player = await c.env.DB.prepare(
    `SELECT id, handle FROM players WHERE recovery_email = ? AND recovery_verified_at IS NOT NULL`,
  )
    .bind(email)
    .first<{ id: string; handle: string }>()
  if (!player) return c.json(accepted, 202)

  const token = secret()
  await c.env.DB.prepare(
    `INSERT INTO recovery_tokens (id, player_id, email, token_hash, purpose, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'recover', ?, ?)`,
  )
    .bind(
      id('rec'),
      player.id,
      email,
      await sha256(token),
      now(),
      new Date(Date.now() + RECOVERY_MINUTES * 60_000).toISOString(),
    )
    .run()

  const base = c.env.MAIL_LINK_BASE ?? new URL(c.req.url).origin
  await sendRecoveryMail(c.env, email, 'Get back into your account', [
    `Sign in again as "${player.handle}".`,
    '',
    `${base}/v1/auth/recover/callback?token=${token}`,
    '',
    `The link expires in ${RECOVERY_MINUTES} minutes and works once.`,
    'Opening it also ends every other session, so a lost device stops being a way in.',
  ])
  return c.json(accepted, 202)
})

recovery.get('/v1/auth/recover/callback', requireApp, async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'token required' }, 400)
  const row = await c.env.DB.prepare(
    `SELECT r.id, r.player_id, r.expires_at, r.used_at, p.handle, p.status
       FROM recovery_tokens r JOIN players p ON p.id = r.player_id
      WHERE r.token_hash = ? AND r.purpose = 'recover'`,
  )
    .bind(await sha256(token))
    .first<{
      id: string
      player_id: string
      expires_at: string
      used_at: string | null
      handle: string
      status: string
    }>()
  if (!row || row.used_at) return c.json({ error: 'this link is no longer valid' }, 400)
  if (Date.parse(row.expires_at) < Date.now()) return c.json({ error: 'this link has expired' }, 400)
  if (row.status === 'banned') return c.json({ error: 'account is banned' }, 403)

  // Recovering ends every other session. Whoever has the lost phone loses it.
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE recovery_tokens SET used_at = ? WHERE id = ?`).bind(now(), row.id),
    c.env.DB.prepare(
      `UPDATE sessions SET revoked_at = ? WHERE player_id = ? AND revoked_at IS NULL`,
    ).bind(now(), row.player_id),
  ])

  const fresh = await startPlayerSession(c.env.DB, row.player_id, c.req.header('User-Agent'), 'recovered')
  await record(c.env.DB, c.get('app')!.id, row.player_id, 'session.recovered', {})
  await audit(c.env.DB, { kind: 'system', label: 'recovery' }, 'player.recovered', row.player_id)
  return c.json({ id: row.player_id, handle: row.handle, token: fresh }, 201)
})
