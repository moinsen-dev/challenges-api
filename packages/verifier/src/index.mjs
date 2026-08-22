#!/usr/bin/env node
/**
 * The verifier.
 *
 * It exists as a separate process for one reason: Cloudflare Workers refuse to
 * compile WebAssembly at runtime — "Wasm code generation disallowed by
 * embedder" — and that refusal is correct. A request handler should not be an
 * execution engine. So the API owns the queue and the verdicts, and this
 * claims work, re-simulates it under a timeout, and reports back.
 *
 *   BASE=https://api… ADMIN_KEY=… node packages/verifier/src/index.mjs
 *
 * Flags: --once (drain the queue and exit), --worker=<name>, --interval=<ms>
 */
import { runInSandbox } from './sandbox.mjs'

const BASE = (process.env.BASE ?? 'http://127.0.0.1:8799').replace(/\/$/, '')
const ADMIN = process.env.ADMIN_KEY ?? 'dev-admin-key'
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const WORKER = args.get('worker') ?? `verifier-${process.pid}`
const INTERVAL = Number(args.get('interval') ?? 2000)
const ONCE = args.has('once')

const call = async (path, options = {}) => {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN, ...(options.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res
}

const blob = async (kind, key) =>
  new Uint8Array(await (await call(`/v1/verifier/blob/${kind}/${key}`)).arrayBuffer())

/** Modules change rarely and are the expensive part to fetch. */
const moduleCache = new Map()
async function moduleFor(job) {
  const cached = moduleCache.get(job.module_id)
  if (cached) return cached
  const bytes = await blob('modules', `${job.module_id}.wasm`)
  moduleCache.set(job.module_id, bytes)
  return bytes
}

async function handle(job) {
  try {
    const [module, trace] = await Promise.all([
      moduleFor(job),
      blob('traces', job.trace_key.replace(/^traces\//, '')),
    ])

    const result = await runInSandbox({
      module: Array.from(module),
      trace: Array.from(trace),
      exportName: job.verify_export,
      memoryPages: job.memory_pages,
      timeoutMs: job.verify_timeout_ms,
    })

    if (result.verdict !== 'ok') {
      await report(job, { verdict: 'failed', detail: result.detail, cpu_ms: result.cpuMs })
      return `failed (${result.detail})`
    }

    // The entire judgement, in one comparison: does re-simulation produce what
    // the player said it would?
    const agrees = Number(result.value) === Number(job.claimed_value)
    await report(job, {
      verdict: agrees ? 'verified' : 'failed',
      computed_value: result.value,
      cpu_ms: result.cpuMs,
      detail: agrees ? null : `claimed ${job.claimed_value}, re-simulation produced ${result.value}`,
    })
    return agrees ? `verified (${result.value})` : `rejected (claimed ${job.claimed_value}, got ${result.value})`
  } catch (error) {
    // Our problem, not the player's: report it as an error so the job is
    // retried rather than counted against them.
    await report(job, { verdict: 'error', detail: String(error).slice(0, 300) })
    return `error (${error})`
  }
}

const report = (job, body) =>
  call(`/v1/verifier/jobs/${job.id}/result`, { method: 'POST', body: JSON.stringify(body) })

export async function drain() {
  const { jobs } = await (
    await call('/v1/verifier/claim', {
      method: 'POST',
      body: JSON.stringify({ worker: WORKER, limit: 10 }),
    })
  ).json()

  for (const job of jobs) {
    const outcome = await handle(job)
    console.log(`${job.id} ${job.discipline}: ${outcome}`)
  }
  return jobs.length
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`verifier ${WORKER} against ${BASE}${ONCE ? ' (once)' : ''}`)
  if (ONCE) {
    const handled = await drain()
    console.log(`handled ${handled}`)
    process.exit(0)
  }
  for (;;) {
    try {
      const handled = await drain()
      if (handled === 0) await new Promise((resolve) => setTimeout(resolve, INTERVAL))
    } catch (error) {
      console.error('claim failed:', String(error))
      await new Promise((resolve) => setTimeout(resolve, INTERVAL * 2))
    }
  }
}
