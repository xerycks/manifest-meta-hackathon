import { AgentRunsRepository } from "./agent/repository.js"
import { AgentRunner } from "./agent/runner.js"
import { loadEnv } from "./config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "./connections/adapters/index.js"
import { DashboardRefresher } from "./dashboards/refresh.js"
import { ManifestsRepository } from "./manifests/repository.js"
import { RefreshRunner } from "./manifests/runner.js"
import { QueryExecutionsRepository } from "./queries/repository.js"
import { QueryRunner } from "./queries/runner.js"
import { RoutineDispatcher } from "./routines/dispatcher.js"
import { RoutinesRepository } from "./routines/repository.js"
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
  const runs = await new AgentRunsRepository(pool).recoverAfterRestart()
  if (runs.interrupted > 0)
    console.warn(`Marked ${runs.interrupted} agent run(s) as interrupted (retryable).`)
  if (runs.expired > 0)
    console.warn(`Stopped ${runs.expired} agent run(s) whose clarification went unanswered.`)
  const routineRuns = await new RoutinesRepository(pool).recoverAfterRestart()
  if (routineRuns > 0) console.warn(`Marked ${routineRuns} routine run(s) as interrupted (not retried).`)
  if (!env.CONNECTION_ENCRYPTION_KEY) {
    console.warn("CONNECTION_ENCRYPTION_KEY is not set — source connection endpoints will return 503.")
  }
  if (env.AGENT_PROVIDER === "scripted") {
    console.warn("AGENT_PROVIDER=scripted — questions are answered by the scripted demo model (synthetic).")
  } else if (!env.ANTHROPIC_API_KEY) {
    console.warn("ANTHROPIC_API_KEY is not set — agent endpoints will return 503.")
  }
} else {
  console.warn("DATABASE_URL is not set — workspace storage endpoints will return 503.")
}

const sources = createSourceAdapters()
const refreshes = new RefreshRunner()
const queries = new QueryRunner()
const agents = new AgentRunner()
const dashboardRefreshes = new DashboardRefresher()
const routineDispatcher = new RoutineDispatcher({ intervalMs: env.ROUTINE_POLL_INTERVAL_MS })
const app = createApp(env, {
  pool,
  sources,
  refreshes,
  queries,
  agents,
  dashboardRefreshes,
  routineDispatcher,
})
if (pool) routineDispatcher.start()

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`manifest-backend listening on http://${env.HOST}:${env.PORT}`)
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Routines stop being claimed first; then running refreshes, queries, and agent runs stop
    // and record why (routine runs too, once theirs have); pools close once they have.
    const stopped = routineDispatcher.stop().then(() =>
      Promise.all([
        refreshes.shutdown(),
        dashboardRefreshes.shutdown(),
        queries.shutdown(),
        agents.shutdown(),
        routineDispatcher.drained(),
      ]),
    )
    server.close(() => {
      void stopped
        .then(() => Promise.allSettled([closeSourceAdapters(sources), pool?.end()]))
        .finally(() => process.exit(0))
    })
  })
}
