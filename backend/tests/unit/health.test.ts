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

test("GET /health returns the success envelope", async () => {
  const response = await fetch(`${baseUrl}/health`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { success: boolean; result: { status: string } }
  assert.equal(body.success, true)
  assert.equal(body.result.status, "ok")
})

test("loadEnv rejects an invalid port", () => {
  assert.throws(() => loadEnv({ PORT: "99999" }), /Invalid environment configuration/)
})
