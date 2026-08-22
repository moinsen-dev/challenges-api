import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import path from 'node:path'

const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'))

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-08-10',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'challenges' },
        r2Buckets: { BLOBS: 'challenges-blobs' },
        bindings: { ADMIN_KEY: 'test-admin-key', TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      // A regression in coverage is a failure here, not a hint. The server
      // carries the strict numbers; the client wrapper is measured too, but
      // separately, because exercising every optional-argument permutation of
      // a typed HTTP wrapper buys far less than a branch in the ledger does.
      thresholds: {
        statements: 95,
        branches: 88,
        functions: 95,
        lines: 97,
        'packages/js/**': { statements: 95, branches: 70, functions: 95, lines: 95 },
      },
    },
  },
})
