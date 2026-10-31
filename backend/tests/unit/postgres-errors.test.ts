import assert from "node:assert/strict"
import test from "node:test"

import { mapPostgresError } from "../../src/connections/adapters/postgres.js"

function driverError(message: string, code?: string): Error {
  return Object.assign(new Error(message), code ? { code } : {})
}

test("authentication failures map to auth_failed with a useful message", () => {
  const wrongPassword = mapPostgresError(
    driverError('password authentication failed for user "analyst"', "28P01"),
  )
  assert.equal(wrongPassword.reason, "auth_failed")
  assert.equal(wrongPassword.message, "PostgreSQL rejected the username or password.")

  const unknownRole = mapPostgresError(driverError('role "ghost" does not exist', "28000"))
  assert.equal(unknownRole.reason, "auth_failed")

  const missingPassword = mapPostgresError(
    driverError("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string"),
  )
  assert.equal(missingPassword.reason, "auth_failed")
  assert.match(missingPassword.message, /requires a password/)
})

test("missing databases, unreachable hosts, and timeouts are distinguished", () => {
  assert.equal(
    mapPostgresError(driverError('database "nope" does not exist', "3D000")).reason,
    "database_not_found",
  )
  assert.equal(mapPostgresError(driverError("connect ECONNREFUSED", "ECONNREFUSED")).reason, "host_unreachable")
  assert.equal(mapPostgresError(driverError("getaddrinfo ENOTFOUND db.invalid", "ENOTFOUND")).reason, "host_unreachable")
  const aggregate = new AggregateError([driverError("refused", "ECONNREFUSED")])
  assert.equal(mapPostgresError(aggregate).reason, "host_unreachable")

  assert.equal(mapPostgresError(driverError("timeout expired")).reason, "timeout")
  assert.equal(mapPostgresError(driverError("Query read timeout")).reason, "timeout")
  assert.equal(
    mapPostgresError(driverError("canceling statement due to statement timeout", "57014")).reason,
    "timeout",
  )
})

test("TLS problems map to tls_failed", () => {
  assert.equal(mapPostgresError(driverError("The server does not support SSL connections")).reason, "tls_failed")
  assert.equal(mapPostgresError(driverError("self-signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT")).reason, "tls_failed")
  assert.equal(mapPostgresError(driverError("Hostname/IP does not match", "ERR_TLS_CERT_ALTNAME_INVALID")).reason, "tls_failed")
  const requiresTls = mapPostgresError(
    driverError('no pg_hba.conf entry for host "10.0.0.5", user "a", database "b", no encryption', "28000"),
  )
  assert.equal(requiresTls.reason, "tls_failed")
  assert.match(requiresTls.message, /requires an encrypted connection/)
})

test("unknown failures get a generic message that never echoes driver text", () => {
  const secretLooking = driverError("boom: postgres://analyst:hunter2@db.internal/sales")
  const mapped = mapPostgresError(secretLooking)
  assert.equal(mapped.reason, "unknown")
  assert.ok(!mapped.message.includes("hunter2"))
  assert.equal(mapPostgresError("not even an error").reason, "unknown")
})
