import { Pool } from "pg"

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "manifest-backend",
  })
  pool.on("error", (error) => {
    console.error("Idle PostgreSQL client error", error)
  })
  return pool
}
