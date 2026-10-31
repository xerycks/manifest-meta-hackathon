import assert from "node:assert/strict"
import test from "node:test"

import type { Connection } from "../src/entities/connections/types.ts"
import {
  configFromDraft,
  describeConnectionError,
  draftErrors,
  draftFromConnection,
  emptyDraft,
  needsPasswordReentry,
  withEngine,
  parsePort,
  sameConnectionSettings,
  schemaOptions,
  toCreateInput,
  toTestInput,
  toUpdateInput,
  type ConnectionDraft,
} from "../src/features/manage-connections/connection-form.ts"
import { ApiError } from "../src/shared/api/client.ts"

const common = {
  id: "c1",
  workspaceId: "w1",
  name: "Demo store",
  hasPassword: true,
  schemas: ["support", "shop"],
  status: "connected" as const,
  lastTestedAt: "2026-10-30T10:00:00.000Z",
  lastError: null,
  createdAt: "2026-10-30T10:00:00.000Z",
  updatedAt: "2026-10-30T10:00:00.000Z",
  capabilities: {
    queryLanguage: "sql" as const,
    operations: ["sql_select" as const],
    readOnly: true as const,
    joins: true,
    aggregates: true,
    allowedStages: null,
    forbiddenStages: null,
    forbiddenOperators: [],
    summary: "Read-only SQL",
  },
}

const saved: Connection = {
  ...common,
  engine: "postgres",
  config: { host: "db.example.com", port: 5432, database: "shop", username: "reader", sslMode: "require" },
}

const savedMongo: Connection = {
  ...common,
  name: "Events",
  engine: "mongodb",
  config: { mode: "fields", host: "mongo.example.com", port: 27017, database: "events", username: "reader", authSource: null, tls: true },
  schemas: ["events"],
}

const savedUri: Connection = {
  ...common,
  name: "Atlas",
  engine: "mongodb",
  config: { mode: "uri", hosts: ["cluster0.example.net"], srv: true, database: "events" },
  schemas: ["events"],
}

function filled(overrides: Partial<ConnectionDraft> = {}): ConnectionDraft {
  return {
    ...emptyDraft(),
    name: " Demo store ",
    host: " db.example.com ",
    database: "shop",
    username: "reader",
    password: "s3cret",
    ...overrides,
  }
}

test("parsePort accepts 1-65535 whole numbers only", () => {
  assert.equal(parsePort("5432"), 5432)
  assert.equal(parsePort(" 6543 "), 6543)
  for (const bad of ["", "0", "65536", "54.3", "-1", "abc", "5432x", "1e3"]) {
    assert.equal(parsePort(bad), null, bad)
  }
})

test("draftErrors explains each missing or malformed field", () => {
  const errors = draftErrors(emptyDraft())
  assert.deepEqual(Object.keys(errors).sort(), ["database", "host", "name", "username"])
  assert.match(draftErrors(filled({ host: "db.example.com:5432" })).host ?? "", /Port field/)
  assert.match(draftErrors(filled({ host: "postgres://db" })).host ?? "", /without a scheme/)
  assert.match(draftErrors(filled({ host: "user@db" })).host ?? "", /host name or IP/)
  assert.ok(draftErrors(filled({ port: "99999" })).port)
  assert.deepEqual(draftErrors(filled()), {})
})

test("form drafts become trimmed API payloads; an empty password is omitted", () => {
  assert.deepEqual(configFromDraft(filled()), {
    host: "db.example.com",
    port: 5432,
    database: "shop",
    username: "reader",
    sslMode: "require",
  })
  assert.equal(configFromDraft(filled({ port: "nope" })), null)

  const test = toTestInput(filled({ password: "" }))
  assert.ok(test)
  assert.equal("password" in test, false)
  assert.equal(toTestInput(filled(), saved)?.connectionId, "c1")

  assert.deepEqual(toCreateInput(filled(), ["support", "shop"]), {
    name: "Demo store",
    engine: "postgres",
    config: configFromDraft(filled()),
    password: "s3cret",
    schemas: ["shop", "support"],
  })
  assert.equal(toCreateInput(filled(), []), null)
  assert.equal(toCreateInput(filled({ name: "  " }), ["shop"]), null)
})

test("edits send only what changed and keep the saved password when left blank", () => {
  const unchanged = draftFromConnection(saved)
  assert.equal(unchanged.password, "")
  assert.deepEqual(toUpdateInput(saved, unchanged, ["shop", "support"]), {})

  assert.deepEqual(toUpdateInput(saved, { ...unchanged, name: "Renamed" }, ["shop"]), {
    name: "Renamed",
    schemas: ["shop"],
  })
  const moved = toUpdateInput(saved, { ...unchanged, database: "shop_v2", password: "new" }, saved.schemas)
  assert.deepEqual(moved?.config, { ...saved.config, database: "shop_v2" })
  assert.equal(moved?.password, "new")
})

test("a saved password must be re-entered when the server identity changes", () => {
  const draft = draftFromConnection(saved)
  assert.equal(needsPasswordReentry(saved, draft), false)
  assert.equal(needsPasswordReentry(saved, { ...draft, database: "other" }), false)
  assert.equal(needsPasswordReentry(saved, { ...draft, host: "other.example.com" }), true)
  assert.equal(needsPasswordReentry(saved, { ...draft, port: "6543" }), true)
  assert.equal(needsPasswordReentry(saved, { ...draft, sslMode: "disable" }), true)
  assert.equal(needsPasswordReentry(saved, { ...draft, host: "other.example.com", password: "typed" }), false)
  assert.equal(needsPasswordReentry({ ...saved, hasPassword: false }, { ...draft, host: "x" }), false)
})

test("a test result only applies while the connection settings are unchanged", () => {
  const draft = filled()
  assert.equal(sameConnectionSettings(draft, { ...draft, name: "Other name" }), true)
  assert.equal(sameConnectionSettings(draft, { ...draft, port: " 5432" }), true)
  assert.equal(sameConnectionSettings(draft, { ...draft, password: "changed" }), false)
  assert.equal(sameConnectionSettings(draft, { ...draft, sslMode: "disable" }), false)
})

test("schemaOptions merges live and selected schemas and flags missing ones", () => {
  assert.deepEqual(schemaOptions(["shop", "public"], ["legacy", "shop"]), [
    { name: "legacy", missing: true },
    { name: "public", missing: false },
    { name: "shop", missing: false },
  ])
  assert.deepEqual(schemaOptions(null, ["shop"]), [{ name: "shop", missing: false }])
})

test("describeConnectionError surfaces the mapped reason and validation messages", () => {
  const failed = new ApiError(422, "SOURCE_CONNECTION_FAILED", "PostgreSQL rejected the username or password.", "r1", {
    reason: "auth_failed",
  })
  assert.deepEqual(describeConnectionError(failed), {
    title: "Sign-in rejected",
    message: "PostgreSQL rejected the username or password.",
  })
  const invalid = new ApiError(422, "VALIDATION_FAILED", "Invalid body", "r2", {
    issues: [{ path: "config.host", message: "Enter a host name or IP address" }],
  })
  assert.equal(describeConnectionError(invalid).message, "Enter a host name or IP address")
  assert.equal(describeConnectionError(new Error("offline")).message, "offline")
})

test("MongoDB drafts: fields or a connection string, with their own checks", () => {
  const mongo = withEngine(filled({ username: "", password: "" }), "mongodb")
  assert.equal(mongo.port, "27017")
  assert.equal(withEngine(filled({ port: "6000" }), "mongodb").port, "6000")
  assert.deepEqual(configFromDraft(mongo), {
    mode: "fields",
    host: "db.example.com",
    port: 27017,
    database: "shop",
    username: null,
    authSource: null,
    tls: true,
  })
  assert.match(draftErrors({ ...mongo, database: "my.db" }).database ?? "", /cannot contain/)
  assert.match(draftErrors({ ...mongo, password: "pw" }).username ?? "", /username for this password/)

  const uriDraft = { ...mongo, mongoMode: "uri" as const, password: "ignored" }
  assert.match(draftErrors(uriDraft).uri ?? "", /Paste the connection string/)
  assert.match(draftErrors({ ...uriDraft, uri: "postgres://x" }).uri ?? "", /mongodb:\/\//)
  const uri = "mongodb+srv://reader:pw@cluster0.example.net/events"
  assert.deepEqual(toCreateInput({ ...uriDraft, uri: ` ${uri} ` }, ["events"]), {
    name: "Demo store",
    engine: "mongodb",
    config: { mode: "uri" },
    uri,
    schemas: ["events"],
  })
  // A saved connection string is kept when the field is left blank.
  assert.deepEqual(toTestInput(draftFromConnection(savedUri), savedUri), {
    engine: "mongodb",
    config: { mode: "uri" },
    connectionId: "c1",
  })
  assert.equal(sameConnectionSettings(uriDraft, { ...uriDraft, uri: "mongodb://other" }), false)
  assert.equal(sameConnectionSettings(uriDraft, mongo), false)
})

test("MongoDB edits: only changes are sent, and secrets are reused only where the backend allows", () => {
  const fields = draftFromConnection(savedMongo)
  assert.deepEqual(toUpdateInput(savedMongo, fields, ["events"]), {})
  assert.deepEqual(toUpdateInput(savedMongo, { ...fields, database: "events_v2" }, ["events"])?.config, {
    mode: "fields",
    host: "mongo.example.com",
    port: 27017,
    database: "events_v2",
    username: "reader",
    authSource: null,
    tls: true,
  })
  assert.equal(needsPasswordReentry(savedMongo, { ...fields, database: "other" }), false)
  assert.equal(needsPasswordReentry(savedMongo, { ...fields, tls: false }), true)
  assert.equal(needsPasswordReentry(savedMongo, { ...fields, authSource: "events" }), true)
  // Clearing the username stops signing in, so no password is needed.
  const anonymous = { ...fields, username: "" }
  assert.equal(needsPasswordReentry(savedMongo, anonymous), false)
  assert.equal(toUpdateInput(savedMongo, anonymous, ["events"])?.config?.username, null)

  const uriDraft = draftFromConnection(savedUri)
  assert.equal(uriDraft.mongoMode, "uri")
  assert.equal(uriDraft.uri, "")
  assert.deepEqual(toUpdateInput(savedUri, { ...uriDraft, name: "Atlas prod" }, ["events"]), { name: "Atlas prod" })
  assert.deepEqual(toUpdateInput(savedUri, { ...uriDraft, uri: "mongodb://h/events" }, ["events"]), {
    uri: "mongodb://h/events",
  })
  // Switching to host and port with a username needs a typed password.
  const switched = { ...uriDraft, mongoMode: "fields" as const, host: "h", username: "reader" }
  assert.equal(needsPasswordReentry(savedUri, switched), true)
  assert.deepEqual(toUpdateInput(savedUri, { ...switched, password: "pw" }, ["events"]), {
    config: {
      mode: "fields",
      host: "h",
      port: 27017,
      database: "events",
      username: "reader",
      authSource: null,
      tls: true,
    },
    password: "pw",
  })
})

test("describeConnectionError titles field-level validation as a form problem", () => {
  const invalid = new ApiError(422, "VALIDATION_FAILED", "Enter the connection string.", "r3", { field: "uri" })
  assert.deepEqual(describeConnectionError(invalid), { title: "Check the form", message: "Enter the connection string." })
})
