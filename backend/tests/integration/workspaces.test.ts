import assert from "node:assert/strict"
import test, { after, before } from "node:test"

import type { Pool } from "pg"

import { loadEnv } from "../../src/config/env.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { runMigrations } from "../../src/storage/migrations.js"
import {
  WorkspaceSettingsRepository,
  type Workspace,
} from "../../src/workspaces/repository.js"
import { signIn, type TestClient } from "./support/http.js"
import { startApp, type RunningApp } from "./support/server.js"
import { migrationNames, resetStorage } from "./support/storage.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const skip = !TEST_DATABASE_URL

let pool: Pool
let running: RunningApp
let owner: TestClient

before(async () => {
  if (!TEST_DATABASE_URL) return
  pool = createPool(TEST_DATABASE_URL)
  assert.deepEqual(await resetStorage(pool), migrationNames())
  // Rerunning migrations is a no-op.
  assert.deepEqual(await runMigrations(pool), [])
  const env = loadEnv({
    NODE_ENV: "test",
    ALLOW_DEV_LOGIN: "true",
    SESSION_SECRET: "integration-test-secret-at-least-32-chars",
  })
  running = await startApp(createApp(env, { pool }))
  owner = (await signIn(running.baseUrl, "owner@example.com", "Owner")).client
})

after(async () => {
  if (!TEST_DATABASE_URL) return
  await running.close()
  await pool.end()
})

test("workspaces can be created and listed; duplicate slugs conflict", { skip }, async () => {
  const created = await owner.call<{ success: boolean; result: Workspace }>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme analytics", slug: "acme" },
  })
  assert.equal(created.status, 201)

  const duplicate = await owner.call<{ error: { code: string } }>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme again", slug: "acme" },
  })
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.body.error.code, "CONFLICT")
})

test("workspace settings are isolated: one workspace cannot read another's", { skip }, async () => {
  const list = await owner.call<{ result: Workspace[] }>("/api/v1/workspaces")
  const acme = list.body.result.find((workspace) => workspace.slug === "acme")
  assert.ok(acme)

  const other = await owner.call<{ result: Workspace }>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Globex", slug: "globex" },
  })
  assert.equal(other.status, 201)
  const globex = other.body.result

  const setAcme = await owner.call<{ result: { value: unknown } }>(
    `/api/v1/workspaces/${acme.id}/settings/description`,
    { method: "PUT", json: { value: "Acme only" } },
  )
  assert.equal(setAcme.status, 200)

  // Same key under the other workspace: not found, never the Acme value.
  const readAsGlobex = await owner.call<{ error: { code: string } }>(
    `/api/v1/workspaces/${globex.id}/settings/description`,
  )
  assert.equal(readAsGlobex.status, 404)
  assert.equal(readAsGlobex.body.error.code, "NOT_FOUND")

  // Writing the same key in Globex must not change Acme's value.
  await owner.call(`/api/v1/workspaces/${globex.id}/settings/description`, {
    method: "PUT",
    json: { value: "Globex only" },
  })
  const acmeSettings = await owner.call<{ result: { value: unknown } }>(
    `/api/v1/workspaces/${acme.id}/settings/description`,
  )
  assert.equal(acmeSettings.body.result.value, "Acme only")

  // Unknown workspace ids are indistinguishable from missing records.
  const missing = await owner.call<{ error: { code: string } }>(
    "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/settings",
  )
  assert.equal(missing.status, 404)
})

test("settings survive a restart (new pool, same database)", { skip }, async () => {
  const list = await owner.call<{ result: Workspace[] }>("/api/v1/workspaces")
  const acme = list.body.result.find((workspace) => workspace.slug === "acme")
  assert.ok(acme)

  const freshPool = createPool(TEST_DATABASE_URL as string)
  try {
    const settings = new WorkspaceSettingsRepository(freshPool)
    const setting = await settings.get(acme.id, "description")
    assert.equal(setting?.value, "Acme only")
  } finally {
    await freshPool.end()
  }
})
