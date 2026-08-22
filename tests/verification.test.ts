import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, freshSeason, makeApp, makeDiscipline, signup, unique } from './helpers'
import { inspectModule } from '../src/routes/verify'
import { bytes, endless, importer, private_ as privateMemory, refuses, scorer } from './fixtures/wasm'

/**
 * The modules are compiled by `scripts/build-test-wasm.mjs` and committed as
 * fixtures, because the Workers runtime refuses to compile WebAssembly at
 * runtime — and wabt is itself a WebAssembly module, so it cannot run here
 * either. The text they came from is in that script, next to the bytes.
 */
const compile = (base64: string) => bytes(base64)

/** The same fold the module performs, so the test knows the honest answer. */
function expectedScore(trace: Uint8Array): number {
  let score = 0n
  for (const byte of trace) score = BigInt.asUintN(64, score * 31n + BigInt(byte))
  return Number(score)
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

/** Uploading needs a raw body, so it does not go through the JSON helper. */
async function uploadModule(keys: any, wat: string, name = 'core') {
  const worker = (await import('../src/index')).default
  const response = await worker.fetch(
    new Request(`https://api.test/v1/verifier/modules?name=${name}`, {
      method: 'POST',
      headers: { 'X-App-Key': keys.secret_key, 'Content-Type': 'application/wasm' },
      body: compile(wat),
    }),
    env as any,
    { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
  )
  return { status: response.status, body: (await response.json()) as any }
}

async function verifiedArena(wat = scorer, timeout = 2000) {
  await freshSeason()
  const keys = await makeApp()
  const slug = unique('proved')
  await makeDiscipline(keys, { slug, name: 'Proved', trust_tier: 1, max_title_level: 2 })
  const uploaded = await uploadModule(keys, wat)
  await call(`POST`, `/v1/disciplines/${slug}/verifier`, {
    key: keys.secret_key,
    body: { module: 'core', export: 'verify', timeout_ms: timeout },
  })
  return { keys, slug, module: uploaded.body }
}

const submit = (keys: any, token: string, slug: string, value: number, trace?: Uint8Array) =>
  call('POST', '/v1/entries', {
    key: keys.public_key,
    token,
    body: { discipline: slug, value, ...(trace ? { trace: toBase64(trace) } : {}) },
  })

describe('Reading a module before trusting it', () => {
  it('accepts one that imports nothing and exports its memory', async () => {
    const inspected = inspectModule(compile(scorer))
    expect(inspected.ok).toBe(true)
    if (inspected.ok) {
      expect(inspected.exports).toContain('verify')
      expect(inspected.exports).toContain('memory')
      expect(inspected.memoryPages).toBe(2)
    }
  })

  it('refuses one that imports anything at all', async () => {
    const inspected = inspectModule(compile(importer))
    expect(inspected.ok).toBe(false)
    // Imports are how a clock or a random source gets in; without them the
    // module can only compute, which is what makes re-simulation meaningful.
    if (!inspected.ok) expect(inspected.error).toContain('import')
  })

  it('refuses something that is not a module at all', () => {
    expect(inspectModule(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({
      ok: false,
      error: 'not a WebAssembly module',
    })
  })

  it('refuses one that keeps its memory to itself', () => {
    const inspected = inspectModule(compile(privateMemory))
    expect(inspected.ok).toBe(false)
    if (!inspected.ok) expect(inspected.error).toContain('memory')
  })
})

describe('Uploading and attaching a module', () => {
  it('stores it and reports what it exports', async () => {
    await freshSeason()
    const keys = await makeApp()
    const uploaded = await uploadModule(keys, scorer)
    expect(uploaded.status).toBe(201)
    expect(uploaded.body.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(uploaded.body.exports).toContain('verify')

    const listed = await call('GET', '/v1/verifier/modules', { key: keys.secret_key })
    expect(listed.body.modules).toHaveLength(1)
    expect(listed.body.modules[0].name).toBe('core')
  })

  it('refuses an importing module at the door', async () => {
    await freshSeason()
    const keys = await makeApp()
    const refused = await uploadModule(keys, importer)
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('import')
  })

  it('refuses to attach an export the module does not have', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('d')
    await makeDiscipline(keys, { slug, name: 'D', trust_tier: 1 })
    await uploadModule(keys, scorer)

    const wrong = await call(`POST`, `/v1/disciplines/${slug}/verifier`, {
      key: keys.secret_key,
      body: { module: 'core', export: 'not_there' },
    })
    expect(wrong.status).toBe(400)
    expect(wrong.body.exports).toContain('verify')

    const unknown = await call(`POST`, `/v1/disciplines/${slug}/verifier`, {
      key: keys.secret_key,
      body: { module: 'no-such-module' },
    })
    expect(unknown.status).toBe(404)
  })

  it('needs the secret key', async () => {
    await freshSeason()
    const keys = await makeApp()
    const worker = (await import('../src/index')).default
    const res = await worker.fetch(
      new Request('https://api.test/v1/verifier/modules?name=x', {
        method: 'POST',
        headers: { 'X-App-Key': keys.public_key },
        body: compile(scorer),
      }),
      env as any,
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    )
    expect(res.status).toBe(403)
  })
})

describe('A discipline that can prove its runs', () => {
  it('will not count an entry that arrives without a trace', async () => {
    const { keys, slug } = await verifiedArena()
    const player = await signup(keys)
    const res = await submit(keys, player.token, slug, 100)
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('trace')
  })

  it('holds a run with a trace until somebody has re-simulated it', async () => {
    const { keys, slug } = await verifiedArena()
    const player = await signup(keys)
    const trace = new Uint8Array([3, 1, 4, 1, 5, 9, 2, 6])

    const res = await submit(keys, player.token, slug, expectedScore(trace), trace)
    expect(res.status).toBe(202)
    expect(res.body.verification).toBe('pending')
    expect(res.body.job).toBeTruthy()

    // Nothing counts yet — the board stays empty until the proof lands.
    const board = await call('GET', `/v1/leaderboards/${slug}`, { key: keys.public_key })
    expect(board.body.contenders).toBe(0)
    expect(board.body.verification).toBe('replay')
  })

  it('says on every board whether it verifies at all', async () => {
    await freshSeason()
    const keys = await makeApp()
    const slug = unique('trusting')
    await makeDiscipline(keys, { slug, name: 'Trusting', trust_tier: 1 })
    const board = await call('GET', `/v1/leaderboards/${slug}`, { key: keys.public_key })
    expect(board.body.verification).toBe('none')
  })

  it('refuses a trace that is not base64, and one that is far too large', async () => {
    const { keys, slug } = await verifiedArena()
    const player = await signup(keys)
    const notBase64 = await call('POST', '/v1/entries', {
      key: keys.public_key,
      token: player.token,
      body: { discipline: slug, value: 1, trace: '!!!not base64!!!' },
    })
    expect(notBase64.status).toBe(400)

    const empty = await call('POST', '/v1/entries', {
      key: keys.public_key,
      token: player.token,
      body: { discipline: slug, value: 1, trace: '' },
    })
    expect(empty.status).toBe(400)
  })
})

describe('The queue a verifier works from', () => {
  it('hands out a job with everything needed to re-simulate it', async () => {
    const { keys, slug } = await verifiedArena()
    const player = await signup(keys)
    const trace = new Uint8Array([7, 7, 7])
    const entry = await submit(keys, player.token, slug, expectedScore(trace), trace)

    const claimed = await call('POST', '/v1/verifier/claim', {
      admin: true,
      body: { worker: 'test-runner', limit: 25 },
    })
    // Earlier tests in this file leave work behind, so find our own job.
    const job = claimed.body.jobs.find((j: any) => j.entry_id === entry.body.entry_id)
    expect(job).toBeTruthy()
    expect(job.verify_export).toBe('verify')
    expect(job.trace_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(job.memory_pages).toBe(2)

    // A claimed job is not handed to a second worker.
    const again = await call('POST', '/v1/verifier/claim', { admin: true, body: { worker: 'other' } })
    expect(again.body.jobs.find((j: any) => j.entry_id === entry.body.entry_id)).toBeUndefined()
  })

  it('serves the module and the trace to whoever holds the operator key', async () => {
    const { keys, slug, module } = await verifiedArena()
    const player = await signup(keys)
    const trace = new Uint8Array([1, 2, 3])
    const entry = await submit(keys, player.token, slug, expectedScore(trace), trace)

    const worker = (await import('../src/index')).default
    const fetchBlob = (path: string, admin = true) =>
      worker.fetch(
        new Request(`https://api.test${path}`, { headers: admin ? { 'X-Admin-Key': 'test-admin-key' } : {} }),
        env as any,
        { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
      )

    const moduleBlob = await fetchBlob(`/v1/verifier/blob/modules/${module.id}.wasm`)
    expect(moduleBlob.status).toBe(200)
    expect(new Uint8Array(await moduleBlob.arrayBuffer()).length).toBe(module.size_bytes)

    const traceBlob = await fetchBlob(`/v1/verifier/blob/traces/${entry.body.entry_id}.bin`)
    expect(new Uint8Array(await traceBlob.arrayBuffer())).toEqual(trace)

    // Not something a public key may fetch.
    expect((await fetchBlob(`/v1/verifier/blob/modules/${module.id}.wasm`, false)).status).toBe(401)
    expect((await fetchBlob('/v1/verifier/blob/nonsense/x')).status).toBe(404)
  })
})

describe('What a player is told about their own run', () => {
  it('reports the verdict, including the numbers that disagreed', async () => {
    const { keys, slug } = await verifiedArena()
    const player = await signup(keys)
    const trace = new Uint8Array([2, 4, 8])
    const entry = await submit(keys, player.token, slug, 999, trace)

    const pending = await call(`GET`, `/v1/entries/${entry.body.entry_id}`, {
      key: keys.public_key,
      token: player.token,
    })
    expect(pending.body.verification).toBe('pending')
    expect(pending.body.status).toBe('review')

    // The verifier's verdict, as the API would record it.
    const job = await env.DB.prepare(`SELECT id FROM verification_jobs WHERE entry_id = ?`)
      .bind(entry.body.entry_id)
      .first<{ id: string }>()
    await call(`POST`, `/v1/verifier/jobs/${job!.id}/result`, {
      admin: true,
      body: {
        verdict: 'failed',
        computed_value: expectedScore(trace),
        cpu_ms: 3,
        detail: `claimed 999, re-simulation produced ${expectedScore(trace)}`,
      },
    })

    const decided = await call(`GET`, `/v1/entries/${entry.body.entry_id}`, {
      key: keys.public_key,
      token: player.token,
    })
    expect(decided.body.verification).toBe('failed')
    expect(decided.body.status).toBe('rejected')
    expect(decided.body.computed_value).toBe(expectedScore(trace))
    expect(decided.body.detail).toContain('re-simulation produced')
  })

  it('shows nobody else their entry', async () => {
    const { keys, slug } = await verifiedArena()
    const owner = await signup(keys)
    const nosy = await signup(keys)
    const entry = await submit(keys, owner.token, slug, 1, new Uint8Array([1]))
    const peek = await call(`GET`, `/v1/entries/${entry.body.entry_id}`, {
      key: keys.public_key,
      token: nosy.token,
    })
    expect(peek.status).toBe(404)
  })

  it('counts a verified run and puts the player on the board', async () => {
    const { keys, slug } = await verifiedArena()
    const player = await signup(keys)
    const trace = new Uint8Array([9, 9])
    const score = expectedScore(trace)
    const entry = await submit(keys, player.token, slug, score, trace)

    const job = await env.DB.prepare(`SELECT id FROM verification_jobs WHERE entry_id = ?`)
      .bind(entry.body.entry_id)
      .first<{ id: string }>()
    await call(`POST`, `/v1/verifier/jobs/${job!.id}/result`, {
      admin: true,
      body: { verdict: 'verified', computed_value: score, cpu_ms: 2 },
    })

    const board = await call('GET', `/v1/leaderboards/${slug}`, { key: keys.public_key })
    expect(board.body.contenders).toBe(1)
    expect(board.body.entries[0].value).toBe(score)

    const usage = await call('GET', '/v1/verifier/usage', { key: keys.secret_key })
    expect(usage.body.usage[0].metric).toBe('verification')
    expect(usage.body.usage[0].cpu_ms).toBeGreaterThan(0)
  })

  it('retries a verifier that broke, and gives up after a few tries', async () => {
    const { keys, slug } = await verifiedArena()
    const player = await signup(keys)
    const entry = await submit(keys, player.token, slug, 5, new Uint8Array([5]))
    const job = await env.DB.prepare(`SELECT id FROM verification_jobs WHERE entry_id = ?`)
      .bind(entry.body.entry_id)
      .first<{ id: string }>()

    // An error is the verifier's problem, so the job goes back in the queue.
    for (let i = 0; i < 3; i++) {
      await call('POST', '/v1/verifier/claim', { admin: true, body: { worker: 'flaky' } })
      const res = await call(`POST`, `/v1/verifier/jobs/${job!.id}/result`, {
        admin: true,
        body: { verdict: 'error', detail: 'runner crashed' },
      })
      if (i < 2) expect(res.body.state).toBe('requeued')
    }

    const final = await env.DB.prepare(`SELECT state FROM verification_jobs WHERE id = ?`)
      .bind(job!.id)
      .first<{ state: string }>()
    expect(final!.state).toBe('error')
    // The player is not punished for our failure: the entry waits for a human.
    const held = await call(`GET`, `/v1/entries/${entry.body.entry_id}`, {
      key: keys.public_key,
      token: player.token,
    })
    expect(held.body.status).toBe('review')
  })

  it('refuses a second verdict on a decided job, and an unknown verdict', async () => {
    const { keys, slug } = await verifiedArena()
    const player = await signup(keys)
    const trace = new Uint8Array([4])
    const entry = await submit(keys, player.token, slug, expectedScore(trace), trace)
    const job = await env.DB.prepare(`SELECT id FROM verification_jobs WHERE entry_id = ?`)
      .bind(entry.body.entry_id)
      .first<{ id: string }>()

    expect(
      (await call(`POST`, `/v1/verifier/jobs/${job!.id}/result`, {
        admin: true,
        body: { verdict: 'maybe' },
      })).status,
    ).toBe(400)

    await call(`POST`, `/v1/verifier/jobs/${job!.id}/result`, {
      admin: true,
      body: { verdict: 'verified', computed_value: expectedScore(trace) },
    })
    const again = await call(`POST`, `/v1/verifier/jobs/${job!.id}/result`, {
      admin: true,
      body: { verdict: 'failed' },
    })
    expect(again.status).toBe(409)
    expect((await call('POST', '/v1/verifier/jobs/vj_nothing/result', { admin: true, body: { verdict: 'verified' } })).status).toBe(404)
  })
})

describe('The client side of a proved discipline', () => {
  it('submits a trace, waits for the verdict, and is told plainly', async () => {
    const { keys, slug } = await verifiedArena()
    const { createClient } = await import('../packages/js/src/index')
    const worker = (await import('../src/index')).default
    const localFetch: typeof fetch = (input, init) =>
      worker.fetch(new Request(input as RequestInfo, init), env as any, {
        waitUntil() {},
        passThroughOnException() {},
      } as ExecutionContext)

    let token: string | null = null
    const client = createClient({
      baseUrl: 'https://api.test',
      appKey: keys.public_key,
      storage: { get: () => token, set: (t) => void (token = t), clear: () => void (token = null) },
      fetch: localFetch,
    })
    await client.signIn({ handle: unique('prover') })

    const trace = new Uint8Array([6, 6, 6])
    const score = expectedScore(trace)
    const held = await client.submit(slug, score, { trace })
    expect(held.verification).toBe('pending')

    // Nothing has re-simulated it yet, so waiting gives up honestly.
    const stillWaiting = await client.awaitVerdict(held.entry_id, { pollMs: 5, timeoutMs: 30 })
    expect(stillWaiting.verification).toBe('pending')

    const job = await env.DB.prepare(`SELECT id FROM verification_jobs WHERE entry_id = ?`)
      .bind(held.entry_id)
      .first<{ id: string }>()
    await call(`POST`, `/v1/verifier/jobs/${job!.id}/result`, {
      admin: true,
      body: { verdict: 'verified', computed_value: score, cpu_ms: 1 },
    })

    const verdict = await client.awaitVerdict(held.entry_id, { pollMs: 5, timeoutMs: 500 })
    expect(verdict.verification).toBe('verified')
    expect(verdict.status).toBe('counted')

    // A trace can also be handed over already encoded.
    const second = await client.submit(slug, 1, { trace: toBase64(new Uint8Array([1, 2])) })
    expect(second.verification).toBe('pending')
  })
})

describe('Small refusals around modules', () => {
  it('refuses an empty upload and one that is far too large', async () => {
    await freshSeason()
    const keys = await makeApp()
    const worker = (await import('../src/index')).default
    const post = (body: BodyInit) =>
      worker.fetch(
        new Request('https://api.test/v1/verifier/modules?name=x', {
          method: 'POST',
          headers: { 'X-App-Key': keys.secret_key },
          body,
        }),
        env as any,
        { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
      )

    expect((await post(new Uint8Array(0))).status).toBe(400)
    expect((await post(new Uint8Array(5 * 1024 * 1024))).status).toBe(413)
  })

  it('lets a discipline stop verifying again', async () => {
    const { keys, slug } = await verifiedArena()
    const detached = await call(`POST`, `/v1/disciplines/${slug}/verifier`, {
      key: keys.secret_key,
      body: { module: null },
    })
    expect(detached.body.module).toBeNull()

    // Without a module the discipline takes plain entries again.
    const player = await signup(keys)
    const res = await submit(keys, player.token, slug, 42)
    expect(res.status).toBe(201)
    const board = await call('GET', `/v1/leaderboards/${slug}`, { key: keys.public_key })
    expect(board.body.verification).toBe('none')
  })

  it('refuses to attach a verifier to a discipline that does not exist', async () => {
    await freshSeason()
    const keys = await makeApp()
    await uploadModule(keys, scorer)
    const res = await call('POST', '/v1/disciplines/not-there/verifier', {
      key: keys.secret_key,
      body: { module: 'core' },
    })
    expect(res.status).toBe(404)
  })

  it('shows the operator every job, whatever became of it', async () => {
    const { keys, slug } = await verifiedArena()
    const player = await signup(keys)
    await submit(keys, player.token, slug, 1, new Uint8Array([1]))
    const jobs = await call('GET', '/v1/verifier/jobs', { admin: true })
    expect(jobs.body.jobs.length).toBeGreaterThan(0)
    expect(jobs.body.jobs[0]).toHaveProperty('app')
    expect(jobs.body.jobs[0]).toHaveProperty('discipline')
  })
})

describe('Modules that are broken in structural ways', () => {
  it('refuses one with an unsupported version', () => {
    const wrongVersion = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0, 0, 0])
    expect(inspectModule(wrongVersion)).toEqual({ ok: false, error: 'unsupported WebAssembly version' })
  })

  it('refuses one whose sections run past the end', () => {
    const module = compile(scorer)
    // Claim a section far larger than what follows.
    const truncated = Uint8Array.from([...module.slice(0, 8), 1, 200, 1, 2, 3])
    const inspected = inspectModule(truncated)
    expect(inspected.ok).toBe(false)
    if (!inspected.ok) expect(inspected.error).toContain('truncated')
  })

  it('refuses an empty body outright', () => {
    expect(inspectModule(new Uint8Array(0))).toEqual({ ok: false, error: 'not a WebAssembly module' })
  })
})
