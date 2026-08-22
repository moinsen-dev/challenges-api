/**
 * HMAC signing, shared by join tickets and webhooks.
 *
 * Both answer the same question for somebody who is not us: "did this really
 * come from the platform, and has it been altered?" A signature answers it
 * without a round trip, which is the whole point — a match server should not
 * have to call us to find out whether the player who just connected is who
 * they claim to be.
 */

const encoder = new TextEncoder()

async function key(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

const toHex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function sign(secret: string, payload: string): Promise<string> {
  return toHex(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload)))
}

/** Constant-time comparison, so a signature cannot be guessed byte by byte. */
export async function verify(secret: string, payload: string, signature: string): Promise<boolean> {
  const expected = await sign(secret, payload)
  if (expected.length !== signature.length) return false
  let difference = 0
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return difference === 0
}

export type JoinTicket = {
  pairing: string
  player: string
  handle: string
  discipline: string
  expires: number
}

/**
 * A join ticket: proof that this player belongs in this match, checkable by
 * the app's own match server with nothing but its signing secret.
 */
export async function issueTicket(secret: string, claims: JoinTicket): Promise<string> {
  const body = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${body}.${await sign(secret, body)}`
}

export type TicketCheck =
  | { ok: true; claims: JoinTicket }
  | { ok: false; error: string }

export async function readTicket(secret: string, ticket: string): Promise<TicketCheck> {
  const [body, signature] = ticket.split('.')
  if (!body || !signature) return { ok: false, error: 'malformed ticket' }
  if (!(await verify(secret, body, signature))) return { ok: false, error: 'signature does not verify' }

  let claims: JoinTicket
  try {
    claims = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return { ok: false, error: 'ticket body is not readable' }
  }
  // An expired ticket is refused here rather than left to the caller, because
  // the caller is the one place that would forget.
  if (claims.expires * 1000 < Date.now()) return { ok: false, error: 'ticket has expired' }
  return { ok: true, claims }
}

/**
 * Webhook signature, in the shape everybody already knows from Stripe:
 * `t=<unix>,v1=<hex>` over `<t>.<body>`. The timestamp is inside the signed
 * payload so a captured delivery cannot be replayed a day later.
 */
export async function signDelivery(secret: string, body: string, at = Date.now()) {
  const timestamp = Math.floor(at / 1000)
  return `t=${timestamp},v1=${await sign(secret, `${timestamp}.${body}`)}`
}

export async function verifyDelivery(
  secret: string,
  header: string,
  body: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]))
  const timestamp = Number(parts.t)
  if (!timestamp || !parts.v1) return false
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false
  return verify(secret, `${timestamp}.${body}`, parts.v1)
}
