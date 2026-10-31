import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import test, { after, before } from "node:test"

import { Decimal128, Int32, Long, MongoClient, ObjectId, type Db } from "mongodb"
import type { Pool } from "pg"

import { loadEnv } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import { QueryRunner } from "../../src/queries/runner.js"
import type { ExecutionRecord } from "../../src/queries/schemas.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"
import { captureConsole } from "./support/console.js"
import { signIn, TestClient, type TestResponse } from "./support/http.js"
import { waitFor } from "./support/manifests.js"
import { startApp, type RunningApp } from "./support/server.js"
import { resetStorage } from "./support/storage.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_MONGO_URL = process.env.TEST_MONGO_URL
const skip = !TEST_DATABASE_URL || !TEST_MONGO_URL
const SESSION_SECRET = "integration-test-secret-at-least-32-chars"

// Synthetic databases on the throwaway test server; both are dropped afterwards.
const STORE = "manifest_it_queries"
const OTHER = "manifest_it_queries_other"

interface Ok<T> {
  result: T
}
interface Failure {
  error: { code: string; message: string; details?: { executionId?: string; reason?: string; name?: string } }
}
type Answer = TestResponse<Ok<ExecutionRecord> & Failure>

let mongo: MongoClient
let store: Db
let storage: Pool
let sources: SourceAdapters
let refreshes: RefreshRunner
let queries: QueryRunner
let running: RunningApp
let consoleCapture: ReturnType<typeof captureConsole>
let owner: TestClient
let member: TestClient
let outsider: TestClient
let acme: Workspace
let connection: Connection

const ORDER_IDS = [
  "64b7f0c2a1b2c3d4e5f60701",
  "64b7f0c2a1b2c3d4e5f60702",
  "64b7f0c2a1b2c3d4e5f60703",
  "64b7f0c2a1b2c3d4e5f60704",
]

/** Spins through 200 million values, so it runs for seconds unless it is stopped. */
const HEAVY_PIPELINE = [
  { $project: { n: { $range: [0, 100_000] } } },
  { $unwind: "$n" },
  { $group: { _id: null, total: { $sum: "$n" } } },
]

const queriesPath = () => `/api/v1/workspaces/${acme.id}/connections/${connection.id}/queries`

function run(
  client: TestClient,
  query: Record<string, unknown>,
  options: { id?: string; maxRows?: number; timeoutMs?: number } = {},
): Promise<Answer> {
  const { id = randomUUID(), ...limits } = options
  return client.call(queriesPath(), {
    method: "POST",
    json: { id, query: { language: "mongodb", database: STORE, ...query }, ...limits },
  })
}

async function succeeded(query: Record<string, unknown>, options: { maxRows?: number } = {}) {
  const res = await run(owner, query, options)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.result.status, "succeeded", JSON.stringify(res.body.result.error))
  const result = res.body.result.result
  assert.ok(result)
  return result
}

/** Operations still running on the server for one execution. */
async function serverOperations(executionId: string): Promise<unknown[]> {
  const { inprog } = await mongo
    .db("admin")
    .command({ currentOp: 1, "command.comment": `manifest-query-${executionId}` })
  return inprog as unknown[]
}

async function seed(): Promise<void> {
  await store.collection("customers").insertMany([
    {
      _id: new Int32(1),
      name: "Ava",
      points: Long.fromString("9223372036854775807"),
      balance: Decimal128.fromString("12345678901234567890.12"),
      email: "ava@example.com",
      signed_up_at: new Date("2026-01-05T10:00:00.000Z"),
    },
    { _id: new Int32(2), name: "Kai", points: Long.fromString("5"), email: null, signed_up_at: new Date("2026-02-01T00:00:00Z") },
    { _id: new Int32(3), name: "Mila", points: Long.fromString("7"), signed_up_at: new Date("2026-03-01T00:00:00Z") },
    { _id: new Int32(4), name: "Noah", points: Long.fromString("9"), email: "noah@example.com", signed_up_at: new Date("2026-04-01T00:00:00Z") },
    { _id: new Int32(5), name: "Zara", points: Long.fromString("11"), email: "zara@example.com", signed_up_at: new Date("2026-05-01T00:00:00Z") },
  ])
  await store.collection("orders").insertMany(
    ORDER_IDS.map((id, index) => ({
      _id: new ObjectId(id),
      customer_id: new Int32(index < 3 ? 1 : 2),
      total: Decimal128.fromString(["10.10", "20.20", "0.01", "99.99"][index] ?? "0"),
      placed_at: new Date(Date.UTC(2026, 9, 1 + index)),
      items: [{ sku: `SKU-${index}`, qty: new Int32(index + 1) }],
    })),
  )
  await store.collection("ticks").insertMany(Array.from({ length: 2_000 }, (_, index) => ({ i: index })))
  await mongo.db(OTHER).collection("invoices").insertOne({ order_id: 1, secret: true })
}

async function dropFixtures(): Promise<void> {
  for (const name of [STORE, OTHER]) await mongo.db(name).dropDatabase()
}

before(async () => {
  if (skip) return
  mongo = new MongoClient(TEST_MONGO_URL as string, { serverSelectionTimeoutMS: 5_000 })
  store = mongo.db(STORE)
  await dropFixtures()
  await seed()

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
  running = await startApp(createApp(env, { pool: storage, sources, refreshes, queries }))

  owner = (await signIn(running.baseUrl, "owner@example.com", "Owner")).client
  const created = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
  })
  acme = created.body.result
  const memberSession = await signIn(running.baseUrl, "member@example.com", "Member")
  member = memberSession.client
  await new WorkspacesRepository(storage).addMember(acme.id, memberSession.context.user.id, "member")
  outsider = (await signIn(running.baseUrl, "outsider@example.com", "Outsider")).client

  const url = new URL((TEST_MONGO_URL as string).replace(/^mongodb:/, "http:"))
  const saved = await owner.call<Ok<Connection>>(`/api/v1/workspaces/${acme.id}/connections`, {
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
  await running.close()
  await queries.shutdown()
  await refreshes.shutdown()
  await closeSourceAdapters(sources)
  await storage.end()
  await dropFixtures()
  await mongo.close()
})

test("find returns bounded rows with exact numbers, ids, dates, and null told apart from missing", { skip }, async () => {
  const result = await succeeded(
    {
      collection: "customers",
      operation: "find",
      filter: { signed_up_at: { $gte: { $date: "2026-01-01T00:00:00Z" } } },
      sort: { _id: 1 },
    },
    { maxRows: 3 },
  )
  assert.deepEqual(result.columns, [
    { name: "_id", type: "int", kind: "integer" },
    { name: "name", type: "string", kind: "text" },
    { name: "points", type: "long", kind: "integer" },
    { name: "balance", type: "decimal", kind: "decimal" },
    { name: "email", type: "string", kind: "text" },
    { name: "signed_up_at", type: "date", kind: "datetime" },
  ])
  const missing = { $missing: true }
  assert.deepEqual(result.rows, [
    [1, "Ava", "9223372036854775807", "12345678901234567890.12", "ava@example.com", "2026-01-05T10:00:00.000Z"],
    [2, "Kai", "5", missing, null, "2026-02-01T00:00:00.000Z"],
    [3, "Mila", "7", missing, missing, "2026-03-01T00:00:00.000Z"],
  ])
  assert.equal(result.rowCount, 3)
  assert.equal(result.truncated, true)
  assert.equal(result.truncatedBy, "rows")

  const projected = await succeeded({
    collection: "orders",
    operation: "find",
    filter: { _id: { $oid: ORDER_IDS[1] } },
    projection: { _id: 1, items: 1 },
  })
  assert.deepEqual(projected.rows, [[ORDER_IDS[1], '[{"sku":"SKU-1","qty":2}]']])
  assert.deepEqual(projected.columns.map((column) => column.kind), ["id", "json"])
  assert.equal(projected.truncated, false)
})

test("aggregate joins with $lookup and sums Decimal128 exactly", { skip }, async () => {
  const result = await succeeded({
    collection: "orders",
    operation: "aggregate",
    pipeline: [
      { $lookup: { from: "customers", localField: "customer_id", foreignField: "_id", as: "customer" } },
      { $unwind: "$customer" },
      { $group: { _id: "$customer.name", orders: { $sum: 1 }, revenue: { $sum: "$total" } } },
      { $sort: { _id: 1 } },
    ],
  })
  assert.deepEqual(result.rows, [
    ["Ava", 3, "30.31"],
    ["Kai", 1, "99.99"],
  ])
  assert.deepEqual(result.columns.map((column) => column.type), ["string", "int", "decimal"])
})

test("disallowed MongoDB operations are rejected with 422 and recorded", { skip }, async () => {
  const cases: [Record<string, unknown>, string, string | null][] = [
    [{ collection: "orders", operation: "aggregate", pipeline: [{ $out: "copy" }] }, "stage_not_allowed", "$out"],
    [{ collection: "orders", operation: "aggregate", pipeline: [{ $facet: { a: [{ $merge: "copy" }] } }] }, "stage_not_allowed", "$merge"],
    [{ collection: "orders", operation: "find", filter: { $or: [{ total: 1 }, { $where: "true" }] } }, "operator_not_allowed", "$where"],
    [
      { collection: "orders", operation: "find", filter: { $expr: { $function: { body: "function () { return true }", args: [], lang: "js" } } } },
      "operator_not_allowed",
      "$function",
    ],
    [
      { collection: "orders", operation: "aggregate", pipeline: [{ $lookup: { from: { db: OTHER, coll: "invoices" }, localField: "_id", foreignField: "order_id", as: "i" } }] },
      "cross_database",
      `${OTHER}.invoices`,
    ],
    [{ collection: "orders", operation: "aggregate", pipeline: [{ $unionWith: { db: OTHER, coll: "invoices" } }] }, "cross_database", `${OTHER}.invoices`],
    [{ database: OTHER, collection: "invoices", operation: "find" }, "database_not_allowed", OTHER],
    [{ collection: "system.views", operation: "find" }, "collection_not_allowed", "system.views"],
    [{ collection: "orders", operation: "aggregate", pipeline: [{ $collStats: {} }] }, "stage_not_allowed", "$collStats"],
  ]
  for (const [query, reason, name] of cases) {
    const res = await run(owner, query)
    assert.equal(res.status, 422, `${JSON.stringify(query)}: ${res.text}`)
    assert.equal(res.body.error.code, "QUERY_REJECTED")
    assert.equal(res.body.error.details?.reason, reason)
    assert.equal(res.body.error.details?.name ?? null, name)
    const recorded = await owner.call<Ok<ExecutionRecord>>(`${queriesPath()}/${res.body.error.details?.executionId}`)
    assert.equal(recorded.body.result.status, "rejected")
  }
  const sql = await owner.call<Failure>(queriesPath(), {
    method: "POST",
    json: { id: randomUUID(), query: { language: "sql", sql: "SELECT 1" } },
  })
  assert.equal(sql.body.error.details?.reason, "language_not_supported")
  const collections = (await store.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name)
  assert.ok(!collections.includes("copy"), "nothing was written")
})

test("a heavy aggregation past its time limit is timed out and killed on the server", { skip }, async () => {
  const id = randomUUID()
  const started = performance.now()
  const res = await run(owner, { collection: "ticks", operation: "aggregate", pipeline: HEAVY_PIPELINE }, {
    id,
    timeoutMs: 1_000,
  })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.result.status, "timed_out")
  assert.equal(res.body.result.error?.code, "QUERY_TIMEOUT")
  assert.ok(performance.now() - started < 3_500, "stopped near the limit")
  await waitFor(() => serverOperations(id), (operations) => operations.length === 0, "no server operation")
})

test("cancelling a running aggregation kills it on the server", { skip }, async () => {
  const id = randomUUID()
  const started = performance.now()
  const pending = run(owner, { collection: "ticks", operation: "aggregate", pipeline: HEAVY_PIPELINE }, { id })
  await waitFor(() => serverOperations(id), (operations) => operations.length > 0, "the aggregation to start")
  const cancelled = await owner.call<Ok<ExecutionRecord>>(`${queriesPath()}/${id}/cancel`, { method: "POST" })
  assert.equal(cancelled.status, 200, cancelled.text)
  assert.equal(cancelled.body.result.status, "cancelled")
  assert.equal((await pending).body.result.status, "cancelled")
  await waitFor(() => serverOperations(id), (operations) => operations.length === 0, "no server operation")
  assert.ok(performance.now() - started < 5_000, "stopped well before the aggregation would finish")
})

test("members read MongoDB executions but cannot run them; others get 404", { skip }, async () => {
  const res = await run(owner, { collection: "customers", operation: "find", filter: { _id: 1 } })
  assert.equal(res.status, 200, res.text)
  const id = res.body.result.id
  assert.equal((await run(member, { collection: "customers", operation: "find" })).status, 403)
  const read = await member.call<Ok<ExecutionRecord>>(`${queriesPath()}/${id}`)
  assert.equal(read.status, 200, read.text)
  assert.equal(read.body.result.result?.rows[0]?.[1], "Ava")
  assert.equal((await outsider.call(`${queriesPath()}/${id}`)).status, 404)
})

test("no response or log line carries a connection secret", { skip }, () => {
  for (const text of [...owner.responses, ...member.responses, ...outsider.responses, ...consoleCapture.lines]) {
    assert.ok(!/sealed_?secret/i.test(text), "the sealed secret leaked")
  }
})
