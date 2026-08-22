# Challenges verifier

Re-simulates submitted runs against a deterministic WebAssembly module, so a
leaderboard can stop taking claims on trust.

```bash
BASE=https://challenges-api.moinsen.dev ADMIN_KEY=… \
  node packages/verifier/src/index.mjs
```

Flags: `--once` (drain the queue and exit, for cron or CI), `--worker=<name>`,
`--interval=<ms>`.

## Why this is a separate process

Cloudflare Workers refuse to compile WebAssembly at runtime —
*"Wasm code generation disallowed by embedder"* — and that refusal is correct: a
request handler should not be an execution engine. So the API owns the queue
and the verdicts, and this owns the execution.

Three endpoints are the whole protocol:

| | |
|---|---|
| `POST /v1/verifier/claim` | take up to N queued jobs |
| `GET /v1/verifier/blob/{modules,traces}/{key}` | fetch what is needed to re-simulate |
| `POST /v1/verifier/jobs/:id/result` | report `verified`, `failed` or `error` |

It holds the **operator** credential, not an app's, because it decides what
counts. Run it wherever you like — a box, a container, a cron job — as long as
that credential is safe there.

## The module contract

A verifier module must:

- **import nothing.** Imports are how a clock, a random source or a syscall get
  in. A module that imports nothing can only compute, which is the whole reason
  re-simulation means anything. This is checked at upload and again here.
- **export its `memory`**, so the trace can be written in.
- **export the entry point**, called as `verify(ptr: i32, len: i32) -> i64`.

The host writes the trace at offset 1024, calls the entry point, and compares
the result with what the player claimed. Nobody is asked to be honest;
agreement is the entire test.

## How a runaway module is stopped

In a worker thread with a hard wall-clock limit and a constrained heap. A
thread can be killed mid-instruction. Anything gentler — a promise race, a flag
the module is meant to check — depends on the code under test cooperating, and
the code under test is exactly what is not trusted.

An `error` verdict (our fault: a blob would not download, the runner crashed)
requeues the job. After three tries the entry waits for a human instead of
counting against the player.

## Licence

CC0-1.0.
