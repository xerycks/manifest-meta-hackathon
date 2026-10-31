import { loadEnv } from "../config/env.js"
import { createPool } from "../shared/postgres/client.js"
import { buildDemoSource, DEMO_SOURCE_SCHEMAS } from "./demo-source-builder.js"

// Builds the synthetic analytical source used for demos. Local only.
const env = loadEnv()
if (env.NODE_ENV === "production") {
  console.error("The synthetic demo source is disabled in production.")
  process.exit(1)
}
if (!env.DEMO_SOURCE_DATABASE_URL) {
  console.error(
    "DEMO_SOURCE_DATABASE_URL is not set. Point it at a separate, disposable database (see backend/.env.example).",
  )
  process.exit(1)
}

const target = new URL(env.DEMO_SOURCE_DATABASE_URL)
if (env.DATABASE_URL) {
  const storage = new URL(env.DATABASE_URL)
  if (target.host === storage.host && target.pathname === storage.pathname) {
    console.error("DEMO_SOURCE_DATABASE_URL must not point at the application storage database.")
    process.exit(1)
  }
}

const pool = createPool(env.DEMO_SOURCE_DATABASE_URL)
try {
  const summary = await buildDemoSource(pool)
  console.log(
    `Rebuilt schemas ${DEMO_SOURCE_SCHEMAS.join(" and ")} (synthetic) in database "${decodeURIComponent(target.pathname.slice(1))}" on ${target.hostname}:`,
  )
  console.log(
    `  ${summary.customers} customers, ${summary.products} products, ${summary.orders} orders, ${summary.orderItems} order items, ${summary.agents} agents, ${summary.tickets} tickets`,
  )
} finally {
  await pool.end()
}
