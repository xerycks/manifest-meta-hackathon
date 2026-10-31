import assert from "node:assert/strict"
import test from "node:test"

import {
  createConnectionSchema,
  isSystemDatabase,
  isSystemSchema,
  testConnectionSchema,
  updateConnectionSchema,
  type MongoFieldsConfig,
  type PostgresConfig,
  type SourceSettings,
} from "../../src/connections/schemas.js"
import { resolveCredentials, savedPasswordReusable } from "../../src/connections/service.js"
import { AppError } from "../../src/shared/http/errors.js"

const config: PostgresConfig = {
  host: "db.example.com",
  port: 5432,
  database: "analytics",
  username: "manifest_reader",
  sslMode: "require",
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
  // PostgreSQL settings are not MongoDB settings, and engines must be known.
  const mongo = createConnectionSchema.safeParse({ name: "x", engine: "mongodb", config, schemas: ["public"] })
  assert.equal(mongo.success, false)
  const other = createConnectionSchema.safeParse({ name: "x", engine: "mysql", config, schemas: ["public"] })
  assert.equal(other.success, false)

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

const postgres = (overrides: Partial<PostgresConfig> = {}): SourceSettings => ({
  engine: "postgres",
  config: { ...config, ...overrides },
})

const mongoConfig: MongoFieldsConfig = {
  mode: "fields",
  host: "mongo.example.com",
  port: 27017,
  database: "events",
  username: "reader",
  authSource: null,
  tls: true,
}
const mongo = (overrides: Partial<MongoFieldsConfig> = {}): SourceSettings => ({
  engine: "mongodb",
  config: { ...mongoConfig, ...overrides },
})

test("a saved password is only reused for the same host, port, username, and SSL or TLS setting", () => {
  assert.equal(savedPasswordReusable(postgres(), postgres({ database: "other_db" })), true)
  assert.equal(savedPasswordReusable(postgres(), postgres({ host: "evil.example.com" })), false)
  assert.equal(savedPasswordReusable(postgres(), postgres({ port: 6543 })), false)
  assert.equal(savedPasswordReusable(postgres(), postgres({ username: "admin" })), false)
  assert.equal(savedPasswordReusable(postgres(), postgres({ sslMode: "disable" })), false)

  assert.equal(savedPasswordReusable(mongo(), mongo({ database: "other" })), true)
  for (const change of [{ host: "evil.example.com" }, { port: 1 }, { username: "root" }, { authSource: "events" }, { tls: false }]) {
    assert.equal(savedPasswordReusable(mongo(), mongo(change)), false, JSON.stringify(change))
  }
  assert.equal(savedPasswordReusable(postgres(), mongo()), false)
})

test("MongoDB settings: fields or a connection string, databases instead of schemas", () => {
  const fields = createConnectionSchema.parse({
    name: "Events",
    engine: "mongodb",
    config: { mode: "fields", host: "127.0.0.1", port: 27017, database: "events", username: " ", authSource: "", tls: false },
    schemas: ["events", "events"],
  })
  assert.deepEqual(fields.config, { mode: "fields", host: "127.0.0.1", port: 27017, database: "events", username: null, authSource: null, tls: false })
  assert.deepEqual(fields.schemas, ["events"])

  for (const name of ["admin", "local", "config"]) {
    assert.equal(isSystemDatabase(name), true)
    const result = createConnectionSchema.safeParse({ name: "x", engine: "mongodb", config: { mode: "uri" }, uri: "mongodb://h", schemas: [name] })
    assert.match(issues(result), /System databases cannot be selected/)
  }
  const badDatabase = createConnectionSchema.safeParse({
    name: "x",
    engine: "mongodb",
    config: { ...mongoConfig, database: "my.db" },
    schemas: ["events"],
  })
  assert.equal(badDatabase.success, false)

  const uri = "mongodb://reader:hunter2@h/events"
  assert.equal(testConnectionSchema.safeParse({ engine: "mongodb", config: { mode: "uri" }, uri }).success, true)
  const wrongScheme = testConnectionSchema.safeParse({ engine: "mongodb", config: { mode: "uri" }, uri: "postgres://u:hunter2@h/db" })
  assert.equal(wrongScheme.success, false)
  assert.ok(!JSON.stringify(wrongScheme.error?.issues).includes("hunter2"))
  // Connection strings are MongoDB-only.
  assert.equal(testConnectionSchema.safeParse({ engine: "postgres", config, uri }).success, false)
})

function rejects(run: () => unknown, field: string, message: RegExp) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.code, "VALIDATION_FAILED")
    assert.deepEqual(error.details, { field })
    assert.match(error.message, message)
    return true
  })
}

test("credentials: typed ones win, saved ones are reused only where safe", () => {
  const savedPostgres = { settings: postgres(), secret: { password: "pw" } }
  assert.deepEqual(resolveCredentials(postgres({ database: "x" }), {}, savedPostgres).secret, { password: "pw" })
  assert.deepEqual(resolveCredentials(postgres(), { password: "new" }, savedPostgres).secret, { password: "new" })
  rejects(() => resolveCredentials(postgres({ host: "other" }), {}, savedPostgres), "password", /Re-enter the password/)
  rejects(() => resolveCredentials(postgres(), { uri: "mongodb://h" }, null), "uri", /connection-string mode/)

  const uri = "mongodb://reader:hunter2@db.internal:27017/events"
  const fromUri = resolveCredentials({ engine: "mongodb", config: { mode: "uri" } }, { uri }, null)
  assert.deepEqual(fromUri, {
    settings: { engine: "mongodb", config: { mode: "uri", hosts: ["db.internal:27017"], srv: false, database: "events" } },
    secret: { uri },
  })
  // The saved connection string stays while the source stays in connection-string mode.
  assert.deepEqual(
    resolveCredentials({ engine: "mongodb", config: { mode: "uri" } }, {}, fromUri).secret,
    { uri },
  )
  rejects(() => resolveCredentials({ engine: "mongodb", config: { mode: "uri" } }, {}, null), "uri", /Enter the connection string/)
  rejects(
    () => resolveCredentials({ engine: "mongodb", config: { mode: "uri" } }, { uri, password: "pw" }, null),
    "password",
    /in the connection string/,
  )
  rejects(
    () => resolveCredentials({ engine: "mongodb", config: { mode: "uri" } }, { uri: "mongodb://h/?authMechanism=MONGODB-AWS" }, null),
    "uri",
    /username and password/,
  )
  // Switching to fields never carries the connection string over.
  assert.deepEqual(resolveCredentials(mongo({ username: null }), {}, fromUri).secret, {})
  rejects(() => resolveCredentials(mongo({ username: null }), { password: "pw" }, null), "username", /username/)

  const savedMongo = { settings: mongo(), secret: { password: "pw" } }
  assert.deepEqual(resolveCredentials(mongo({ database: "other" }), {}, savedMongo).secret, { password: "pw" })
  rejects(() => resolveCredentials(mongo({ tls: false }), {}, savedMongo), "password", /Re-enter the password/)
  // Without a username nothing signs in, so the saved password is dropped instead of demanded.
  assert.deepEqual(resolveCredentials(mongo({ username: null }), {}, savedMongo).secret, {})
})
