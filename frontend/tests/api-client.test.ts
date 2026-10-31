import assert from "node:assert/strict"
import test from "node:test"

import { ApiError, unwrapEnvelope } from "../src/shared/api/client.ts"

test("unwrapEnvelope returns the result of a success envelope", () => {
  const result = unwrapEnvelope<{ pong: boolean }>(200, { success: true, result: { pong: true } })
  assert.equal(result.pong, true)
})

test("unwrapEnvelope throws an ApiError with the stable backend code", () => {
  assert.throws(
    () =>
      unwrapEnvelope(404, {
        success: false,
        error: { code: "NOT_FOUND", message: "No route", requestId: "req-1" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, "NOT_FOUND")
      assert.equal(error.status, 404)
      assert.equal(error.requestId, "req-1")
      assert.equal(error.details, undefined)
      return true
    },
  )
})

test("unwrapEnvelope keeps error details such as a failure reason", () => {
  assert.throws(
    () =>
      unwrapEnvelope(422, {
        success: false,
        error: { code: "SOURCE_CONNECTION_FAILED", message: "No", details: { reason: "timeout" } },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.deepEqual(error.details, { reason: "timeout" })
      return true
    },
  )
})

test("unwrapEnvelope rejects bodies that are not envelopes", () => {
  assert.throws(() => unwrapEnvelope(200, "<html>proxy error</html>"), /unexpected response/)
})
