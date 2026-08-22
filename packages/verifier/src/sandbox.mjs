import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

/**
 * Run one verification inside a worker thread with a hard wall-clock limit.
 *
 * A thread is the only reliable way to stop WebAssembly that will not stop by
 * itself: `worker.terminate()` kills it mid-instruction. Everything else — a
 * promise race, a flag the module is supposed to check — depends on the code
 * under test cooperating, and the code under test is exactly what we do not
 * trust.
 */
export function runInSandbox({ module, trace, exportName, memoryPages, timeoutMs }) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint()
    const worker = new Worker(fileURLToPath(new URL('./runner.mjs', import.meta.url)), {
      workerData: { module, trace, exportName, memoryPages },
      resourceLimits: {
        // A module that tries to allocate its way out is stopped by the
        // runtime rather than by us noticing afterwards.
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
      },
    })

    const timer = setTimeout(() => {
      worker.terminate()
      resolve({ verdict: 'failed', detail: `module exceeded ${timeoutMs} ms`, cpuMs: timeoutMs })
    }, timeoutMs)

    const finish = (result) => {
      clearTimeout(timer)
      worker.terminate()
      resolve({ ...result, cpuMs: Number((process.hrtime.bigint() - started) / 1_000_000n) })
    }

    worker.on('message', (message) => finish(message))
    worker.on('error', (error) => finish({ verdict: 'failed', detail: String(error).slice(0, 300) }))
    worker.on('exit', (code) => {
      if (code !== 0) finish({ verdict: 'failed', detail: `runner exited with ${code}` })
    })
  })
}
