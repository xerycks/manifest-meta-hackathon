import assert from "node:assert/strict"
import type { Server } from "node:http"
import test, { after, before } from "node:test"

import express from "express"
import { z } from "zod"

import { loadEnv } from "../../src/config/env.js"
import { createApp } from "../../src/server/app.js"
import { errorHandler, requestId } from "../../src/shared/http/middleware.js"
import { ok } from "../../src/shared/http/respond.js"
import { validate } from "../../src/shared/http/validate.js"

let server: Server
let baseUrl: string

before(async () => {
  const env = loadEnv({ NODE_ENV: "test", CORS_ORIGINS: "http://localhost:5173" })
  const app = createApp(env)
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

test("unknown routes return the stable NOT_FOUND envelope with a request id", async () => {
  const response = await fetch(`${baseUrl}/api/v1/does-not-exist`)
  assert.equal(response.status, 404)
  assert.ok(response.headers.get("x-request-id"))
  const body = (await response.json()) as {
    success: boolean
    error: { code: string; message: string; requestId: string }
  }
  assert.equal(body.success, false)
  assert.equal(body.error.code, "NOT_FOUND")
  assert.equal(body.error.requestId, response.headers.get("x-request-id"))
})

test("malformed JSON returns BAD_REQUEST instead of a 500", async () => {
  const response = await fetch(`${baseUrl}/api/v1/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json",
  })
  assert.equal(response.status, 400)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, "BAD_REQUEST")
})

test("validate middleware rejects bad input and passes coerced input through", async () => {
  const app = express()
  app.use(requestId)
  app.use(express.json())
  const schema = z.object({ limit: z.coerce.number().int().min(1).max(10) })
  app.post("/echo", validate("body", schema), (req, res) => ok(res, req.body))
  app.use(errorHandler)

  const probe = app.listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => probe.once("listening", resolve))
  const address = probe.address()
  assert.ok(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/echo`
  try {
    const bad = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 99 }),
    })
    assert.equal(bad.status, 422)
    const badBody = (await bad.json()) as { error: { code: string } }
    assert.equal(badBody.error.code, "VALIDATION_FAILED")

    const good = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: "3" }),
    })
    assert.equal(good.status, 200)
    const goodBody = (await good.json()) as { result: { limit: number } }
    assert.equal(goodBody.result.limit, 3)
  } finally {
    await new Promise<void>((resolve, reject) => {
      probe.close((error) => (error ? reject(error) : resolve()))
    })
  }
})
