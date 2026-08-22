import { Hono } from 'hono'
import {
  Discipline,
  HonoApp,
  audit,
  id,
  now,
  record,
  requireAdmin,
  requireApp,
  requireAppSecret,
  requirePlayer,
} from '../lib'
import * as projection from '../projection'
import { syncQualification } from '../qualify'

export const verify = new Hono<HonoApp>()

const MAX_MODULE_BYTES = 4 * 1024 * 1024
const MAX_TRACE_BYTES = 512 * 1024

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

export const sha256Hex = async (bytes: ArrayBuffer) => toHex(await crypto.subtle.digest('SHA-256', bytes))

/**
 * Read a WebAssembly module far enough to answer two questions: does it import
 * anything, and what does it export?
 *
 * We cannot compile it here — Cloudflare refuses to generate Wasm code at
 * runtime, which is the correct answer for a request handler. But the section
 * headers are enough, and they carry the property that matters: a module with
 * **no imports** cannot read a clock, cannot draw a random number and cannot
 * make a syscall, so the same trace must produce the same answer everywhere.
 * That is what makes re-simulation meaningful rather than hopeful.
 */
export function inspectModule(bytes: Uint8Array):
  | { ok: true; exports: string[]; memoryPages: number }
  | { ok: false; error: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 8 || view.getUint32(0, true) !== 0x6d736100)
    return { ok: false, error: 'not a WebAssembly module' }
  if (view.getUint32(4, true) !== 1) return { ok: false, error: 'unsupported WebAssembly version' }

  let offset = 8
  const exports: string[] = []
  let memoryPages = 0

  const readVarUint = () => {
    let result = 0
    let shift = 0
    while (offset < bytes.length) {
      const byte = bytes[offset++]
      result |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7
    }
    return result
  }

  while (offset < bytes.length) {
    const sectionId = bytes[offset++]
    const size = readVarUint()
    const end = offset + size
    if (end > bytes.length) return { ok: false, error: 'truncated module' }

    if (sectionId === 2) {
      // An import section at all is a refusal: this is the determinism rule.
      const count = readVarUint()
      if (count > 0) return { ok: false, error: 'module imports something; a verifier module must import nothing' }
    } else if (sectionId === 5) {
      const count = readVarUint()
      for (let i = 0; i < count; i++) {
        const flags = bytes[offset++]
        memoryPages = readVarUint()
        if (flags & 0x01) readVarUint()
      }
    } else if (sectionId === 7) {
      const count = readVarUint()
      for (let i = 0; i < count; i++) {
        const nameLength = readVarUint()
        exports.push(new TextDecoder().decode(bytes.slice(offset, offset + nameLength)))
        offset += nameLength
        offset++ // kind
        readVarUint() // index
      }
    }
    offset = end
  }

  if (!exports.includes('memory'))
    return { ok: false, error: 'module must export its memory so a trace can be written into it' }
  return { ok: true, exports, memoryPages }
}

// ------------------------------------------------------------------ modules

verify.post('/v1/verifier/modules', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const name = c.req.query('name') ?? 'default'
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.length === 0) return c.json({ error: 'body must be the .wasm module' }, 400)
  if (bytes.length > MAX_MODULE_BYTES)
    return c.json({ error: `module is larger than ${MAX_MODULE_BYTES} bytes` }, 413)

  const inspected = inspectModule(bytes)
  if (!inspected.ok) return c.json({ error: inspected.error }, 400)

  const digest = await sha256Hex(bytes.buffer as ArrayBuffer)
  const moduleId = id('mod')
  await c.env.BLOBS.put(`modules/${moduleId}.wasm`, bytes, {
    httpMetadata: { contentType: 'application/wasm' },
  })
  await c.env.DB.prepare(
    `INSERT INTO verifier_modules (id, app_id, name, sha256, size_bytes, exports, memory_pages, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (app_id, name) DO UPDATE SET
       id = excluded.id, sha256 = excluded.sha256, size_bytes = excluded.size_bytes,
       exports = excluded.exports, memory_pages = excluded.memory_pages, created_at = excluded.created_at`,
  )
    .bind(
      moduleId,
      app.id,
      name,
      digest,
      bytes.length,
      inspected.exports.join(','),
      inspected.memoryPages,
      now(),
    )
    .run()
  await audit(c.env.DB, { kind: 'developer', label: app.slug }, 'module.uploaded', moduleId, {
    name,
    sha256: digest,
  })

  return c.json(
    { id: moduleId, name, sha256: digest, size_bytes: bytes.length, exports: inspected.exports },
    201,
  )
})

verify.get('/v1/verifier/modules', requireAppSecret, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, sha256, size_bytes, exports, memory_pages, created_at
       FROM verifier_modules WHERE app_id = ? ORDER BY created_at DESC`,
  )
    .bind(c.get('app')!.id)
    .all()
  return c.json({ modules: rows.results })
})

/** Point a discipline at the module that can prove its runs. */
verify.post('/v1/disciplines/:slug/verifier', requireAppSecret, async (c) => {
  const app = c.get('app')!
  const body = await c.req.json<{ module: string; export?: string; timeout_ms?: number }>()

  const d = await c.env.DB.prepare(`SELECT id, trust_tier FROM disciplines WHERE app_id = ? AND slug = ?`)
    .bind(app.id, c.req.param('slug'))
    .first<{ id: string; trust_tier: number }>()
  if (!d) return c.json({ error: 'unknown discipline' }, 404)

  if (body.module === null) {
    await c.env.DB.prepare(`UPDATE disciplines SET module_id = NULL WHERE id = ?`).bind(d.id).run()
    return c.json({ discipline: c.req.param('slug'), module: null })
  }

  const mod = await c.env.DB.prepare(
    `SELECT id, exports FROM verifier_modules WHERE app_id = ? AND (id = ? OR name = ?)`,
  )
    .bind(app.id, body.module, body.module)
    .first<{ id: string; exports: string }>()
  if (!mod) return c.json({ error: 'unknown module' }, 404)

  const entry = body.export ?? 'verify'
  if (!mod.exports.split(',').includes(entry))
    return c.json({ error: `module does not export "${entry}"`, exports: mod.exports.split(',') }, 400)

  await c.env.DB.prepare(
    `UPDATE disciplines SET module_id = ?, verify_export = ?, verify_timeout_ms = ? WHERE id = ?`,
  )
    .bind(mod.id, entry, Math.min(body.timeout_ms ?? 2000, 15000), d.id)
    .run()
  return c.json({ discipline: c.req.param('slug'), module: mod.id, export: entry })
})

// -------------------------------------------------------------- the queue

/**
 * Queue an entry for verification. Called from the entries endpoint when a
 * trace arrives for a discipline that has a module.
 */
export async function queueVerification(
  env: HonoApp['Bindings'],
  d: Discipline & { module_id: string | null },
  entryId: string,
  appId: string,
  claimedValue: number,
  trace: Uint8Array,
): Promise<string | null> {
  if (!d.module_id) return null
  const traceKey = `traces/${entryId}.bin`
  const digest = await sha256Hex(trace.buffer as ArrayBuffer)
  await env.BLOBS.put(traceKey, trace)

  const jobId = id('vj')
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO verification_jobs
         (id, app_id, entry_id, discipline_id, module_id, claimed_value, trace_key, trace_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(jobId, appId, entryId, d.id, d.module_id, claimedValue, traceKey, digest, now()),
    env.DB.prepare(`UPDATE entries SET verification = 'pending', trace_sha256 = ? WHERE id = ?`).bind(
      digest,
      entryId,
    ),
  ])
  return jobId
}

/**
 * A verifier claims a batch of work.
 *
 * This is an operator endpoint on purpose: a verifier runs somebody's code and
 * decides what counts, so it holds the platform's credential rather than an
 * app's.
 */
verify.post('/v1/verifier/claim', requireAdmin, async (c) => {
  const body = await c.req.json<{ worker: string; limit?: number }>().catch(() => ({ worker: 'anonymous' }))
  const limit = Math.min(body.limit ?? 5, 25)

  const queued = await c.env.DB.prepare(
    `SELECT id FROM verification_jobs WHERE state = 'queued' ORDER BY created_at LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>()
  if (queued.results.length === 0) return c.json({ jobs: [] })

  const ids = queued.results.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(',')
  await c.env.DB.prepare(
    `UPDATE verification_jobs SET state = 'claimed', claimed_by = ?, claimed_at = ?, attempts = attempts + 1
      WHERE id IN (${placeholders}) AND state = 'queued'`,
  )
    .bind(body.worker ?? 'anonymous', now(), ...ids)
    .run()

  const jobs = await c.env.DB.prepare(
    `SELECT j.id, j.entry_id, j.claimed_value, j.trace_key, j.trace_sha256,
            m.id AS module_id, m.sha256 AS module_sha256, m.memory_pages,
            d.verify_export, d.verify_timeout_ms, d.slug AS discipline
       FROM verification_jobs j
       JOIN verifier_modules m ON m.id = j.module_id
       JOIN disciplines d ON d.id = j.discipline_id
      WHERE j.id IN (${placeholders}) AND j.state = 'claimed'`,
  )
    .bind(...ids)
    .all()
  return c.json({ jobs: jobs.results })
})

/** Fetch a module or a trace. Operator credential, same reasoning as above. */
verify.get('/v1/verifier/blob/:kind/:key', requireAdmin, async (c) => {
  const kind = c.req.param('kind')
  if (!['modules', 'traces'].includes(kind)) return c.json({ error: 'unknown blob kind' }, 404)
  const object = await c.env.BLOBS.get(`${kind}/${c.req.param('key')}`)
  if (!object) return c.json({ error: 'not found' }, 404)
  return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream' } })
})

verify.post('/v1/verifier/jobs/:id/result', requireAdmin, async (c) => {
  const body = await c.req.json<{
    verdict: 'verified' | 'failed' | 'error'
    computed_value?: number
    cpu_ms?: number
    detail?: string
  }>()
  if (!['verified', 'failed', 'error'].includes(body.verdict))
    return c.json({ error: 'verdict must be verified, failed or error' }, 400)

  const job = await c.env.DB.prepare(
    `SELECT j.*, e.player_id, e.region_id, e.season_id FROM verification_jobs j
       JOIN entries e ON e.id = j.entry_id WHERE j.id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{
      id: string
      app_id: string
      entry_id: string
      discipline_id: string
      claimed_value: number
      state: string
      attempts: number
      player_id: string
      region_id: string | null
      season_id: string
    }>()
  if (!job) return c.json({ error: 'unknown job' }, 404)
  if (job.state === 'done') return c.json({ error: 'job already decided' }, 409)

  // An error is the verifier's problem, not the player's: the job goes back
  // into the queue unless it has failed too often to be worth retrying.
  if (body.verdict === 'error') {
    const giveUp = job.attempts >= 3
    await c.env.DB.prepare(
      `UPDATE verification_jobs SET state = ?, detail = ?, finished_at = ? WHERE id = ?`,
    )
      .bind(giveUp ? 'error' : 'queued', body.detail ?? null, giveUp ? now() : null, job.id)
      .run()
    if (giveUp)
      await c.env.DB.prepare(`UPDATE entries SET verification = 'failed', status = 'review' WHERE id = ?`)
        .bind(job.entry_id)
        .run()
    return c.json({ job: job.id, state: giveUp ? 'error' : 'requeued' })
  }

  const agreed = body.verdict === 'verified'
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE verification_jobs SET state = 'done', verdict = ?, computed_value = ?, cpu_ms = ?,
              detail = ?, finished_at = ? WHERE id = ?`,
    ).bind(body.verdict, body.computed_value ?? null, body.cpu_ms ?? null, body.detail ?? null, now(), job.id),
    c.env.DB.prepare(
      `UPDATE entries SET verification = ?, status = ? WHERE id = ?`,
    ).bind(agreed ? 'verified' : 'failed', agreed ? 'counted' : 'rejected', job.entry_id),
    // Verification is real CPU, so it is counted rather than estimated.
    c.env.DB.prepare(
      `INSERT INTO usage_counters (app_id, day, metric, count, cpu_ms) VALUES (?, ?, 'verification', 1, ?)
       ON CONFLICT (app_id, day, metric) DO UPDATE SET
         count = usage_counters.count + 1, cpu_ms = usage_counters.cpu_ms + excluded.cpu_ms`,
    ).bind(job.app_id, now().slice(0, 10), body.cpu_ms ?? 0),
  ])

  const d = await c.env.DB.prepare(`SELECT * FROM disciplines WHERE id = ?`)
    .bind(job.discipline_id)
    .first<Discipline>()
  if (d) {
    // A verified run only now becomes part of the competition.
    await syncQualification(c.env.DB, d, job.season_id, job.player_id, job.app_id)
    await projection.refresh(c.env.DB, d, job.season_id, job.player_id, job.region_id)
  }
  await record(c.env.DB, job.app_id, job.player_id, `entry.${agreed ? 'verified' : 'rejected'}`, {
    entry: job.entry_id,
    claimed: job.claimed_value,
    computed: body.computed_value ?? null,
  })

  return c.json({ job: job.id, verdict: body.verdict })
})

/** What became of one entry. The other half of a 202. */
verify.get('/v1/entries/:id', requireApp, requirePlayer, async (c) => {
  const player = c.get('player')!
  const row = await c.env.DB.prepare(
    `SELECT e.id, e.value, e.status, e.verification, e.created_at, d.slug AS discipline,
            j.verdict, j.computed_value, j.detail, j.state AS job_state
       FROM entries e JOIN disciplines d ON d.id = e.discipline_id
       LEFT JOIN verification_jobs j ON j.entry_id = e.id
      WHERE e.id = ? AND e.player_id = ?`,
  )
    .bind(c.req.param('id'), player.id)
    .first()
  if (!row) return c.json({ error: 'unknown entry' }, 404)
  return c.json(row)
})

verify.get('/v1/verifier/jobs', requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT j.id, j.state, j.verdict, j.claimed_value, j.computed_value, j.cpu_ms, j.attempts,
            j.created_at, j.finished_at, a.slug AS app, d.slug AS discipline
       FROM verification_jobs j JOIN apps a ON a.id = j.app_id
       JOIN disciplines d ON d.id = j.discipline_id
      ORDER BY j.created_at DESC LIMIT 100`,
  ).all()
  return c.json({ jobs: rows.results })
})

/** What verification actually cost, per app and day. */
verify.get('/v1/verifier/usage', requireAppSecret, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT day, metric, count, cpu_ms FROM usage_counters WHERE app_id = ? ORDER BY day DESC LIMIT 60`,
  )
    .bind(c.get('app')!.id)
    .all()
  return c.json({ usage: rows.results })
})
