import assert from "node:assert/strict"
import type { Server } from "node:http"
import test, { after, before } from "node:test"

import { loadEnv } from "../../src/config/env.js"
import { createApp } from "../../src/server/app.js"

let server: Server
let baseUrl: string

before(async () => {
  const app = createApp(loadEnv({ NODE_ENV: "test" }))
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

test("without DATABASE_URL, workspace endpoints return 503 STORAGE_NOT_CONFIGURED", async () => {
  const response = await fetch(`${baseUrl}/api/v1/workspaces`)
  assert.equal(response.status, 503)
  const body = (await response.json()) as { success: boolean; error: { code: string } }
  assert.equal(body.success, false)
  assert.equal(body.error.code, "STORAGE_NOT_CONFIGURED")
})

test("without DATABASE_URL, connection endpoints also return 503 STORAGE_NOT_CONFIGURED", async () => {
  const response = await fetch(
    `${baseUrl}/api/v1/workspaces/00000000-0000-0000-0000-000000000000/connections`,
  )
  assert.equal(response.status, 503)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, "STORAGE_NOT_CONFIGURED")
})

test("without DATABASE_URL, dashboard endpoints also return 503 STORAGE_NOT_CONFIGURED", async () => {
  const response = await fetch(
    `${baseUrl}/api/v1/workspaces/00000000-0000-0000-0000-000000000000/dashboards`,
  )
  assert.equal(response.status, 503)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, "STORAGE_NOT_CONFIGURED")
})

test("health still reports ok and names the missing storage", async () => {
  const response = await fetch(`${baseUrl}/health`)
  const body = (await response.json()) as { result: { status: string; storage: string } }
  assert.equal(body.result.status, "ok")
  assert.equal(body.result.storage, "not-configured")
})
