import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import test, { after, before } from "node:test"

import { Decimal128, MongoClient, ObjectId } from "mongodb"
import type { Pool } from "pg"

import { loadEnv } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import { QueryRunner } from "../../src/queries/runner.js"
import type { SavedQueryDetail, SavedQueryRun } from "../../src/saved-queries/schemas.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import type { Workspace } from "../../src/workspaces/repository.js"
import { captureConsole } from "./support/console.js"
import { signIn, type TestClient } from "./support/http.js"
import { startApp, type RunningApp } from "./support/server.js"
import { resetStorage } from "./support/storage.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_MONGO_URL = process.env.TEST_MONGO_URL
const skip = !TEST_DATABASE_URL || !TEST_MONGO_URL
const SESSION_SECRET = "integration-test-secret-at-least-32-chars"
// A synthetic database on the throwaway test server, dropped afterwards.
const STORE = "manifest_it_saved_queries"

interface Ok<T> {
  result: T
}

let mongo: MongoClient
let storage: Pool
let sources: SourceAdapters
let refreshes: RefreshRunner
let queries: QueryRunner
let app: RunningApp
let consoleCapture: ReturnType<typeof captureConsole>
let owner: TestClient
let acme: Workspace
let connection: Connection

/** Orders placed at 18:00 UTC on 1-6 October 2026: 23:30 the same day in India. */
const PLACED = [1, 2, 3, 4, 5, 6].map((day) => new Date(Date.UTC(2026, 9, day, 18, 0, 0)))

const base = () => `/api/v1/workspaces/${acme.id}`

before(async () => {
  if (skip) return
  mongo = new MongoClient(TEST_MONGO_URL as string, { serverSelectionTimeoutMS: 5_000 })
  await mongo.db(STORE).dropDatabase()
  await mongo
    .db(STORE)
    .collection("orders")
    .insertMany(
      PLACED.map((placed_at, index) => ({
        _id: new ObjectId(),
        number: index + 1,
        placed_at,
        total: Decimal128.fromString(`${index + 1}0.05`),
        // Some orders have no coupon field at all, one holds null.
        ...(index % 2 === 0 ? { coupon: index === 0 ? null : `SAVE${index}` } : {}),
      })),
    )

  storage = createPool(TEST_DATABASE_URL as string)
  await resetStorage(storage)
  consoleCapture = captureConsole()
  sources = createSourceAdapters()
  refreshes = new RefreshRunner()
  queries = new QueryRunner()
  const env = loadEnv({
    NODE_ENV: "test",
    ALLOW_DEV_LOGIN: "true",
    SESSION_SECRET,
    CONNECTION_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  })
  app = await startApp(createApp(env, { pool: storage, sources, refreshes, queries }))
  owner = (await signIn(app.baseUrl, "owner@example.com", "Owner")).client
  acme = (
    await owner.call<Ok<Workspace>>("/api/v1/workspaces", { method: "POST", json: { name: "Acme", slug: "acme" } })
  ).body.result
  const url = new URL((TEST_MONGO_URL as string).replace(/^mongodb:/, "http:"))
  const saved = await owner.call<Ok<Connection>>(`${base()}/connections`, {
    method: "POST",
    json: {
      name: "Store documents (synthetic)",
      engine: "mongodb",
      config: { mode: "fields", host: url.hostname, port: Number(url.port || 27017), database: STORE, tls: false },
      schemas: [STORE],
    },
  })
  assert.equal(saved.status, 201, saved.text)
  connection = saved.body.result
})

after(async () => {
  if (skip) return
  consoleCapture.restore()
  await app.close()
  await queries.shutdown()
  await refreshes.shutdown()
  await closeSourceAdapters(sources)
  await storage.end()
  await mongo.db(STORE).dropDatabase()
  await mongo.close()
})

test("a MongoDB saved query binds {$param} dates resolved in the workspace time zone", { skip }, async () => {
  const zone = await owner.call(`${base()}/settings/timezone`, { method: "PUT", json: { value: "Asia/Kolkata" } })
  assert.equal(zone.status, 200, zone.text)
  const created = await owner.call<Ok<SavedQueryDetail>>(`${base()}/saved-queries`, {
    method: "POST",
    json: {
      name: "Orders since a day",
      connectionId: connection.id,
      query: {
        language: "mongodb",
        database: STORE,
        collection: "orders",
        operation: "find",
        filter: { placed_at: { $gte: { $param: "since" } } },
        projection: { _id: 0, number: 1, placed_at: 1, total: 1, coupon: 1 },
        sort: { number: 1 },
      },
      parameters: [
        { name: "since", label: "Since", type: "date", default: { kind: "absolute", value: "2026-10-04" } },
      ],
    },
  })
  assert.equal(created.status, 201, created.text)
  const saved = created.body.result
  assert.deepEqual(saved.defaults[0]?.value, "2026-10-04")

  const run = async (parameters?: Record<string, string>) => {
    const res = await owner.call<Ok<SavedQueryRun>>(`${base()}/saved-queries/${saved.id}/run`, {
      method: "POST",
      json: parameters ? { parameters } : {},
    })
    assert.equal(res.status, 200, res.text)
    assert.equal(res.body.result.execution.status, "succeeded", JSON.stringify(res.body.result.execution.error))
    return res.body.result
  }

  // 4 October starts at 18:30 UTC on the 3rd in India, so the order placed then (23:30 local on the 3rd) is out.
  const defaults = await run()
  assert.deepEqual(defaults.execution.result?.rows.map((row) => row[0]), [4, 5, 6])
  const ran = defaults.execution.query
  assert.ok(ran.language === "mongodb" && ran.operation === "find")
  assert.deepEqual(ran.filter, { placed_at: { $gte: { $date: "2026-10-03T18:30:00.000Z" } } })
  assert.deepEqual(defaults.execution.parameters, { since: "2026-10-04" })

  const override = await run({ since: "2026-10-02" })
  assert.deepEqual(override.execution.result?.rows.map((row) => row[0]), [2, 3, 4, 5, 6])
  assert.equal(override.parameters[0]?.from, "run")

  // Exact decimals, NULL, and missing fields come out of the CSV as they are stored.
  const cookie = [...owner.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
  const csv = await fetch(
    `${app.baseUrl}${base()}/connections/${connection.id}/queries/${override.execution.id}/export.csv`,
    { headers: { Cookie: cookie } },
  )
  assert.equal(csv.status, 200)
  const lines = Buffer.from(await csv.arrayBuffer()).subarray(3).toString("utf8").split("\r\n")
  const columns = override.execution.result?.columns.map((column) => column.name) ?? []
  assert.deepEqual(lines[0]?.split(","), columns)
  const at = (name: string) => columns.indexOf(name)
  const byNumber = new Map(lines.slice(1, -1).map((line) => [line.split(",")[at("number")], line.split(",")]))
  assert.equal(byNumber.get("2")?.[at("total")], "20.05")
  assert.equal(byNumber.get("2")?.[at("coupon")], "", "a missing field is empty")
  assert.equal(byNumber.get("3")?.[at("coupon")], "SAVE2")
  assert.equal(byNumber.get("4")?.[at("placed_at")], "2026-10-04T18:00:00.000Z")

  // A malformed placeholder is refused when saving.
  const malformed = await owner.call<{ error: { code: string; details: unknown } }>(`${base()}/saved-queries`, {
    method: "POST",
    json: {
      name: "Malformed",
      connectionId: connection.id,
      query: {
        language: "mongodb",
        database: STORE,
        collection: "orders",
        operation: "aggregate",
        pipeline: [{ $match: { placed_at: { $gte: { $param: "since", $lt: 1 } } } }],
      },
      parameters: [{ name: "since", type: "date" }],
    },
  })
  assert.equal(malformed.status, 422, malformed.text)
  assert.equal(malformed.body.error.code, "INVALID_PARAMETERS")
})
