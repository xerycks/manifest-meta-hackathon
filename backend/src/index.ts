import { loadEnv } from "./config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "./connections/adapters/index.js"
import { ManifestsRepository } from "./manifests/repository.js"
import { RefreshRunner } from "./manifests/runner.js"
import { QueryExecutionsRepository } from "./queries/repository.js"
import { QueryRunner } from "./queries/runner.js"
import { createApp } from "./server/app.js"
import { createPool } from "./shared/postgres/client.js"
import { runMigrations } from "./storage/migrations.js"

const env = loadEnv()

const pool = env.DATABASE_URL ? createPool(env.DATABASE_URL) : null
if (pool) {
  const applied = await runMigrations(pool)
  if (applied.length > 0) console.log(`Applied migrations: ${applied.join(", ")}`)
  const interrupted = await new ManifestsRepository(pool).failInterruptedRefreshes()
  if (interrupted > 0) console.warn(`Marked ${interrupted} interrupted manifest refresh(es) as failed.`)
  const queriesInterrupted = await new QueryExecutionsRepository(pool).failInterrupted()
  if (queriesInterrupted > 0) console.warn(`Marked ${queriesInterrupted} interrupted query(ies) as failed.`)
  if (!env.CONNECTION_ENCRYPTION_KEY) {
    console.warn("CONNECTION_ENCRYPTION_KEY is not set — source connection endpoints will return 503.")
  }
} else {
  console.warn("DATABASE_URL is not set — workspace storage endpoints will return 503.")
}

const sources = createSourceAdapters()
const refreshes = new RefreshRunner()
const queries = new QueryRunner()
const app = createApp(env, { pool, sources, refreshes, queries })

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`manifest-backend listening on http://${env.HOST}:${env.PORT}`)
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Running refreshes and queries stop now and record why; pools close once they have.
    const stopped = Promise.all([refreshes.shutdown(), queries.shutdown()])
    server.close(() => {
      void stopped
        .then(() => Promise.allSettled([closeSourceAdapters(sources), pool?.end()]))
        .finally(() => process.exit(0))
    })
  })
}
