import assert from "node:assert/strict"
import test from "node:test"

import { loadEnv } from "../../src/config/env.js"

const SESSION_SECRET = "production-session-secret-at-least-32-chars"
const KEY = "a".repeat(64)

test("production with storage requires CONNECTION_ENCRYPTION_KEY", () => {
  assert.throws(
    () =>
      loadEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://localhost:5432/manifest",
        SESSION_SECRET,
      }),
    /CONNECTION_ENCRYPTION_KEY is required/,
  )
  const env = loadEnv({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://localhost:5432/manifest",
    SESSION_SECRET,
    CONNECTION_ENCRYPTION_KEY: KEY,
  })
  assert.equal(env.CONNECTION_ENCRYPTION_KEY, KEY)
})

test("the key stays optional locally and must be 64 hex characters", () => {
  const local = loadEnv({ NODE_ENV: "local", DATABASE_URL: "postgres://localhost:5432/manifest" })
  assert.equal(local.CONNECTION_ENCRYPTION_KEY, undefined)
  assert.throws(() => loadEnv({ CONNECTION_ENCRYPTION_KEY: "not-hex" }), /64 hex characters/)
  assert.throws(() => loadEnv({ CONNECTION_ENCRYPTION_KEY: "ab".repeat(16) }), /64 hex characters/)
})

test("validation errors name the variable without echoing its value", () => {
  const bogus = "zz".repeat(32)
  assert.throws(
    () => loadEnv({ CONNECTION_ENCRYPTION_KEY: bogus }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /CONNECTION_ENCRYPTION_KEY/)
      assert.ok(!error.message.includes(bogus))
      return true
    },
  )
})
