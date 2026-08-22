/**
 * The small, load-bearing part of WebAuthn.
 *
 * We do not verify attestation and do not care which authenticator was used —
 * only that the same one comes back. That removes the need for a CBOR parser
 * and removes nothing that protects an account: an attacker registering a key
 * they control to an account they are already signed in to has achieved
 * nothing.
 *
 * What is verified, because leaving any of it out turns this into theatre:
 *
 *   * the ceremony type — a registration response cannot be replayed as a login
 *   * the challenge — issued by us, single use, short lived
 *   * the origin — a page on another domain cannot drive our ceremony
 *   * the RP id hash inside the authenticator data
 *   * the user-presence flag
 *   * the signature itself, over exactly what the spec says
 *   * the signature counter, when the authenticator keeps one
 */

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Authenticators sign with DER-encoded ECDSA. WebCrypto wants the raw r||s
 * pair. Forgetting this conversion is the classic reason a correct signature
 * verifies as false.
 */
export function derToRawSignature(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error('not a DER sequence')
  let offset = 2
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f)

  const read = () => {
    if (der[offset] !== 0x02) throw new Error('not a DER integer')
    const length = der[offset + 1]
    let start = offset + 2
    let end = start + length
    // Strip the sign byte DER adds when the high bit would look negative.
    while (der[start] === 0x00 && end - start > 32) start++
    offset = end
    const value = der.slice(start, end)
    const padded = new Uint8Array(32)
    padded.set(value, 32 - value.length)
    return padded
  }

  const r = read()
  const s = read()
  const raw = new Uint8Array(64)
  raw.set(r, 0)
  raw.set(s, 32)
  return raw
}

const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', data))

export type ClientData = { type: string; challenge: string; origin: string; crossOrigin?: boolean }

export type CheckResult = { ok: true } | { ok: false; error: string }

/** Shared by both ceremonies: this is where impersonation is stopped. */
export function checkClientData(
  clientData: ClientData,
  expect: { type: 'webauthn.create' | 'webauthn.get'; challenge: string; origins: string[] },
): CheckResult {
  if (clientData.type !== expect.type)
    return { ok: false, error: `wrong ceremony: expected ${expect.type}` }
  if (clientData.challenge !== expect.challenge) return { ok: false, error: 'challenge does not match' }
  if (!expect.origins.includes(clientData.origin))
    return { ok: false, error: `origin ${clientData.origin} is not allowed` }
  return { ok: true }
}

export type AssertionInput = {
  publicKeySpkiBase64: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
  storedSignCount: number
  expect: { challenge: string; origins: string[]; rpId: string }
}

export type AssertionResult =
  | { ok: true; signCount: number }
  | { ok: false; error: string }

export async function verifyAssertion(input: AssertionInput): Promise<AssertionResult> {
  let clientData: ClientData
  try {
    clientData = JSON.parse(new TextDecoder().decode(fromBase64Url(input.clientDataJSON)))
  } catch {
    return { ok: false, error: 'client data is not readable' }
  }

  const basics = checkClientData(clientData, {
    type: 'webauthn.get',
    challenge: input.expect.challenge,
    origins: input.expect.origins,
  })
  if (!basics.ok) return basics

  const authData = fromBase64Url(input.authenticatorData)
  if (authData.length < 37) return { ok: false, error: 'authenticator data is too short' }

  const expectedRpIdHash = await sha256(new TextEncoder().encode(input.expect.rpId))
  for (let i = 0; i < 32; i++)
    if (authData[i] !== expectedRpIdHash[i]) return { ok: false, error: 'this key belongs to another site' }

  const flags = authData[32]
  if ((flags & 0x01) === 0) return { ok: false, error: 'the person was not present' }

  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0)
  // A counter that goes backwards means the credential was cloned. Only
  // meaningful when the authenticator keeps one at all — many report zero.
  if (signCount !== 0 && signCount <= input.storedSignCount)
    return { ok: false, error: 'signature counter did not advance' }

  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey(
      'spki',
      fromBase64Url(input.publicKeySpkiBase64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
  } catch {
    return { ok: false, error: 'stored public key is unusable' }
  }

  let rawSignature: Uint8Array
  try {
    rawSignature = derToRawSignature(fromBase64Url(input.signature))
  } catch {
    return { ok: false, error: 'signature is malformed' }
  }

  const clientDataHash = await sha256(fromBase64Url(input.clientDataJSON))
  const signedOver = new Uint8Array(authData.length + clientDataHash.length)
  signedOver.set(authData, 0)
  signedOver.set(clientDataHash, authData.length)

  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    rawSignature,
    signedOver,
  )
  if (!valid) return { ok: false, error: 'signature does not verify' }
  return { ok: true, signCount }
}
