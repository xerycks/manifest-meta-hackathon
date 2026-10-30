import assert from "node:assert/strict"
import type { Server } from "node:http"
import test, { after, before } from "node:test"

import type { Express } from "express"
import type { Pool } from "pg"

import { loadEnv } from "../../src/config/env.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { runMigrations } from "../../src/storage/migrations.js"
import {
  WorkspaceSettingsRepository,
  type Workspace,
} from "../../src/workspaces/repository.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const skip = !TEST_DATABASE_URL

let pool: Pool
let server: Server
let baseUrl: string
let cookie = ""
let csrf = ""

async function startServer(app: Express): Promise<void> {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  baseUrl = `http://127.0.0.1:${address.port}`
}

async function stopServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (cookie) headers.Cookie = cookie
  if (csrf && init.method && init.method !== "GET") headers["X-Manifest-CSRF"] = csrf
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...((init.headers as Record<string, string>) ?? {}) },
  })
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";")
    if (pair?.startsWith("manifest_session=")) cookie = pair
  }
  return { status: response.status, body: (await response.json()) as T }
}

before(async () => {
  if (!TEST_DATABASE_URL) return
  pool = createPool(TEST_DATABASE_URL)
  await pool.query(
    "DROP TABLE IF EXISTS google_login_attempts, sessions, workspace_members, workspace_settings, users, workspaces, schema_migrations CASCADE",
  )
  const applied = await runMigrations(pool)
  assert.deepEqual(applied, ["0001_workspaces.sql", "0002_auth.sql"])
  // Rerunning migrations is a no-op.
  assert.deepEqual(await runMigrations(pool), [])
  const env = loadEnv({
    NODE_ENV: "test",
    ALLOW_DEV_LOGIN: "true",
    SESSION_SECRET: "integration-test-secret-at-least-32-chars",
  })
  await startServer(createApp(env, { pool }))

  const login = await api<{ result: { csrfToken: string } }>("/api/v1/auth/dev", {
    method: "POST",
    body: JSON.stringify({ email: "owner@example.com", name: "Owner" }),
  })
  assert.equal(login.status, 200)
  csrf = login.body.result.csrfToken
})

after(async () => {
  if (!TEST_DATABASE_URL) return
  await stopServer()
  await pool.end()
})

test("workspaces can be created and listed; duplicate slugs conflict", { skip }, async () => {
  const created = await api<{ success: boolean; result: Workspace }>("/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: "Acme analytics", slug: "acme" }),
  })
  assert.equal(created.status, 201)

  const duplicate = await api<{ error: { code: string } }>("/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: "Acme again", slug: "acme" }),
  })
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.body.error.code, "CONFLICT")
})

test("workspace settings are isolated: one workspace cannot read another's", { skip }, async () => {
  const list = await api<{ result: Workspace[] }>("/api/v1/workspaces")
  const acme = list.body.result.find((workspace) => workspace.slug === "acme")
  assert.ok(acme)

  const other = await api<{ result: Workspace }>("/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: "Globex", slug: "globex" }),
  })
  assert.equal(other.status, 201)
  const globex = other.body.result

  const setAcme = await api<{ result: { value: unknown } }>(
    `/api/v1/workspaces/${acme.id}/settings/description`,
    { method: "PUT", body: JSON.stringify({ value: "Acme only" }) },
  )
  assert.equal(setAcme.status, 200)

  // Same key under the other workspace: not found, never the Acme value.
  const readAsGlobex = await api<{ error: { code: string } }>(
    `/api/v1/workspaces/${globex.id}/settings/description`,
  )
  assert.equal(readAsGlobex.status, 404)
  assert.equal(readAsGlobex.body.error.code, "NOT_FOUND")

  // Writing the same key in Globex must not change Acme's value.
  await api(`/api/v1/workspaces/${globex.id}/settings/description`, {
    method: "PUT",
    body: JSON.stringify({ value: "Globex only" }),
  })
  const acmeSettings = await api<{ result: { value: unknown } }>(
    `/api/v1/workspaces/${acme.id}/settings/description`,
  )
  assert.equal(acmeSettings.body.result.value, "Acme only")

  // Unknown workspace ids are indistinguishable from missing records.
  const missing = await api<{ error: { code: string } }>(
    "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/settings",
  )
  assert.equal(missing.status, 404)
})

test("settings survive a restart (new pool, same database)", { skip }, async () => {
  const list = await api<{ result: Workspace[] }>("/api/v1/workspaces")
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
