import { MongoClient } from "mongodb"

import { loadEnv } from "../config/env.js"
import { buildDemoMongo, DEMO_MONGO_COLLECTIONS, DEMO_MONGO_DATABASE } from "./demo-mongo-builder.js"

// Builds the synthetic MongoDB demo database. Local only.
const env = loadEnv()
if (env.NODE_ENV === "production") {
  console.error("The synthetic MongoDB demo database is disabled in production.")
  process.exit(1)
}
if (!env.DEMO_MONGO_URL) {
  console.error(
    "DEMO_MONGO_URL is not set. Point it at a disposable local MongoDB server (see backend/.env.example).",
  )
  process.exit(1)
}

const client = new MongoClient(env.DEMO_MONGO_URL, {
  appName: "manifest-demo",
  serverSelectionTimeoutMS: 5_000,
})
try {
  const summary = await buildDemoMongo(client.db(DEMO_MONGO_DATABASE))
  console.log(
    `Rebuilt ${DEMO_MONGO_COLLECTIONS.join(", ")} (synthetic) in database "${DEMO_MONGO_DATABASE}":`,
  )
  console.log(
    `  ${summary.sessions} sessions, ${summary.webEvents} web events, ${summary.productReviews} product reviews, and the product_ratings view`,
  )
} catch (error) {
  // Driver messages can repeat the connection string, so only the error's kind is printed.
  console.error(`Could not build the demo database (${error instanceof Error ? error.name : "error"}).`)
  process.exitCode = 1
} finally {
  await client.close()
}
