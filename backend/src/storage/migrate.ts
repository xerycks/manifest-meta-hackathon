import { loadEnv } from "../config/env.js"
import { createPool } from "../shared/postgres/client.js"
import { runMigrations } from "./migrations.js"

const env = loadEnv()
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy backend/.env.example to backend/.env.local first.")
  process.exit(1)
}

const pool = createPool(env.DATABASE_URL)
try {
  const applied = await runMigrations(pool)
  console.log(
    applied.length > 0
      ? `Applied migrations: ${applied.join(", ")}`
      : "Storage is already up to date.",
  )
} finally {
  await pool.end()
}
