import assert from "node:assert/strict"
import test from "node:test"

import { loadEnv } from "../../src/config/env.js"

test("production with storage requires SESSION_SECRET", () => {
  assert.throws(
    () =>
      loadEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://localhost:5432/manifest",
      }),
    /SESSION_SECRET is required/,
  )
})

test("dev login is forced off in production and Google needs both credentials", () => {
  const prod = loadEnv({ NODE_ENV: "production", ALLOW_DEV_LOGIN: "true" })
  assert.equal(prod.devLoginEnabled, false)

  const local = loadEnv({ NODE_ENV: "local", ALLOW_DEV_LOGIN: "true" })
  assert.equal(local.devLoginEnabled, true)
  assert.equal(local.googleEnabled, false)

  assert.throws(() => loadEnv({ GOOGLE_CLIENT_ID: "only-id" }), /must be set together/)
  const google = loadEnv({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" })
  assert.equal(google.googleEnabled, true)
})
