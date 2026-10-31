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
  parsePort,
  sameConnectionSettings,
  schemaOptions,
  toCreateInput,
  toTestInput,
  toUpdateInput,
  type ConnectionDraft,
} from "../src/features/manage-connections/connection-form.ts"
import { ApiError } from "../src/shared/api/client.ts"

const saved: Connection = {
  id: "c1",
  workspaceId: "w1",
  name: "Demo store",
  engine: "postgres",
  config: { host: "db.example.com", port: 5432, database: "shop", username: "reader", sslMode: "require" },
  hasPassword: true,
  schemas: ["support", "shop"],
  status: "connected",
  lastTestedAt: "2026-10-30T10:00:00.000Z",
  lastError: null,
  createdAt: "2026-10-30T10:00:00.000Z",
  updatedAt: "2026-10-30T10:00:00.000Z",
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
  assert.equal(toTestInput(filled(), "c1")?.connectionId, "c1")

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
  assert.equal(moved?.config?.database, "shop_v2")
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
