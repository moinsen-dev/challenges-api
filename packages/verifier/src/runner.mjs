import { parentPort, workerData } from 'node:worker_threads'

/**
 * The actual re-simulation.
 *
 * Contract with the module, deliberately tiny:
 *
 *   - it imports nothing (checked at upload, checked again here)
 *   - it exports `memory`
 *   - it exports the entry point, called as `verify(ptr: i32, len: i32) -> i64`
 *
 * The host writes the trace into the module's memory and calls the entry
 * point. Whatever comes back is the score the module says that trace produces.
 * Nobody is asked to be honest: agreement with the player's claim is the whole
 * test.
 */
const { module: moduleBytes, trace, exportName, memoryPages } = workerData

try {
  const compiled = new WebAssembly.Module(Uint8Array.from(moduleBytes))

  const imports = WebAssembly.Module.imports(compiled)
  if (imports.length > 0) {
    parentPort.postMessage({
      verdict: 'failed',
      detail: `module imports ${imports.length} thing(s); a verifier module must import nothing`,
    })
  } else {
    const instance = new WebAssembly.Instance(compiled, {})
    const { memory } = instance.exports
    const entry = instance.exports[exportName]

    if (!(memory instanceof WebAssembly.Memory)) {
      parentPort.postMessage({ verdict: 'failed', detail: 'module does not export its memory' })
    } else if (typeof entry !== 'function') {
      parentPort.postMessage({ verdict: 'failed', detail: `module does not export "${exportName}"` })
    } else {
      const bytes = Uint8Array.from(trace)
      const offset = 1024
      const needed = offset + bytes.length
      const have = memory.buffer.byteLength
      if (needed > have) {
        const pages = Math.ceil((needed - have) / 65536)
        if (memoryPages && (have / 65536) + pages > memoryPages) {
          parentPort.postMessage({ verdict: 'failed', detail: 'trace does not fit the declared memory' })
          throw new Error('handled')
        }
        memory.grow(pages)
      }
      new Uint8Array(memory.buffer).set(bytes, offset)

      const computed = entry(offset, bytes.length)
      parentPort.postMessage({
        verdict: 'ok',
        value: typeof computed === 'bigint' ? Number(computed) : Number(computed),
      })
    }
  }
} catch (error) {
  if (String(error) !== 'Error: handled')
    parentPort.postMessage({ verdict: 'failed', detail: String(error).slice(0, 300) })
}
