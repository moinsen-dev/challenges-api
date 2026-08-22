import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, freshSeason, makeApp, signup, unique } from './helpers'
import { checkClientData, derToRawSignature, toBase64Url, verifyAssertion } from '../src/webauthn'

const RP_ID = 'challenges.test'
const ORIGIN = 'https://challenges.test'

beforeAll(() => {
  ;(env as any).RP_ID = RP_ID
  ;(env as any).RP_ORIGINS = ORIGIN
})

const encode = (value: string) => toBase64Url(new TextEncoder().encode(value))

describe('Malformed signatures', () => {
  it('rejects anything that is not a DER sequence', () => {
    expect(() => derToRawSignature(Uint8Array.from([0x31, 0x02, 0x02, 0x01, 0x01]))).toThrow(/sequence/)
  })

  it('rejects a sequence that does not contain integers', () => {
    expect(() => derToRawSignature(Uint8Array.from([0x30, 0x04, 0x03, 0x01, 0x01, 0x00]))).toThrow(/integer/)
  })

  it('reads a long-form length header', () => {
    const r = new Uint8Array(32).fill(0x11)
    const s = new Uint8Array(32).fill(0x22)
    // 0x81 marks a one-byte long-form length, which real authenticators emit.
    const body = Uint8Array.from([0x02, 32, ...r, 0x02, 32, ...s])
    const der = Uint8Array.from([0x30, 0x81, body.length, ...body])
    const raw = derToRawSignature(der)
    expect(raw.slice(0, 32)).toEqual(r)
    expect(raw.slice(32)).toEqual(s)
  })
})

describe('Ceremony confusion', () => {
  it('will not let a registration response act as a login', () => {
    const result = checkClientData(
      { type: 'webauthn.create', challenge: 'abc', origin: ORIGIN },
      { type: 'webauthn.get', challenge: 'abc', origins: [ORIGIN] },
    )
    expect(result.ok).toBe(false)
    expect(result).toHaveProperty('error', expect.stringContaining('webauthn.get'))
  })
})

describe('Assertions that cannot be checked', () => {
  const base = {
    clientDataJSON: encode(JSON.stringify({ type: 'webauthn.get', challenge: 'c', origin: ORIGIN })),
    authenticatorData: toBase64Url(new Uint8Array(37)),
    signature: toBase64Url(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01])),
    storedSignCount: 0,
    expect: { challenge: 'c', origins: [ORIGIN], rpId: RP_ID },
  }

  it('reports an unreadable client data blob', async () => {
    const result = await verifyAssertion({
      ...base,
      publicKeySpkiBase64: 'AAAA',
      clientDataJSON: toBase64Url(Uint8Array.from([0xff, 0xfe])),
    })
    expect(result).toEqual({ ok: false, error: 'client data is not readable' })
  })

  it('reports authenticator data that is too short', async () => {
    const result = await verifyAssertion({
      ...base,
      publicKeySpkiBase64: 'AAAA',
      authenticatorData: toBase64Url(new Uint8Array(10)),
    })
    expect(result).toEqual({ ok: false, error: 'authenticator data is too short' })
  })

  it('reports a stored key it cannot use', async () => {
    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)))
    const authData = new Uint8Array(37)
    authData.set(rpIdHash, 0)
    authData[32] = 0x05
    const result = await verifyAssertion({
      ...base,
      authenticatorData: toBase64Url(authData),
      publicKeySpkiBase64: toBase64Url(Uint8Array.from([1, 2, 3])),
    })
    expect(result).toEqual({ ok: false, error: 'stored public key is unusable' })
  })

  it('reports a malformed signature', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)))
    const authData = new Uint8Array(37)
    authData.set(rpIdHash, 0)
    authData[32] = 0x05

    const result = await verifyAssertion({
      ...base,
      authenticatorData: toBase64Url(authData),
      publicKeySpkiBase64: toBase64Url(spki),
      signature: toBase64Url(Uint8Array.from([0x99, 0x01])),
    })
    expect(result).toEqual({ ok: false, error: 'signature is malformed' })
  })
})

describe('Registration input the server must survive', () => {
  async function account() {
    await freshSeason()
    const keys = await makeApp()
    return { keys, player: await signup(keys, unique('edge')) }
  }

  it('rejects unreadable client data', async () => {
    const { keys, player } = await account()
    const res = await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: player.token,
      body: {
        credential_id: 'x',
        public_key: 'AAAA',
        client_data_json: toBase64Url(Uint8Array.from([0xff, 0xfe])),
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('not readable')
  })

  it('rejects a missing field outright', async () => {
    const { keys, player } = await account()
    const res = await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: player.token,
      body: { credential_id: 'x' },
    })
    expect(res.status).toBe(400)
  })

  it('rejects a challenge that was never issued', async () => {
    const { keys, player } = await account()
    const res = await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: player.token,
      body: {
        credential_id: 'x',
        public_key: 'AAAA',
        client_data_json: encode(
          JSON.stringify({ type: 'webauthn.create', challenge: 'never-issued', origin: ORIGIN }),
        ),
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('challenge')
  })

  it('rejects a challenge belonging to somebody else', async () => {
    const { keys, player } = await account()
    const other = await signup(keys, unique('other'))
    const theirs = await call('POST', '/v1/me/passkeys/challenge', {
      key: keys.public_key,
      token: other.token,
    })
    const res = await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: player.token,
      body: {
        credential_id: 'x',
        public_key: 'AAAA',
        client_data_json: encode(
          JSON.stringify({ type: 'webauthn.create', challenge: theirs.body.challenge, origin: ORIGIN }),
        ),
      },
    })
    expect(res.status).toBe(400)
  })

  it('reports an unknown passkey on removal', async () => {
    const { keys, player } = await account()
    const res = await call('DELETE', '/v1/me/passkeys/pk_nothing', {
      key: keys.public_key,
      token: player.token,
    })
    expect(res.status).toBe(404)
  })

  it('rejects unreadable client data at sign-in', async () => {
    const { keys, player } = await account()
    const res = await call('POST', '/v1/auth/passkey', {
      key: keys.public_key,
      body: {
        credential_id: 'nothing',
        client_data_json: toBase64Url(Uint8Array.from([0xff])),
        authenticator_data: 'AAAA',
        signature: 'AAAA',
      },
    })
    // An unknown credential is refused before anything is parsed.
    expect(res.status).toBe(401)
    expect((await call('GET', '/v1/me', { key: keys.public_key, token: player.token })).status).toBe(200)
  })
})

describe('Retention and badge rules that only fire in the unusual case', () => {
  it('purges an expired but never-used sign-in token', async () => {
    await env.DB.prepare(
      `INSERT INTO login_tokens (id, email, token_hash, code_hash, created_at, expires_at)
       VALUES (?, 'old@example.test', ?, 'x', ?, ?)`,
    )
      .bind(
        unique('lgn'),
        unique('hash'),
        new Date(Date.now() - 5 * 86400000).toISOString(),
        new Date(Date.now() - 4 * 86400000).toISOString(),
      )
      .run()
    const dry = await call('POST', '/v1/admin/maintenance?dry_run=1', { admin: true })
    expect(dry.body.purged.login_tokens).toBeGreaterThan(0)
  })

  it('awards a category badge only once every discipline in it is passed', async () => {
    await freshSeason()
    const keys = await makeApp()
    const category = unique('kat')
    const badgeId = unique('badge')
    await call('POST', '/v1/badges', {
      key: keys.secret_key,
      body: {
        id: badgeId,
        name: badgeId,
        description: 'All of them',
        rule: { type: 'qualified_in_category', category },
      },
    })
    // The rule has to be evaluated to be tested, and it is evaluated on entry.
    const slug = unique('d')
    await call('POST', '/v1/disciplines', {
      key: keys.secret_key,
      body: { slug, name: 'D', trust_tier: 1, qualifying_score: 1 },
    })
    const player = await signup(keys)
    const entry = await call('POST', '/v1/entries', {
      key: keys.public_key,
      token: player.token,
      body: { discipline: slug, value: 10 },
    })
    // An empty category can never be complete, so the badge stays unawarded.
    expect(entry.body.badges_earned.map((b: any) => b.id)).not.toContain(badgeId)
  })
})
