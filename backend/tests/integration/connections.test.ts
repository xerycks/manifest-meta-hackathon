import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import test, { after, before } from "node:test"

import type { Pool } from "pg"

import { loadEnv } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters, SourceTestResult } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import type { PostgresConfig } from "../../src/connections/schemas.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { buildDemoSource } from "../../src/storage/demo-source-builder.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"
import { captureConsole } from "./support/console.js"
import { signIn, TestClient } from "./support/http.js"
import { startApp, type RunningApp } from "./support/server.js"
import { sourceSettings } from "./support/source.js"
import { resetStorage } from "./support/storage.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_SOURCE_DATABASE_URL = process.env.TEST_SOURCE_DATABASE_URL
const skip = !TEST_DATABASE_URL || !TEST_SOURCE_DATABASE_URL
const SESSION_SECRET = "integration-test-secret-at-least-32-chars"
const KEY = randomBytes(32).toString("hex")

interface Ok<T> {
  result: T
}
interface Failure {
  error: { code: string; message: string; details?: { reason?: string } }
}

let storage: Pool
let sourcePool: Pool
let sources: SourceAdapters
let refreshes: RefreshRunner
let running: RunningApp
let consoleCapture: ReturnType<typeof captureConsole>
let owner: TestClient
let member: TestClient
let outsider: TestClient
let acme: Workspace
let globex: Workspace
let source: { config: PostgresConfig; password: string }

const collection = (workspace: Workspace) => `/api/v1/workspaces/${workspace.id}/connections`

function env(withKey: boolean) {
  return loadEnv({
    NODE_ENV: "test",
    ALLOW_DEV_LOGIN: "true",
    SESSION_SECRET,
    ...(withKey ? { CONNECTION_ENCRYPTION_KEY: KEY } : {}),
  })
}

async function createWorkspace(client: TestClient, name: string, slug: string): Promise<Workspace> {
  const res = await client.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name, slug },
  })
  assert.equal(res.status, 201, res.text)
  return res.body.result
}

async function storedRow(id: string): Promise<{ sealed_secret: string | null; config: unknown }> {
  const { rows } = await storage.query<{ sealed_secret: string | null; config: unknown }>(
    "SELECT sealed_secret, config FROM connections WHERE id = $1",
    [id],
  )
  assert.ok(rows[0])
  return rows[0]
}

async function createConnection(name: string, schemas = ["shop", "support"]): Promise<Connection> {
  const res = await owner.call<Ok<Connection>>(collection(acme), {
    method: "POST",
    json: { name, engine: "postgres", config: source.config, password: source.password, schemas },
  })
  assert.equal(res.status, 201, res.text)
  return res.body.result
}

before(async () => {
  if (skip) return
  storage = createPool(TEST_DATABASE_URL as string)
  await resetStorage(storage)
  sourcePool = createPool(TEST_SOURCE_DATABASE_URL as string)
  await buildDemoSource(sourcePool)
  source = sourceSettings(TEST_SOURCE_DATABASE_URL as string)

  consoleCapture = captureConsole()
  sources = createSourceAdapters()
  // Saving a source starts metadata discovery in the background (covered by manifests.test.ts).
  refreshes = new RefreshRunner()
  running = await startApp(createApp(env(true), { pool: storage, sources, refreshes }))

  const ownerSession = await signIn(running.baseUrl, "owner@example.com", "Owner")
  owner = ownerSession.client
  acme = await createWorkspace(owner, "Acme", "acme")
  globex = await createWorkspace(owner, "Globex", "globex")

  const memberSession = await signIn(running.baseUrl, "member@example.com", "Member")
  member = memberSession.client
  await new WorkspacesRepository(storage).addMember(acme.id, memberSession.context.user.id, "member")

  outsider = (await signIn(running.baseUrl, "outsider@example.com", "Outsider")).client
})

after(async () => {
  if (skip) return
  consoleCapture.restore()
  await running.close()
  await refreshes.shutdown()
  await closeSourceAdapters(sources)
  await storage.end()
  await sourcePool.end()
})

test("test → create → list → reload → retest → edit → remove", { skip }, async () => {
  const draft = { engine: "postgres", config: source.config, password: source.password }
  const tested = await owner.call<Ok<SourceTestResult>>(`${collection(acme)}/test`, {
    method: "POST",
    json: draft,
  })
  assert.equal(tested.status, 200, tested.text)
  assert.ok(tested.body.result.schemas.includes("shop"))
  assert.ok(tested.body.result.schemas.includes("support"))
  assert.ok(
    tested.body.result.schemas.every((name) => !name.startsWith("pg_") && name !== "information_schema"),
  )
  assert.match(tested.body.result.serverVersion, /^\d+/)
  assert.equal(typeof tested.body.result.latencyMs, "number")

  const created = await owner.call<Ok<Connection>>(collection(acme), {
    method: "POST",
    json: { ...draft, name: "Demo store (synthetic)", schemas: ["support", "shop"] },
  })
  assert.equal(created.status, 201, created.text)
  const connection = created.body.result
  assert.equal(connection.hasPassword, true)
  assert.equal(connection.status, "connected")
  assert.ok(connection.lastTestedAt)
  assert.deepEqual(connection.schemas, ["shop", "support"])
  assert.deepEqual(connection.config, source.config)
  assert.ok(!("password" in connection) && !("sealedSecret" in connection))

  // At rest the password is only present inside the sealed envelope.
  const stored = await storedRow(connection.id)
  assert.match(stored.sealed_secret ?? "", /^v1\./)
  assert.ok(!stored.sealed_secret?.includes(source.password))
  assert.ok(!JSON.stringify(stored.config).includes(source.password))

  const duplicate = await owner.call<Failure>(collection(acme), {
    method: "POST",
    json: { ...draft, name: "DEMO STORE (synthetic)", schemas: ["shop"] },
  })
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.body.error.code, "CONFLICT")

  const listed = await owner.call<Ok<Connection[]>>(collection(acme))
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.result, [connection])

  // A restarted backend (fresh storage pool, fresh source pools) still has it and can decrypt it.
  const freshStorage = createPool(TEST_DATABASE_URL as string)
  const freshSources = createSourceAdapters()
  const restarted = await startApp(createApp(env(true), { pool: freshStorage, sources: freshSources }))
  try {
    const again = owner.at(restarted.baseUrl)
    const reloaded = await again.call<Ok<Connection>>(`${collection(acme)}/${connection.id}`)
    assert.equal(reloaded.status, 200, reloaded.text)
    assert.deepEqual(reloaded.body.result, connection)
    const live = await again.call<Ok<string[]>>(`${collection(acme)}/${connection.id}/schemas`)
    assert.equal(live.status, 200, live.text)
    assert.ok(live.body.result.includes("shop"))
  } finally {
    await restarted.close()
    await closeSourceAdapters(freshSources)
    await freshStorage.end()
  }

  const retested = await owner.call<Ok<{ connection: Connection; test: SourceTestResult }>>(
    `${collection(acme)}/${connection.id}/test`,
    { method: "POST" },
  )
  assert.equal(retested.status, 200, retested.text)
  assert.equal(retested.body.result.connection.status, "connected")
  assert.ok(retested.body.result.test.schemas.includes("support"))

  // Editing without a password keeps the saved one.
  const renamed = await owner.call<Ok<Connection>>(`${collection(acme)}/${connection.id}`, {
    method: "PATCH",
    json: { name: "Shop analytics", schemas: ["shop"] },
  })
  assert.equal(renamed.status, 200, renamed.text)
  assert.equal(renamed.body.result.name, "Shop analytics")
  assert.deepEqual(renamed.body.result.schemas, ["shop"])
  assert.equal(renamed.body.result.hasPassword, true)

  // A replacement password is tested, sealed again, and never echoed back.
  const repassworded = await owner.call<Ok<Connection>>(`${collection(acme)}/${connection.id}`, {
    method: "PATCH",
    json: { password: source.password },
  })
  assert.equal(repassworded.status, 200, repassworded.text)
  assert.equal(repassworded.body.result.hasPassword, true)
  const resealed = await storedRow(connection.id)
  assert.match(resealed.sealed_secret ?? "", /^v1\./)
  assert.notEqual(resealed.sealed_secret, stored.sealed_secret)

  // The saved password is reused for the same server but never sent to a different one.
  const sameServer = await owner.call<Ok<SourceTestResult>>(`${collection(acme)}/test`, {
    method: "POST",
    json: { engine: "postgres", config: source.config, connectionId: connection.id },
  })
  assert.equal(sameServer.status, 200, sameServer.text)
  const otherPort = { ...source.config, port: source.config.port + 1 }
  for (const attempt of [
    owner.call<Failure>(`${collection(acme)}/test`, {
      method: "POST",
      json: { engine: "postgres", config: otherPort, connectionId: connection.id },
    }),
    owner.call<Failure>(`${collection(acme)}/${connection.id}`, {
      method: "PATCH",
      json: { config: otherPort },
    }),
  ]) {
    const refused = await attempt
    assert.equal(refused.status, 422)
    assert.equal(refused.body.error.code, "VALIDATION_FAILED")
    assert.match(refused.body.error.message, /Re-enter the password/)
  }

  const missingSchema = await owner.call<Failure>(`${collection(acme)}/${connection.id}`, {
    method: "PATCH",
    json: { schemas: ["shop", "no_such_schema"] },
  })
  assert.equal(missingSchema.status, 422)
  assert.match(missingSchema.body.error.message, /no_such_schema/)

  // A retest that fails is recorded on the source with a safe message.
  await storage.query(
    `UPDATE connections SET config = jsonb_set(config, '{database}', '"manifest_missing_db"') WHERE id = $1`,
    [connection.id],
  )
  const failedRetest = await owner.call<Failure>(`${collection(acme)}/${connection.id}/test`, {
    method: "POST",
  })
  assert.equal(failedRetest.status, 422)
  assert.equal(failedRetest.body.error.code, "SOURCE_CONNECTION_FAILED")
  assert.equal(failedRetest.body.error.details?.reason, "database_not_found")
  const afterFailure = await owner.call<Ok<Connection>>(`${collection(acme)}/${connection.id}`)
  assert.equal(afterFailure.body.result.status, "failed")
  assert.equal(afterFailure.body.result.lastError, failedRetest.body.error.message)

  const removed = await owner.call<Ok<{ deleted: boolean }>>(`${collection(acme)}/${connection.id}`, {
    method: "DELETE",
  })
  assert.equal(removed.status, 200)
  assert.equal(removed.body.result.deleted, true)
  assert.equal((await owner.call(`${collection(acme)}/${connection.id}`)).status, 404)
  assert.equal(
    (await owner.call(`${collection(acme)}/${connection.id}`, { method: "DELETE" })).status,
    404,
  )
  assert.deepEqual((await owner.call<Ok<Connection[]>>(collection(acme))).body.result, [])
})

test("invalid settings return mapped, useful errors and nothing is saved", { skip }, async () => {
  const cases: [Partial<PostgresConfig>, string, RegExp][] = [
    [{ username: "manifest_missing_role" }, "auth_failed", /rejected the username or password/],
    [{ database: "manifest_missing_db" }, "database_not_found", /no database with that name/],
    [{ host: "127.0.0.1", port: 1 }, "host_unreachable", /Could not reach PostgreSQL/],
  ]
  for (const [override, reason, message] of cases) {
    const res = await owner.call<Failure>(`${collection(acme)}/test`, {
      method: "POST",
      json: { engine: "postgres", config: { ...source.config, ...override }, password: source.password },
    })
    assert.equal(res.status, 422, res.text)
    assert.equal(res.body.error.code, "SOURCE_CONNECTION_FAILED")
    assert.equal(res.body.error.details?.reason, reason)
    assert.match(res.body.error.message, message)
  }

  const badCredentials = await owner.call<Failure>(collection(acme), {
    method: "POST",
    json: {
      name: "Broken",
      engine: "postgres",
      config: { ...source.config, username: "manifest_missing_role" },
      password: source.password,
      schemas: ["shop"],
    },
  })
  assert.equal(badCredentials.status, 422)
  assert.equal(badCredentials.body.error.details?.reason, "auth_failed")

  const systemSchema = await owner.call<Failure>(collection(acme), {
    method: "POST",
    json: { name: "Catalog", engine: "postgres", config: source.config, schemas: ["pg_catalog"] },
  })
  assert.equal(systemSchema.status, 422)
  assert.equal(systemSchema.body.error.code, "VALIDATION_FAILED")

  const listed = await owner.call<Ok<Connection[]>>(collection(acme))
  assert.deepEqual(listed.body.result, [])
})

test("members can read but not manage; other workspaces and non-members see 404", { skip }, async () => {
  const connection = await createConnection("Shared source")
  const item = `${collection(acme)}/${connection.id}`

  const memberList = await member.call<Ok<Connection[]>>(collection(acme))
  assert.equal(memberList.status, 200)
  assert.deepEqual(
    memberList.body.result.map((entry) => entry.id),
    [connection.id],
  )
  assert.equal((await member.call(item)).status, 200)

  const attempts: [string, string, unknown?][] = [
    ["POST", collection(acme), { name: "Mine", engine: "postgres", config: source.config, schemas: ["shop"] }],
    ["POST", `${collection(acme)}/test`, { engine: "postgres", config: source.config }],
    ["PATCH", item, { name: "Renamed by member" }],
    ["POST", `${item}/test`],
    ["GET", `${item}/schemas`],
    ["DELETE", item],
  ]
  for (const [method, path, json] of attempts) {
    const res = await member.call<Failure>(path, { method, ...(json ? { json } : {}) })
    assert.equal(res.status, 403, `${method} ${path}`)
    assert.equal(res.body.error.code, "FORBIDDEN")
  }

  const noCsrf = await owner.call<Failure>(item, { method: "DELETE", csrf: false })
  assert.equal(noCsrf.status, 403)
  assert.equal(noCsrf.body.error.code, "CSRF_REQUIRED")

  for (const [method, path] of [
    ["GET", collection(acme)],
    ["GET", item],
    ["DELETE", item],
  ] as const) {
    const res = await outsider.call(path, { method })
    assert.equal(res.status, 404, `${method} ${path}`)
  }

  // The same id under another workspace the owner belongs to is not found.
  assert.equal((await owner.call(`${collection(globex)}/${connection.id}`)).status, 404)
  assert.equal(
    (await owner.call(`${collection(globex)}/${connection.id}`, { method: "DELETE" })).status,
    404,
  )
  assert.equal((await owner.call(item)).status, 200)

  const anonymous = new TestClient(running.baseUrl)
  assert.equal((await anonymous.call(collection(acme))).status, 401)
})

test("without CONNECTION_ENCRYPTION_KEY connection routes answer 503; other features work", { skip }, async () => {
  const keyless = await startApp(createApp(env(false), { pool: storage }))
  try {
    const client = owner.at(keyless.baseUrl)
    for (const options of [{}, { method: "POST", json: {} }]) {
      const res = await client.call<Failure>(collection(acme), options)
      assert.equal(res.status, 503)
      assert.equal(res.body.error.code, "CONNECTIONS_NOT_CONFIGURED")
      assert.match(res.body.error.message, /CONNECTION_ENCRYPTION_KEY/)
    }
    assert.equal((await client.call("/api/v1/workspaces")).status, 200)
    assert.equal((await outsider.at(keyless.baseUrl).call(collection(acme))).status, 404)
  } finally {
    await keyless.close()
  }
})

test("saved passwords never appear in any response body or console output", { skip }, () => {
  const responses = [...owner.responses, ...member.responses, ...outsider.responses]
  assert.ok(responses.length > 30)
  for (const text of responses) {
    assert.ok(!text.includes(source.password), "a response included the password")
    assert.ok(!/sealed_?secret/i.test(text), "a response included the sealed secret")
  }
  for (const line of consoleCapture.lines) {
    assert.ok(!line.includes(source.password), "console output included the password")
  }
})
