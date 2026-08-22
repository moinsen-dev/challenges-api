import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'

// Jede Testdatei startet gegen ein frisch migriertes Schema.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
