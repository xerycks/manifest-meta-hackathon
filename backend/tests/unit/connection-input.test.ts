import assert from "node:assert/strict"
import test from "node:test"

import {
  createConnectionSchema,
  isSystemSchema,
  updateConnectionSchema,
} from "../../src/connections/schemas.js"
import { savedPasswordReusable } from "../../src/connections/service.js"

const config = {
  host: "db.example.com",
  port: 5432,
  database: "analytics",
  username: "manifest_reader",
  sslMode: "require" as const,
}

function issues(result: { success: boolean; error?: { issues: { message: string }[] } }): string {
  return result.error?.issues.map((issue) => issue.message).join("; ") ?? ""
}

test("a valid create request is accepted and schemas are de-duplicated", () => {
  const parsed = createConnectionSchema.parse({
    name: " Sales DB ",
    engine: "postgres",
    config,
    password: "s3cret",
    schemas: ["shop", "support", "shop"],
  })
  assert.equal(parsed.name, "Sales DB")
  assert.deepEqual(parsed.schemas, ["shop", "support"])
})

test("system schemas are never selectable and at least one schema is required", () => {
  for (const name of ["pg_catalog", "information_schema", "pg_toast", "pg_temp_3"]) {
    assert.equal(isSystemSchema(name), true, name)
    const result = createConnectionSchema.safeParse({ name: "x", engine: "postgres", config, schemas: [name] })
    assert.equal(result.success, false)
    assert.match(issues(result), /System schemas cannot be selected/)
  }
  assert.equal(isSystemSchema("public"), false)
  const none = createConnectionSchema.safeParse({ name: "x", engine: "postgres", config, schemas: [] })
  assert.match(issues(none), /at least one schema/)
})

test("hosts cannot smuggle a scheme, port, path, credentials, or socket", () => {
  for (const host of ["postgres://db", "db:5432", "db/analytics", "user@db", "/var/run/postgresql", "db example"]) {
    const result = createConnectionSchema.safeParse({
      name: "x",
      engine: "postgres",
      config: { ...config, host },
      schemas: ["public"],
    })
    assert.equal(result.success, false, host)
  }
  for (const host of ["localhost", "10.0.0.5", "db-1.internal.example", "::1"]) {
    const result = createConnectionSchema.safeParse({
      name: "x",
      engine: "postgres",
      config: { ...config, host },
      schemas: ["public"],
    })
    assert.equal(result.success, true, host)
  }
})

test("unknown fields and unsupported engines are rejected; validation never echoes the password", () => {
  const extra = createConnectionSchema.safeParse({
    name: "x",
    engine: "postgres",
    config,
    schemas: ["public"],
    uri: "postgres://u:p@h/d",
  })
  assert.equal(extra.success, false)
  const mongo = createConnectionSchema.safeParse({ name: "x", engine: "mongodb", config, schemas: ["public"] })
  assert.equal(mongo.success, false)

  const longPassword = "p".repeat(2000)
  const tooLong = createConnectionSchema.safeParse({
    name: "x",
    engine: "postgres",
    config,
    password: longPassword,
    schemas: ["public"],
  })
  assert.equal(tooLong.success, false)
  assert.ok(!JSON.stringify(tooLong.error?.issues).includes(longPassword))
})

test("updates need at least one change", () => {
  assert.equal(updateConnectionSchema.safeParse({}).success, false)
  assert.equal(updateConnectionSchema.safeParse({ name: "Renamed" }).success, true)
})

test("a saved password is only reused for the same host, port, username, and SSL mode", () => {
  assert.equal(savedPasswordReusable(config, { ...config, database: "other_db" }), true)
  assert.equal(savedPasswordReusable(config, { ...config, host: "evil.example.com" }), false)
  assert.equal(savedPasswordReusable(config, { ...config, port: 6543 }), false)
  assert.equal(savedPasswordReusable(config, { ...config, username: "admin" }), false)
  assert.equal(savedPasswordReusable(config, { ...config, sslMode: "disable" }), false)
})
