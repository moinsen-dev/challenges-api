import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, freshSeason, makeApp, signup, unique } from './helpers'
import { derToRawSignature, fromBase64Url, toBase64Url } from '../src/webauthn'

const RP_ID = 'challenges.test'
const ORIGIN = 'https://challenges.test'

beforeAll(() => {
  ;(env as any).RP_ID = RP_ID
  ;(env as any).RP_ORIGINS = `${ORIGIN},https://second.test`
})

const encode = (value: string) => toBase64Url(new TextEncoder().encode(value))
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))

/**
 * A real authenticator, in software. It holds a real P-256 key pair, builds
 * the exact bytes a browser would send, and signs them the way the spec says —
 * so the server's verification is genuinely exercised, not simulated.
 */
async function authenticator(opts: { rpId?: string } = {}) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  const credentialId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  let counter = 0

  const clientData = (type: string, challenge: string, origin = ORIGIN) =>
    encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }))

  const authData = async (flags = 0x05, rpId = opts.rpId ?? RP_ID, count?: number) => {
    const hash = await sha256(new TextEncoder().encode(rpId))
    const bytes = new Uint8Array(37)
    bytes.set(hash, 0)
    bytes[32] = flags
    new DataView(bytes.buffer).setUint32(33, count ?? ++counter)
    return bytes
  }

  return {
    credentialId,
    publicKey: toBase64Url(spki),
    clientData,

    /** Everything a registration ceremony sends back. */
    register(challenge: string, label = 'test key') {
      return {
        credential_id: credentialId,
        public_key: toBase64Url(spki),
        client_data_json: clientData('webauthn.create', challenge),
        label,
      }
    },

    /** A signed assertion, DER-encoded exactly as an authenticator produces. */
    async assert(
      challenge: string,
      tweaks: { origin?: string; flags?: number; rpId?: string; count?: number; corrupt?: boolean } = {},
    ) {
      const cd = clientData('webauthn.get', challenge, tweaks.origin ?? ORIGIN)
      const ad = await authData(tweaks.flags ?? 0x05, tweaks.rpId, tweaks.count)
      const cdHash = await sha256(fromBase64Url(cd))
      const signedOver = new Uint8Array(ad.length + cdHash.length)
      signedOver.set(ad, 0)
      signedOver.set(cdHash, ad.length)

      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signedOver),
      )
      if (tweaks.corrupt) raw[10] ^= 0xff
      return {
        credential_id: credentialId,
        client_data_json: cd,
        authenticator_data: toBase64Url(ad),
        signature: toBase64Url(toDer(raw)),
      }
    },
  }
}

/** WebCrypto hands back r||s; a real authenticator sends DER. */
function toDer(raw: Uint8Array): Uint8Array {
  const trim = (part: Uint8Array) => {
    let start = 0
    while (start < part.length - 1 && part[start] === 0) start++
    const value = part.slice(start)
    return value[0] & 0x80 ? Uint8Array.from([0, ...value]) : value
  }
  const r = trim(raw.slice(0, 32))
  const s = trim(raw.slice(32))
  const body = Uint8Array.from([0x02, r.length, ...r, 0x02, s.length, ...s])
  return Uint8Array.from([0x30, body.length, ...body])
}

async function player() {
  await freshSeason()
  const keys = await makeApp()
  const account = await signup(keys, unique('passkey'))
  return { keys, account }
}

const challengeFor = async (keys: any, token: string) =>
  (await call('POST', '/v1/me/passkeys/challenge', { key: keys.public_key, token })).body

describe('DER signatures', () => {
  it('survives the round trip, including padded integers', async () => {
    for (let i = 0; i < 40; i++) {
      const raw = crypto.getRandomValues(new Uint8Array(64))
      expect(derToRawSignature(toDer(raw))).toEqual(raw)
    }
  })
})

describe('Registering a passkey', () => {
  it('needs the instance to be configured', async () => {
    const previous = (env as any).RP_ID
    ;(env as any).RP_ID = ''
    const { keys, account } = await player()
    const res = await call('POST', '/v1/me/passkeys/challenge', { key: keys.public_key, token: account.token })
    expect(res.status).toBe(501)
    ;(env as any).RP_ID = previous
  })

  it('registers, lists and removes one', async () => {
    const { keys, account } = await player()
    const device = await authenticator()
    const challenge = await challengeFor(keys, account.token)
    expect(challenge.rp.id).toBe(RP_ID)
    expect(challenge.user.name).toBe(account.handle)

    const added = await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: account.token,
      body: device.register(challenge.challenge, 'iPhone'),
    })
    expect(added.status).toBe(201)

    const listed = await call('GET', '/v1/me/passkeys', { key: keys.public_key, token: account.token })
    expect(listed.body.passkeys).toHaveLength(1)
    expect(listed.body.passkeys[0].label).toBe('iPhone')
    // The key material is never handed back out.
    expect(JSON.stringify(listed.body)).not.toContain(device.publicKey)

    const removed = await call('DELETE', `/v1/me/passkeys/${added.body.id}`, {
      key: keys.public_key,
      token: account.token,
    })
    expect(removed.status).toBe(200)
    expect((await call('GET', '/v1/me/passkeys', { key: keys.public_key, token: account.token })).body.passkeys).toHaveLength(0)
  })

  it('refuses a reused challenge and a foreign origin', async () => {
    const { keys, account } = await player()
    const device = await authenticator()
    const challenge = await challengeFor(keys, account.token)
    await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: account.token,
      body: device.register(challenge.challenge),
    })
    const replay = await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: account.token,
      body: (await authenticator()).register(challenge.challenge),
    })
    expect(replay.status).toBe(400)

    const other = await challengeFor(keys, account.token)
    const evil = await authenticator()
    const forged = {
      ...evil.register(other.challenge),
      client_data_json: encode(
        JSON.stringify({ type: 'webauthn.create', challenge: other.challenge, origin: 'https://evil.test' }),
      ),
    }
    const rejected = await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: account.token,
      body: forged,
    })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error).toContain('origin')
  })

  it('refuses a key that could never verify anything', async () => {
    const { keys, account } = await player()
    const challenge = await challengeFor(keys, account.token)
    const res = await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: account.token,
      body: {
        credential_id: 'abc',
        public_key: toBase64Url(new Uint8Array([1, 2, 3])),
        client_data_json: encode(
          JSON.stringify({ type: 'webauthn.create', challenge: challenge.challenge, origin: ORIGIN }),
        ),
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('P-256')
  })

  it('refuses the same credential twice', async () => {
    const { keys, account } = await player()
    const device = await authenticator()
    await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: account.token,
      body: device.register((await challengeFor(keys, account.token)).challenge),
    })
    const again = await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: account.token,
      body: device.register((await challengeFor(keys, account.token)).challenge),
    })
    expect(again.status).toBe(409)
  })
})

describe('Signing in with a passkey', () => {
  async function registered() {
    const { keys, account } = await player()
    const device = await authenticator()
    await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: account.token,
      body: device.register((await challengeFor(keys, account.token)).challenge),
    })
    return { keys, account, device }
  }

  const loginChallenge = async (keys: any, handle?: string) =>
    (await call('POST', '/v1/auth/passkey/challenge', { key: keys.public_key, body: { handle } })).body

  it('gets a new token on a device that never had one', async () => {
    const { keys, account, device } = await registered()
    const challenge = await loginChallenge(keys, account.handle)
    expect(challenge.allow).toHaveLength(1)

    const res = await call('POST', '/v1/auth/passkey', {
      key: keys.public_key,
      body: await device.assert(challenge.challenge),
    })
    expect(res.status).toBe(201)
    expect(res.body.handle).toBe(account.handle)
    expect(res.body.token).not.toBe(account.token)

    // The new token is a full session for the same person.
    const me = await call('GET', '/v1/me', { key: keys.public_key, token: res.body.token })
    expect(me.body.player.id).toBe(account.player_id)
  })

  it('rejects a tampered signature', async () => {
    const { keys, account, device } = await registered()
    const challenge = await loginChallenge(keys, account.handle)
    const res = await call('POST', '/v1/auth/passkey', {
      key: keys.public_key,
      body: await device.assert(challenge.challenge, { corrupt: true }),
    })
    expect(res.status).toBe(401)
    expect(res.body.error).toContain('signature')
  })

  it('rejects a signature made for another site', async () => {
    const { keys, account, device } = await registered()
    const challenge = await loginChallenge(keys, account.handle)
    const res = await call('POST', '/v1/auth/passkey', {
      key: keys.public_key,
      body: await device.assert(challenge.challenge, { rpId: 'phishing.test' }),
    })
    expect(res.status).toBe(401)
    expect(res.body.error).toContain('another site')
  })

  it('rejects an assertion from a foreign origin', async () => {
    const { keys, account, device } = await registered()
    const challenge = await loginChallenge(keys, account.handle)
    const res = await call('POST', '/v1/auth/passkey', {
      key: keys.public_key,
      body: await device.assert(challenge.challenge, { origin: 'https://evil.test' }),
    })
    expect(res.status).toBe(401)
    expect(res.body.error).toContain('origin')
  })

  it('accepts a second configured origin', async () => {
    const { keys, account, device } = await registered()
    const challenge = await loginChallenge(keys, account.handle)
    const res = await call('POST', '/v1/auth/passkey', {
      key: keys.public_key,
      body: await device.assert(challenge.challenge, { origin: 'https://second.test' }),
    })
    expect(res.status).toBe(201)
  })

  it('rejects an assertion without user presence', async () => {
    const { keys, account, device } = await registered()
    const challenge = await loginChallenge(keys, account.handle)
    const res = await call('POST', '/v1/auth/passkey', {
      key: keys.public_key,
      body: await device.assert(challenge.challenge, { flags: 0x04 }),
    })
    expect(res.status).toBe(401)
    expect(res.body.error).toContain('present')
  })

  it('rejects a replayed assertion', async () => {
    const { keys, account, device } = await registered()
    const challenge = await loginChallenge(keys, account.handle)
    const assertion = await device.assert(challenge.challenge)
    expect((await call('POST', '/v1/auth/passkey', { key: keys.public_key, body: assertion })).status).toBe(201)
    const replay = await call('POST', '/v1/auth/passkey', { key: keys.public_key, body: assertion })
    expect(replay.status).toBe(400)
  })

  it('rejects a counter that goes backwards', async () => {
    const { keys, account, device } = await registered()
    const first = await loginChallenge(keys, account.handle)
    await call('POST', '/v1/auth/passkey', { key: keys.public_key, body: await device.assert(first.challenge, { count: 9 }) })

    const second = await loginChallenge(keys, account.handle)
    const cloned = await call('POST', '/v1/auth/passkey', {
      key: keys.public_key,
      body: await device.assert(second.challenge, { count: 4 }),
    })
    expect(cloned.status).toBe(401)
    expect(cloned.body.error).toContain('counter')
  })

  it('says nothing about who exists', async () => {
    const { keys } = await registered()
    const unknown = await loginChallenge(keys, unique('ghost'))
    expect(unknown.allow).toEqual([])
    expect(unknown.challenge).toBeTruthy()
  })

  it('refuses an unknown credential', async () => {
    const { keys } = await registered()
    const stranger = await authenticator()
    const challenge = await loginChallenge(keys)
    const res = await call('POST', '/v1/auth/passkey', {
      key: keys.public_key,
      body: await stranger.assert(challenge.challenge),
    })
    expect(res.status).toBe(401)
  })

  it('keeps a banned account out', async () => {
    const { keys, account, device } = await registered()
    await call('POST', `/v1/admin/players/${account.handle}/status`, {
      admin: true,
      body: { status: 'banned' },
    })
    const challenge = await loginChallenge(keys, account.handle)
    const res = await call('POST', '/v1/auth/passkey', {
      key: keys.public_key,
      body: await device.assert(challenge.challenge),
    })
    expect(res.status).toBe(403)
  })
})

describe('Player sessions', () => {
  it('lists them and can end every other one', async () => {
    const { keys, account } = await player()
    const device = await authenticator()
    await call('POST', '/v1/me/passkeys', {
      key: keys.public_key,
      token: account.token,
      body: device.register((await challengeFor(keys, account.token)).challenge),
    })

    const challenge = (await call('POST', '/v1/auth/passkey/challenge', { key: keys.public_key, body: {} })).body
    const second = await call('POST', '/v1/auth/passkey', {
      key: keys.public_key,
      body: await device.assert(challenge.challenge),
    })

    const listed = await call('GET', '/v1/me/sessions', { key: keys.public_key, token: second.body.token })
    expect(listed.body.sessions).toHaveLength(2)
    expect(listed.body.sessions.some((s: any) => String(s.label).startsWith('passkey'))).toBe(true)

    const revoked = await call('POST', '/v1/me/sessions/revoke-others', {
      key: keys.public_key,
      token: second.body.token,
    })
    expect(revoked.body.revoked).toBe(1)
    // The device still in your hand keeps working; the lost one stops.
    expect((await call('GET', '/v1/me', { key: keys.public_key, token: second.body.token })).status).toBe(200)
    expect((await call('GET', '/v1/me', { key: keys.public_key, token: account.token })).status).toBe(401)
  })
})
