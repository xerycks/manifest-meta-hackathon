import { loadEnv } from "./config/env.js"
import { createApp } from "./server/app.js"
import { createPool } from "./shared/postgres/client.js"
import { runMigrations } from "./storage/migrations.js"

const env = loadEnv()

const pool = env.DATABASE_URL ? createPool(env.DATABASE_URL) : null
if (pool) {
  const applied = await runMigrations(pool)
  if (applied.length > 0) console.log(`Applied migrations: ${applied.join(", ")}`)
} else {
  console.warn("DATABASE_URL is not set — workspace storage endpoints will return 503.")
}

const app = createApp(env, { pool })

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`manifest-backend listening on http://${env.HOST}:${env.PORT}`)
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool?.end().finally(() => process.exit(0))
    })
  })
}
