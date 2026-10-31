import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import test, { after, before } from "node:test"

import { Decimal128, Int32, MongoClient, ObjectId, type Db } from "mongodb"
import type { Pool } from "pg"

import { loadEnv } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters, SourceTestResult } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import type {
  ManifestColumn,
  ManifestObject,
  ManifestObjectDetail,
  ManifestRelationship,
} from "../../src/manifests/schemas.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import type { SearchResults } from "../../src/search/schemas.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { buildDemoMongo } from "../../src/storage/demo-mongo-builder.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"
import { captureConsole } from "./support/console.js"
import { signIn, TestClient } from "./support/http.js"
import { manifestClient, objectIdIn, waitFor } from "./support/manifests.js"
import { startApp, type RunningApp } from "./support/server.js"
import { resetStorage } from "./support/storage.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_MONGO_URL = process.env.TEST_MONGO_URL
const skip = !TEST_DATABASE_URL || !TEST_MONGO_URL
const SESSION_SECRET = "integration-test-secret-at-least-32-chars"
const KEY = randomBytes(32).toString("hex")

// Synthetic databases and a read-only user on the throwaway test server; all are dropped afterwards.
const SHOP = "manifest_it_shop"
const EVENTS = "manifest_it_events"
const DEMO = "manifest_it_demo"
const SLOW = "manifest_it_slow"
const READER = "manifest_it_reader"
const PASSWORD = `manifest-it-${randomBytes(12).toString("hex")}`

interface Ok<T> {
  result: T
}
interface Failure {
  error: { code: string; message: string; details?: { reason?: string; field?: string } }
}

let mongo: MongoClient
let shopDb: Db
let storage: Pool
let sources: SourceAdapters
let refreshes: RefreshRunner
let running: RunningApp
let consoleCapture: ReturnType<typeof captureConsole>
let owner: TestClient
let member: TestClient
let outsider: TestClient
let acme: Workspace
let server: { host: string; port: number }
let shop: Connection

function env() {
  return loadEnv({
    NODE_ENV: "test",
    ALLOW_DEV_LOGIN: "true",
    SESSION_SECRET,
    CONNECTION_ENCRYPTION_KEY: KEY,
  })
}

const connectionsPath = () => `/api/v1/workspaces/${acme.id}/connections`
const manifestPath = (connection = shop) => `${connectionsPath()}/${connection.id}/manifest`
const fields = (database: string, extra: Record<string, unknown> = {}) => ({
  mode: "fields",
  host: server.host,
  port: server.port,
  database,
  tls: false,
  ...extra,
})
const readerUri = (password = PASSWORD) =>
  `mongodb://${READER}:${encodeURIComponent(password)}@${server.host}:${server.port}/${SHOP}?authSource=admin`

function columnOf(detail: ManifestObjectDetail, name: string): ManifestColumn {
  const column = detail.columns.find((entry) => entry.name === name)
  assert.ok(column, `field ${name}`)
  return column
}

async function createSource(json: Record<string, unknown>): Promise<Connection> {
  const res = await owner.call<Ok<Connection>>(connectionsPath(), { method: "POST", json })
  assert.equal(res.status, 201, res.text)
  return res.body.result
}

/** Waits for the refresh a save started, which must succeed. */
async function discovered(connection: Connection) {
  const reads = manifestClient(owner, manifestPath(connection))
  const first = await reads.latestRefresh()
  assert.ok(first, "a refresh started with the source")
  const done = await reads.finished(first.id)
  assert.equal(done.status, "succeeded", done.error ?? "")
  return { ...reads, done }
}

async function seed(): Promise<void> {
  // 20 customers: loyalty_points is an int for 12, text for 4, null for 2, and missing for 2.
  const customers = Array.from({ length: 20 }, (_, index) => {
    const id = index + 1
    const customer: Record<string, unknown> = {
      _id: new Int32(id),
      name: `Customer ${id}`,
      tags: id % 3 === 0 ? [] : ["coffee", ...(id % 2 === 0 ? ["tea"] : [])],
    }
    if (id <= 16) {
      customer.address = { city: "Lisbon", geo: { lat: 38.7, lng: -9.1 } }
    }
    if (id <= 12) customer.loyalty_points = new Int32(id * 10)
    else if (id <= 16) customer.loyalty_points = String(id * 10)
    else if (id <= 18) customer.loyalty_points = null
    if (id <= 5) customer.phone = `+351 900 000 0${id}`
    return customer
  })
  await shopDb.createCollection("customers", {
    validator: {
      $jsonSchema: {
        description: "People with an account (synthetic test data).",
        properties: {
          loyalty_points: { description: "Points balance; older imports stored text." },
          // BSON strings may hold NUL, which PostgreSQL text cannot.
          name: { description: "Display name\u0000 (synthetic)" },
        },
      },
    },
  })
  await shopDb.collection("customers").insertMany(customers)
  await shopDb.collection("orders").insertMany(
    Array.from({ length: 30 }, (_, index) => ({
      _id: new ObjectId(),
      customer_id: new Int32((index % 20) + 1),
      status: index % 7 === 0 ? "refunded" : "paid",
      placed_at: new Date(Date.UTC(2026, 9, 1 + (index % 28))),
      items: [{ sku: `SKU-${index % 5}`, qty: new Int32(1 + (index % 3)), price: Decimal128.fromString("12.50") }],
    })),
  )
  await shopDb.createCollection("big_orders", {
    viewOn: "orders",
    pipeline: [{ $match: { "items.qty": { $gte: 2 } } }],
  })
  // A view that fails when read: its status strings do not convert to numbers.
  await shopDb.createCollection("status_codes", {
    viewOn: "orders",
    pipeline: [{ $project: { code: { $toInt: "$status" } } }],
  })
  await mongo.db(EVENTS).collection("page_views").insertOne({ path: "/", at: new Date() })
  await mongo
    .db("admin")
    .command({ createUser: READER, pwd: PASSWORD, roles: [{ role: "read", db: SHOP }] })
}

async function dropFixtures(): Promise<void> {
  for (const name of [SHOP, EVENTS, DEMO, SLOW]) await mongo.db(name).dropDatabase()
  await mongo.db("admin").command({ dropUser: READER }).catch(() => {})
}

before(async () => {
  if (skip) return
  mongo = new MongoClient(TEST_MONGO_URL as string, { serverSelectionTimeoutMS: 5_000 })
  const url = new URL((TEST_MONGO_URL as string).replace(/^mongodb:/, "http:"))
  server = { host: url.hostname, port: Number(url.port || 27017) }
  shopDb = mongo.db(SHOP)
  await dropFixtures()
  await seed()

  storage = createPool(TEST_DATABASE_URL as string)
  await resetStorage(storage)
  consoleCapture = captureConsole()
  sources = createSourceAdapters()
  refreshes = new RefreshRunner()
  running = await startApp(createApp(env(), { pool: storage, sources, refreshes }))

  const ownerSession = await signIn(running.baseUrl, "owner@example.com", "Owner")
  owner = ownerSession.client
  const created = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
  })
  assert.equal(created.status, 201, created.text)
  acme = created.body.result
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
  await dropFixtures()
  await mongo.close()
})

test("test → save → refresh → browse collections and fields with their type mix", { skip }, async () => {
  const tested = await owner.call<Ok<SourceTestResult>>(`${connectionsPath()}/test`, {
    method: "POST",
    json: { engine: "mongodb", config: fields(SHOP) },
  })
  assert.equal(tested.status, 200, tested.text)
  assert.match(tested.body.result.serverVersion, /^\d+\./)
  assert.equal(tested.body.result.schemaListLimited, false)
  assert.ok(tested.body.result.schemas.includes(SHOP) && tested.body.result.schemas.includes(EVENTS))
  assert.ok(tested.body.result.schemas.every((name) => !["admin", "local", "config"].includes(name)))

  shop = await createSource({
    name: "Shop documents (synthetic)",
    engine: "mongodb",
    config: fields(SHOP),
    schemas: [SHOP],
  })
  assert.equal(shop.engine, "mongodb")
  assert.deepEqual(shop.config, { ...fields(SHOP), username: null, authSource: null })
  assert.equal(shop.hasPassword, false)
  assert.equal(shop.capabilities.queryLanguage, "mongodb")
  assert.deepEqual(shop.capabilities.operations, ["find", "aggregate"])

  const { done, manifest, detail } = await discovered(shop)
  assert.equal(done.counts?.objects, 4)
  assert.equal(done.counts?.relationships, 0)

  const published = await manifest()
  assert.deepEqual(
    published.schemas.map((schema) => [schema.name, schema.objects.map((object) => [object.name, object.kind])]),
    [
      [
        SHOP,
        [["big_orders", "view"], ["customers", "collection"], ["orders", "collection"], ["status_codes", "view"]],
      ],
    ],
  )

  const customers = await detail(objectIdIn(published, SHOP, "customers"))
  assert.equal(customers.object.estimatedRows, 20)
  assert.equal(customers.object.comment, "People with an account (synthetic test data).")
  assert.deepEqual(customers.object.details, {
    engine: "mongodb",
    collectionType: "collection",
    capped: false,
    sampleSize: 20,
    sampleMethod: "random",
    sampleBytesLimited: false,
    fieldsTruncated: false,
    depthTruncated: false,
    sampleFailure: null,
  })
  assert.equal(columnOf(customers, "_id").isPrimaryKey, true)
  assert.equal(columnOf(customers, "address.geo.lat").details?.depth, 2)
  assert.equal(columnOf(customers, "tags").dataType, "array<string>")

  const points = columnOf(customers, "loyalty_points")
  assert.equal(points.dataType, "int | string | null")
  assert.equal(points.comment, "Points balance; older imports stored text.")
  assert.deepEqual(points.details, {
    engine: "mongodb",
    sampleSize: 20,
    types: [
      { type: "int", documents: 12 },
      { type: "string", documents: 4 },
      { type: "null", documents: 2 },
    ],
    missing: 2,
    arrayElementTypes: null,
    depth: 0,
  })
  assert.equal(columnOf(customers, "phone").details?.missing, 15)
  assert.equal(columnOf(customers, "name").comment, "Display name (synthetic)")

  const orders = await detail(objectIdIn(published, SHOP, "orders"))
  assert.equal(columnOf(orders, "items").dataType, "array<object>")
  assert.equal(columnOf(orders, "items.price").dataType, "decimal")
  assert.equal(columnOf(orders, "items.qty").details?.depth, 1)

  const view = await detail(objectIdIn(published, SHOP, "big_orders"))
  assert.equal(view.object.estimatedRows, null)
  assert.match(view.object.viewDefinition ?? "", /"viewOn": "orders"/)
  assert.equal(view.object.details?.collectionType, "view")

  // A collection that cannot be sampled is reported on its own; the refresh still publishes.
  const failing = await detail(objectIdIn(published, SHOP, "status_codes"))
  assert.equal(failing.object.details?.sampleFailure, "MongoDB could not sample this collection.")
  assert.equal(failing.columns.length, 0)
})

test("meaning on a collection, a field, and a manual relationship survives refreshes", { skip }, async () => {
  const { manifest, detail, refreshNow } = manifestClient(owner, manifestPath())
  const published = await manifest()
  const customers = await detail(objectIdIn(published, SHOP, "customers"))
  const orders = await detail(objectIdIn(published, SHOP, "orders"))

  const object = await owner.call<Ok<ManifestObject>>(`${manifestPath()}/objects/${customers.object.id}`, {
    method: "PATCH",
    json: { version: customers.object.version, label: "Customers", rowMeaning: "one document per customer" },
  })
  assert.equal(object.status, 200, object.text)
  const points = columnOf(customers, "loyalty_points")
  const field = await owner.call<Ok<ManifestColumn>>(`${manifestPath()}/columns/${points.id}`, {
    method: "PATCH",
    json: { version: points.version, label: "Loyalty points", unit: "points", valueNotes: "Text in old imports" },
  })
  assert.equal(field.status, 200, field.text)
  // Arrays of documents link through their fields, as $lookup would.
  const relationship = await owner.call<Ok<ManifestRelationship>>(`${manifestPath()}/relationships`, {
    method: "POST",
    json: { fromColumnId: columnOf(orders, "customer_id").id, toColumnId: columnOf(customers, "_id").id },
  })
  assert.equal(relationship.status, 201, relationship.text)
  const mismatched = await owner.call<Failure>(`${manifestPath()}/relationships`, {
    method: "POST",
    json: { fromColumnId: columnOf(orders, "status").id, toColumnId: columnOf(customers, "_id").id },
  })
  assert.equal(mismatched.status, 422)

  // The data changes: a new field appears and phone numbers are removed everywhere.
  await shopDb.collection("customers").updateOne({ _id: new Int32(1) }, { $set: { referral_code: "AVA10" } })
  await shopDb.collection("customers").updateMany({}, { $unset: { phone: "" } })
  const done = await refreshNow()
  assert.equal(done.counts?.columnsAdded, 1)
  assert.equal(done.counts?.columnsRemoved, 1)

  const after = await detail(customers.object.id)
  assert.equal(after.object.label, "Customers")
  assert.equal(after.object.rowMeaning, "one document per customer")
  const refreshedPoints = columnOf(after, "loyalty_points")
  assert.equal(refreshedPoints.id, points.id)
  assert.equal(refreshedPoints.label, "Loyalty points")
  assert.equal(refreshedPoints.unit, "points")
  assert.equal(columnOf(after, "referral_code").details?.missing, 19)
  assert.equal(columnOf(after, "phone").present, false)
  const incoming = after.incoming.find((entry) => entry.id === relationship.body.result.id)
  assert.equal(incoming?.needsReview, false)

  const found = await owner.call<Ok<SearchResults>>(
    `/api/v1/workspaces/${acme.id}/search?q=${encodeURIComponent("Loyalty points")}`,
  )
  assert.equal(found.status, 200, found.text)
  assert.equal(found.body.result.columns[0]?.columnId, points.id)
  assert.equal(found.body.result.objects.length, 0)
})

test("connection strings and passwords are sealed; responses show hosts and database only", { skip }, async () => {
  const uriSource = await createSource({
    name: "Shop via connection string",
    engine: "mongodb",
    config: { mode: "uri" },
    uri: readerUri(),
    schemas: [SHOP],
  })
  assert.deepEqual(uriSource.config, {
    mode: "uri",
    hosts: [`${server.host}:${server.port}`],
    srv: false,
    database: SHOP,
  })
  assert.equal(uriSource.hasPassword, true)
  const { rows } = await storage.query<{ sealed_secret: string; config: unknown }>(
    "SELECT sealed_secret, config FROM connections WHERE id = $1",
    [uriSource.id],
  )
  assert.match(rows[0]?.sealed_secret ?? "", /^v1\./)
  assert.ok(!JSON.stringify(rows).includes(PASSWORD) && !JSON.stringify(rows).includes(READER))
  await discovered(uriSource)

  // Edits without a new connection string keep the saved one.
  const item = `${connectionsPath()}/${uriSource.id}`
  const renamed = await owner.call<Ok<Connection>>(item, {
    method: "PATCH",
    json: { name: "Shop (read-only user)", schemas: [SHOP] },
  })
  assert.equal(renamed.status, 200, renamed.text)
  const retested = await owner.call<Ok<{ test: SourceTestResult }>>(`${item}/test`, { method: "POST" })
  assert.equal(retested.status, 200, retested.text)
  const reused = await owner.call<Ok<SourceTestResult>>(`${connectionsPath()}/test`, {
    method: "POST",
    json: { engine: "mongodb", config: { mode: "uri" }, connectionId: uriSource.id },
  })
  assert.equal(reused.status, 200, reused.text)

  // A new connection string may reach another server, so saving it refreshes the metadata.
  const reads = manifestClient(owner, manifestPath(uriSource))
  const previous = await reads.latestRefresh()
  const repointed = await owner.call<Ok<Connection>>(item, {
    method: "PATCH",
    json: { uri: `${readerUri()}&appName=manifest-it` },
  })
  assert.equal(repointed.status, 200, repointed.text)
  assert.deepEqual(repointed.body.result.config, uriSource.config)
  const changed = await reads.latestRefresh()
  assert.ok(changed && changed.id !== previous?.id, "a refresh started")
  assert.equal(changed.trigger, "source_changed")
  assert.equal((await reads.finished(changed.id)).status, "succeeded")

  const withPassword = await createSource({
    name: "Shop with a password",
    engine: "mongodb",
    config: fields(SHOP, { username: READER, authSource: "admin" }),
    password: PASSWORD,
    schemas: [SHOP],
  })
  assert.equal(withPassword.hasPassword, true)
  // The saved password is not sent to another server.
  const moved = await owner.call<Failure>(`${connectionsPath()}/${withPassword.id}`, {
    method: "PATCH",
    json: { config: fields(SHOP, { username: READER, authSource: "admin", port: server.port + 1 }) },
  })
  assert.equal(moved.status, 422)
  assert.match(moved.body.error.message, /Re-enter the password/)

  const refused = await owner.call<Failure>(`${connectionsPath()}/test`, {
    method: "POST",
    json: { engine: "mongodb", config: { mode: "uri" }, uri: `${readerUri()}&tlsCAFile=/etc/hosts` },
  })
  assert.equal(refused.status, 422)
  assert.equal(refused.body.error.details?.field, "uri")
})

test("bad credentials and unreachable servers return mapped errors; nothing is saved", { skip }, async () => {
  const before = (await owner.call<Ok<Connection[]>>(connectionsPath())).body.result.length
  const cases: [Record<string, unknown>, string, RegExp][] = [
    [{ config: { mode: "uri" }, uri: readerUri("wrong-password") }, "auth_failed", /rejected the username or password/],
    [{ config: fields(SHOP, { username: "manifest_it_nobody" }), password: PASSWORD }, "auth_failed", /rejected/],
    [{ config: fields(SHOP, { host: "127.0.0.1", port: 1 }) }, "host_unreachable", /Could not reach MongoDB/],
  ]
  for (const [json, reason, message] of cases) {
    const res = await owner.call<Failure>(`${connectionsPath()}/test`, {
      method: "POST",
      json: { engine: "mongodb", ...json },
    })
    assert.equal(res.status, 422, res.text)
    assert.equal(res.body.error.code, "SOURCE_CONNECTION_FAILED")
    assert.equal(res.body.error.details?.reason, reason)
    assert.match(res.body.error.message, message)
  }
  const failedSave = await owner.call<Failure>(connectionsPath(), {
    method: "POST",
    json: { name: "Broken", engine: "mongodb", config: { mode: "uri" }, uri: readerUri("nope"), schemas: [SHOP] },
  })
  assert.equal(failedSave.body.error.details?.reason, "auth_failed")
  assert.equal((await owner.call<Ok<Connection[]>>(connectionsPath())).body.result.length, before)
})

test("members browse MongoDB manifests but cannot connect, refresh, or edit; others get 404", { skip }, async () => {
  const published = await manifestClient(member, manifestPath()).manifest()
  const customersId = objectIdIn(published, SHOP, "customers")
  assert.equal((await member.call(`${manifestPath()}/objects/${customersId}`)).status, 200)

  const attempts: [string, string, unknown?][] = [
    ["POST", `${connectionsPath()}/test`, { engine: "mongodb", config: fields(SHOP) }],
    ["POST", connectionsPath(), { name: "Mine", engine: "mongodb", config: fields(SHOP), schemas: [SHOP] }],
    ["POST", `${manifestPath()}/refresh`],
    ["PATCH", `${manifestPath()}/objects/${customersId}`, { version: 1, label: "x" }],
  ]
  for (const [method, path, json] of attempts) {
    const res = await member.call(path, { method, ...(json ? { json } : {}) })
    assert.equal(res.status, 403, `${method} ${path}`)
  }
  assert.equal((await outsider.call(manifestPath())).status, 404)
  assert.equal((await outsider.call(`${connectionsPath()}/${shop.id}`)).status, 404)
})

test("the synthetic MongoDB demo database builds and refreshes", { skip }, async () => {
  const summary = await buildDemoMongo(mongo.db(DEMO))
  assert.equal(summary.sessions, 2_500)
  assert.equal(summary.productReviews, 1_200)
  const demo = await createSource({
    name: "Demo web analytics (synthetic)",
    engine: "mongodb",
    config: fields(DEMO),
    schemas: [DEMO],
  })
  const { done, manifest, detail } = await discovered(demo)
  assert.equal(done.counts?.objects, 4)
  const published = await manifest()
  const reviews = await detail(objectIdIn(published, DEMO, "product_reviews"))
  assert.equal(reviews.object.details?.sampleSize, 200)
  assert.match(columnOf(reviews, "rating").dataType, /^int \| string$/)
  assert.ok((columnOf(reviews, "helpful_votes").details?.missing ?? 0) > 0)
  const events = await detail(objectIdIn(published, DEMO, "web_events"))
  assert.equal(columnOf(events, "cart.items.unit_price").dataType, "decimal")
})

test("aborting a discovery kills the sample still running on the server", { skip }, async () => {
  // A view whose pipeline spins for 3 s per document, so its sample is still running when we abort.
  const slow = mongo.db(SLOW)
  await slow.collection("ticks").insertOne({ at: new Date() })
  await slow.createCollection("slow_view", {
    viewOn: "ticks",
    pipeline: [
      {
        $match: {
          $expr: {
            $function: {
              body: "function () { const end = Date.now() + 3000; while (Date.now() < end) {} return true }",
              args: [],
              lang: "js",
            },
          },
        },
      },
    ],
  })
  const controller = new AbortController()
  const started = performance.now()
  const discovery = sources.mongodb.discover(
    {
      id: "slow-source",
      version: "1",
      config: { mode: "fields", ...server, database: SLOW, username: null, authSource: null, tls: false },
      secret: {},
    },
    {
      schemas: [SLOW],
      signal: controller.signal,
      onProgress: async (progress) => {
        if (progress.phase === "reading_columns" && progress.objectsTotal !== null) {
          setTimeout(() => controller.abort("cancelled"), 300)
        }
      },
    },
  )
  await assert.rejects(discovery, (reason: unknown) => reason === "cancelled")
  assert.ok(performance.now() - started < 2_500, "discovery stopped before the sample finished")
  // The view's sample would otherwise keep spinning on the server for seconds.
  await waitFor(
    async () => (await mongo.db("admin").command({ currentOp: 1, ns: new RegExp(`^${SLOW}\\.`) })).inprog,
    (operations: unknown[]) => operations.length === 0,
    "the sample to stop on the server",
  )
  assert.ok(performance.now() - started < 2_500, "the server stopped sampling before the view finished")
  await sources.mongodb.evict("slow-source")
})

test("passwords and connection strings never appear in responses or console output", { skip }, () => {
  const responses = [...owner.responses, ...member.responses, ...outsider.responses]
  assert.ok(responses.length > 20)
  for (const text of [...responses, ...consoleCapture.lines]) {
    assert.ok(!text.includes(PASSWORD), "the password leaked")
    assert.ok(!text.includes(`${READER}:`), "a connection string leaked")
    assert.ok(!/sealed_?secret/i.test(text), "the sealed secret leaked")
  }
})
