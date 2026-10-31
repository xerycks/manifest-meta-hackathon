import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import test, { after, before } from "node:test"

import type { Pool } from "pg"

import { loadEnv } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import type { PostgresConfig } from "../../src/connections/schemas.js"
import type { KnowledgeEntry, KnowledgeList } from "../../src/knowledge/schemas.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import type {
  ManifestColumn,
  ManifestObject,
  ManifestObjectDetail,
  ManifestRelationship,
} from "../../src/manifests/schemas.js"
import type { SearchResults } from "../../src/search/schemas.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { buildDemoSource } from "../../src/storage/demo-source-builder.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"
import { captureConsole } from "./support/console.js"
import { signIn, TestClient } from "./support/http.js"
import { manifestClient, objectIdIn } from "./support/manifests.js"
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
interface Failure<D = unknown> {
  error: { code: string; message: string; details?: D }
}

let storage: Pool
let sourcePool: Pool
let sources: SourceAdapters
let refreshes: RefreshRunner
let running: RunningApp
let consoleCapture: ReturnType<typeof captureConsole>
let owner: TestClient
let admin: TestClient
let member: TestClient
let outsider: TestClient
let acme: Workspace
let globex: Workspace
let source: { config: PostgresConfig; password: string }
let shop: Connection
let globexShop: Connection

function env(withKey = true) {
  return loadEnv({
    NODE_ENV: "test",
    ALLOW_DEV_LOGIN: "true",
    SESSION_SECRET,
    ...(withKey ? { CONNECTION_ENCRYPTION_KEY: KEY } : {}),
  })
}

const workspacePath = (workspace: Workspace) => `/api/v1/workspaces/${workspace.id}`
const manifestPath = (workspace = acme, connection = shop) =>
  `${workspacePath(workspace)}/connections/${connection.id}/manifest`
const knowledgePath = (workspace = acme) => `${workspacePath(workspace)}/knowledge`

const reads = () => manifestClient(owner, manifestPath())

function columnOf(detail: ManifestObjectDetail, name: string): ManifestColumn {
  const column = detail.columns.find((entry) => entry.name === name)
  assert.ok(column, `column ${name}`)
  return column
}

async function objectDetail(schema: string, name: string): Promise<ManifestObjectDetail> {
  const { manifest, detail } = reads()
  return detail(objectIdIn(await manifest(), schema, name))
}

async function patch<T>(client: TestClient, path: string, json: unknown) {
  return client.call<Ok<T> & Failure<{ current?: T; field?: string }>>(path, { method: "PATCH", json })
}

async function relate(fromColumnId: string, toColumnId: string, remark?: string) {
  return owner.call<Ok<ManifestRelationship> & Failure<{ field?: string }>>(
    `${manifestPath()}/relationships`,
    { method: "POST", json: { fromColumnId, toColumnId, ...(remark ? { remark } : {}) } },
  )
}

async function search(q: string, client = owner, workspace = acme): Promise<SearchResults> {
  const res = await client.call<Ok<SearchResults>>(
    `${workspacePath(workspace)}/search?q=${encodeURIComponent(q)}`,
  )
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

async function createEntry(client: TestClient, json: unknown, workspace = acme) {
  return client.call<Ok<KnowledgeEntry> & Failure<{ field?: string }>>(knowledgePath(workspace), {
    method: "POST",
    json,
  })
}

async function createSource(client: TestClient, workspace: Workspace): Promise<Connection> {
  const created = await client.call<Ok<Connection>>(`${workspacePath(workspace)}/connections`, {
    method: "POST",
    json: {
      name: "Demo store (synthetic)",
      engine: "postgres",
      config: source.config,
      password: source.password,
      schemas: ["shop", "support"],
    },
  })
  assert.equal(created.status, 201, created.text)
  const connection = created.body.result
  const { latestRefresh, finished } = manifestClient(client, manifestPath(workspace, connection))
  const first = await latestRefresh()
  assert.ok(first)
  assert.equal((await finished(first.id)).status, "succeeded")
  return connection
}

/** The parts of an object detail that people write. */
function authored(detail: ManifestObjectDetail) {
  return {
    object: [detail.object.label, detail.object.description, detail.object.rowMeaning, detail.object.version],
    columns: detail.columns.map((column) => [
      column.name,
      column.label,
      column.description,
      column.unit,
      column.valueNotes,
      column.version,
    ]),
    relationships: [...detail.outgoing, ...detail.incoming].map((relationship) => [
      relationship.id,
      relationship.origin,
      relationship.remark,
      relationship.version,
      relationship.needsReview,
    ]),
  }
}

before(async () => {
  if (skip) return
  storage = createPool(TEST_DATABASE_URL as string)
  await resetStorage(storage)
  sourcePool = createPool(TEST_SOURCE_DATABASE_URL as string)
  await buildDemoSource(sourcePool)
  // Test-only additions: a referral column with no foreign key, and a view.
  await sourcePool.query(`
    ALTER TABLE shop.customers ADD COLUMN referred_by integer;
    CREATE VIEW shop.big_orders AS SELECT id, customer_id, total FROM shop.orders WHERE total > 100;
  `)
  source = sourceSettings(TEST_SOURCE_DATABASE_URL as string)

  consoleCapture = captureConsole()
  sources = createSourceAdapters()
  refreshes = new RefreshRunner()
  running = await startApp(createApp(env(), { pool: storage, sources, refreshes }))

  owner = (await signIn(running.baseUrl, "owner@example.com", "Owner")).client
  const workspaceRes = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
  })
  acme = workspaceRes.body.result
  globex = (
    await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
      method: "POST",
      json: { name: "Globex", slug: "globex" },
    })
  ).body.result

  const workspaces = new WorkspacesRepository(storage)
  const adminSession = await signIn(running.baseUrl, "admin@example.com", "Admin")
  admin = adminSession.client
  await workspaces.addMember(acme.id, adminSession.context.user.id, "admin")
  const memberSession = await signIn(running.baseUrl, "member@example.com", "Member")
  member = memberSession.client
  await workspaces.addMember(acme.id, memberSession.context.user.id, "member")
  outsider = (await signIn(running.baseUrl, "outsider@example.com", "Outsider")).client

  shop = await createSource(owner, acme)
  globexShop = await createSource(owner, globex)
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

test("business context and a relationship survive a reload, a new backend, and a refresh", { skip }, async () => {
  const orders = await objectDetail("shop", "orders")
  assert.equal(orders.object.version, 1)
  assert.equal(orders.object.label, null)

  const savedObject = await patch<ManifestObject>(owner, `${manifestPath()}/objects/${orders.object.id}`, {
    version: 1,
    label: "  Orders  ",
    description: "Checkouts placed in the store.\n\n- Revenue excludes **cancelled** orders\n\n",
    rowMeaning: "One row per checkout",
  })
  assert.equal(savedObject.status, 200, savedObject.text)
  assert.equal(savedObject.body.result.label, "Orders")
  assert.equal(
    savedObject.body.result.description,
    "Checkouts placed in the store.\n\n- Revenue excludes **cancelled** orders",
  )
  assert.equal(savedObject.body.result.version, 2)
  assert.equal(savedObject.body.result.editedBy?.name, "Owner")
  assert.ok(savedObject.body.result.editedAt)

  const total = columnOf(orders, "total")
  const savedColumn = await patch<ManifestColumn>(owner, `${manifestPath()}/columns/${total.id}`, {
    version: total.version,
    label: "Order total",
    description: "Net revenue of the checkout before refunds.",
    unit: "USD",
    valueNotes: "Never negative; 0 for fully discounted orders.",
  })
  assert.equal(savedColumn.status, 200, savedColumn.text)
  assert.equal(savedColumn.body.result.unit, "USD")
  assert.equal(savedColumn.body.result.version, total.version + 1)
  assert.equal(savedColumn.body.result.objectId, orders.object.id)

  // Clearing a field with an empty string.
  const cleared = await patch<ManifestColumn>(owner, `${manifestPath()}/columns/${total.id}`, {
    version: total.version + 1,
    valueNotes: "  ",
  })
  assert.equal(cleared.status, 200, cleared.text)
  assert.equal(cleared.body.result.valueNotes, null)
  assert.equal(cleared.body.result.unit, "USD")

  const customers = await objectDetail("shop", "customers")
  const relationship = await relate(
    columnOf(customers, "referred_by").id,
    columnOf(customers, "id").id,
    "Referral program (synthetic)",
  )
  assert.equal(relationship.status, 201, relationship.text)
  assert.equal(relationship.body.result.origin, "manual")
  assert.equal(relationship.body.result.needsReview, false)
  assert.deepEqual(relationship.body.result.from.columns, ["referred_by"])
  assert.deepEqual(relationship.body.result.to.columns, ["id"])

  const foreignKey = orders.outgoing.find((entry) => entry.to.name === "customers")
  assert.ok(foreignKey)
  const remarked = await patch<ManifestRelationship>(
    owner,
    `${manifestPath()}/relationships/${foreignKey.id}`,
    { version: foreignKey.version, remark: "Guest checkouts are attached to a placeholder customer." },
  )
  assert.equal(remarked.status, 200, remarked.text)
  assert.equal(remarked.body.result.origin, "foreign_key")

  // Reload, then read through a separate backend with its own pool.
  const reloaded = await objectDetail("shop", "orders")
  assert.equal(reloaded.object.rowMeaning, "One row per checkout")
  assert.equal(columnOf(reloaded, "total").label, "Order total")
  assert.equal(
    reloaded.outgoing.find((entry) => entry.id === foreignKey.id)?.remark,
    "Guest checkouts are attached to a placeholder customer.",
  )
  const freshPool = createPool(TEST_DATABASE_URL as string)
  const second = await startApp(createApp(env(), { pool: freshPool, sources, refreshes: new RefreshRunner() }))
  try {
    const elsewhere = await manifestClient(owner.at(second.baseUrl), manifestPath()).detail(orders.object.id)
    assert.deepEqual(elsewhere, reloaded)
  } finally {
    await second.close()
    await freshPool.end()
  }

  // A refresh that changes discovered metadata leaves every authored field alone.
  const customersBefore = await objectDetail("shop", "customers")
  await sourcePool.query("COMMENT ON TABLE shop.orders IS 'One row per checkout (comment changed).'")
  await reads().refreshNow()
  const refreshed = await objectDetail("shop", "orders")
  assert.equal(refreshed.object.comment, "One row per checkout (comment changed).")
  assert.deepEqual(authored(refreshed), authored(reloaded))
  assert.deepEqual(authored(await objectDetail("shop", "customers")), authored(customersBefore))
  const manual = customersBefore.outgoing.find((entry) => entry.origin === "manual")
  assert.equal(manual?.remark, "Referral program (synthetic)")
})

test("removed columns and objects keep their meaning; manual relationships are flagged, not deleted", { skip }, async () => {
  const customers = await objectDetail("shop", "customers")
  const referredBy = columnOf(customers, "referred_by")
  const described = await patch<ManifestColumn>(owner, `${manifestPath()}/columns/${referredBy.id}`, {
    version: referredBy.version,
    description: "The customer who referred this one (synthetic).",
  })
  assert.equal(described.status, 200, described.text)
  const view = await objectDetail("shop", "big_orders")
  const labelled = await patch<ManifestObject>(owner, `${manifestPath()}/objects/${view.object.id}`, {
    version: view.object.version,
    label: "Big orders",
  })
  assert.equal(labelled.status, 200, labelled.text)

  await sourcePool.query(`
    DROP VIEW shop.big_orders;
    ALTER TABLE shop.customers DROP COLUMN referred_by;
  `)
  await reads().refreshNow()

  const dropped = await reads().detail(customers.object.id)
  const gone = columnOf(dropped, "referred_by")
  assert.equal(gone.id, referredBy.id)
  assert.equal(gone.present, false)
  assert.equal(gone.description, "The customer who referred this one (synthetic).")
  const flagged = dropped.outgoing.find((entry) => entry.origin === "manual")
  assert.ok(flagged, "the manual relationship is kept")
  assert.equal(flagged.needsReview, true)
  const removedView = await reads().detail(view.object.id)
  assert.equal(removedView.object.present, false)
  assert.equal(removedView.object.label, "Big orders")

  // Removed columns are still found by search, marked as not present.
  const found = await search("referred this one")
  assert.equal(found.columns[0]?.columnId, referredBy.id)
  assert.equal(found.columns[0]?.present, false)
  assert.equal(found.columns[0]?.matched, "description")

  // A removed column cannot start a new relationship.
  const rejected = await relate(referredBy.id, columnOf(dropped, "id").id)
  assert.equal(rejected.status, 422, rejected.text)
  assert.match(rejected.body.error.message, /no longer in the source/)

  await sourcePool.query(`
    ALTER TABLE shop.customers ADD COLUMN referred_by integer;
    CREATE VIEW shop.big_orders AS SELECT id, customer_id, total FROM shop.orders WHERE total > 100;
  `)
  await reads().refreshNow()
  const back = await reads().detail(customers.object.id)
  assert.equal(columnOf(back, "referred_by").present, true)
  assert.equal(columnOf(back, "referred_by").description, "The customer who referred this one (synthetic).")
  assert.equal(back.outgoing.find((entry) => entry.id === flagged.id)?.needsReview, false)
  const viewBack = await reads().detail(view.object.id)
  assert.equal(viewBack.object.present, true)
  assert.equal(viewBack.object.label, "Big orders")
})

test("a save based on a stale version gets 409 with the current record", { skip }, async () => {
  const products = await objectDetail("shop", "products")
  const path = `${manifestPath()}/objects/${products.object.id}`
  const version = products.object.version
  const first = await patch<ManifestObject>(owner, path, { version, label: "Catalog" })
  assert.equal(first.status, 200, first.text)

  const stale = await patch<ManifestObject>(admin, path, { version, label: "Products" })
  assert.equal(stale.status, 409, stale.text)
  assert.equal(stale.body.error.code, "CONFLICT")
  assert.equal(stale.body.error.details?.current?.label, "Catalog")
  assert.equal(stale.body.error.details?.current?.version, version + 1)
  assert.equal((await reads().detail(products.object.id)).object.label, "Catalog")

  const price = columnOf(products, "unit_price")
  const columnPath = `${manifestPath()}/columns/${price.id}`
  assert.equal((await patch(owner, columnPath, { version: price.version, unit: "USD" })).status, 200)
  const staleColumn = await patch<ManifestColumn>(admin, columnPath, { version: price.version, unit: "EUR" })
  assert.equal(staleColumn.status, 409)
  assert.equal(staleColumn.body.error.details?.current?.unit, "USD")

  const manual = (await objectDetail("shop", "customers")).outgoing.find((entry) => entry.origin === "manual")
  assert.ok(manual)
  const relationshipPath = `${manifestPath()}/relationships/${manual.id}`
  assert.equal((await patch(owner, relationshipPath, { version: manual.version, remark: "New" })).status, 200)
  const staleRelationship = await patch<ManifestRelationship>(admin, relationshipPath, {
    version: manual.version,
    remark: "Older",
  })
  assert.equal(staleRelationship.status, 409)
  assert.equal(staleRelationship.body.error.details?.current?.remark, "New")

  // Unknown ids are 404, not conflicts; empty patches are rejected.
  assert.equal((await patch(owner, `${manifestPath()}/objects/${randomUUID()}`, { version: 1, label: "x" })).status, 404)
  const empty = await patch(owner, path, { version: version + 1 })
  assert.equal(empty.status, 422)
  const unknownField = await patch(owner, path, { version: version + 1, comment: "not editable" })
  assert.equal(unknownField.status, 422)
  const tooLong = await patch(owner, path, { version: version + 1, label: "x".repeat(201) })
  assert.equal(tooLong.status, 422)
})

test("manual relationships are validated", { skip }, async () => {
  const customers = await objectDetail("shop", "customers")
  const orders = await objectDetail("shop", "orders")
  const referredBy = columnOf(customers, "referred_by")
  const customerId = columnOf(customers, "id")

  const same = await relate(customerId.id, customerId.id)
  assert.equal(same.status, 422)
  assert.match(same.body.error.message, /two different columns/)

  const mismatched = await relate(referredBy.id, columnOf(customers, "full_name").id)
  assert.equal(mismatched.status, 422)
  assert.equal(mismatched.body.error.details?.field, "toColumnId")
  assert.match(mismatched.body.error.message, /integer\) and shop\.customers\.full_name \(text\)/)

  // Columns of another workspace's source, or unknown ids, are not in this source.
  const globexCustomers = await manifestClient(owner, manifestPath(globex, globexShop)).detail(
    objectIdIn(await manifestClient(owner, manifestPath(globex, globexShop)).manifest(), "shop", "customers"),
  )
  const foreign = await relate(referredBy.id, columnOf(globexCustomers, "id").id)
  assert.equal(foreign.status, 422)
  assert.equal(foreign.body.error.details?.field, "toColumnId")
  assert.equal((await relate(randomUUID(), customerId.id)).status, 422)
  const malformed = await owner.call<Failure>(`${manifestPath()}/relationships`, {
    method: "POST",
    json: { fromColumnId: referredBy.id },
  })
  assert.equal(malformed.status, 422)
  assert.equal(malformed.body.error.code, "VALIDATION_FAILED")

  const duplicate = await relate(referredBy.id, customerId.id)
  assert.equal(duplicate.status, 409)
  assert.match(duplicate.body.error.message, /already exists/)
  const coversForeignKey = await relate(columnOf(orders, "customer_id").id, customerId.id)
  assert.equal(coversForeignKey.status, 409)
  assert.match(coversForeignKey.body.error.message, /foreign key in the source already links/)

  const foreignKey = orders.outgoing.find((entry) => entry.origin === "foreign_key")
  assert.ok(foreignKey)
  const fkPath = `${manifestPath()}/relationships/${foreignKey.id}`
  const removeKey = await owner.call<Failure>(fkPath, { method: "DELETE" })
  assert.equal(removeKey.status, 409)
  const moveKey = await patch(owner, fkPath, {
    version: foreignKey.version,
    fromColumnId: referredBy.id,
    toColumnId: customerId.id,
  })
  assert.equal(moveKey.status, 422)

  // Moving a manual relationship to other columns, then removing it.
  const created = await relate(columnOf(orders, "id").id, columnOf(await objectDetail("support", "tickets"), "order_id").id)
  assert.equal(created.status, 201, created.text)
  const path = `${manifestPath()}/relationships/${created.body.result.id}`
  const halfMove = await patch(owner, path, { version: 1, fromColumnId: referredBy.id })
  assert.equal(halfMove.status, 422)
  const tickets = await objectDetail("support", "tickets")
  const moved = await patch<ManifestRelationship>(owner, path, {
    version: 1,
    fromColumnId: columnOf(tickets, "agent_id").id,
    toColumnId: columnOf(await objectDetail("support", "agents"), "id").id,
  })
  // tickets.agent_id → agents.id is a discovered foreign key.
  assert.equal(moved.status, 409, moved.text)
  const movedOk = await patch<ManifestRelationship>(owner, path, {
    version: 1,
    fromColumnId: columnOf(tickets, "customer_id").id,
    toColumnId: referredBy.id,
    remark: "Tickets from referred customers",
  })
  assert.equal(movedOk.status, 200, movedOk.text)
  assert.equal(movedOk.body.result.from.name, "tickets")
  assert.deepEqual(movedOk.body.result.to.columns, ["referred_by"])
  assert.equal(movedOk.body.result.version, 2)

  // A relationship id is only found under its own workspace and source.
  assert.equal(
    (await owner.call(`${manifestPath(globex, globexShop)}/relationships/${created.body.result.id}`, { method: "DELETE" })).status,
    404,
  )
  assert.equal((await owner.call(path, { method: "DELETE" })).status, 200)
  assert.equal((await owner.call(path, { method: "DELETE" })).status, 404)
})

test("search finds names, descriptions, and knowledge entries within the workspace only", { skip }, async () => {
  const entry = await createEntry(owner, {
    title: "Net revenue",
    body: "Sum of `orders.total` for paid orders, **excluding** refunds (synthetic definition).",
    connectionId: shop.id,
  })
  assert.equal(entry.status, 201, entry.text)

  const results = await search("net revenue")
  assert.deepEqual(
    results.columns.map((hit) => [hit.objectName, hit.name, hit.matched]),
    [["orders", "total", "description"]],
  )
  assert.match(results.columns[0]?.snippet ?? "", /Net revenue of the checkout/)
  assert.equal(results.columns[0]?.connectionName, "Demo store (synthetic)")
  assert.deepEqual(
    results.knowledge.map((hit) => [hit.title, hit.matched, hit.connection?.id]),
    [["Net revenue", "title", shop.id]],
  )
  assert.match(results.knowledge[0]?.snippet ?? "", /^Sum of orders\.total for paid orders, excluding/)
  assert.equal(results.truncated, false)

  const byRowMeaning = await search("one row per checkout")
  assert.equal(byRowMeaning.objects[0]?.name, "orders")
  assert.equal(byRowMeaning.objects[0]?.matched, "rowMeaning")
  const byName = await search("ORDER_ITEMS")
  assert.equal(byName.objects[0]?.name, "order_items")
  assert.equal(byName.objects[0]?.matched, "name")
  const byLabel = await search("catalog")
  assert.equal(byLabel.objects[0]?.name, "products")
  assert.equal(byLabel.objects[0]?.matched, "label")

  // Wildcards are literal, and results are bounded.
  const wildcard = await search("%")
  assert.equal(wildcard.objects.length + wildcard.columns.length + wildcard.knowledge.length, 0)
  const bounded = await owner.call<Ok<SearchResults>>(`${workspacePath(acme)}/search?q=id&limit=2`)
  assert.equal(bounded.status, 200, bounded.text)
  assert.equal(bounded.body.result.columns.length, 2)
  assert.equal(bounded.body.result.truncated, true)
  assert.equal((await owner.call(`${workspacePath(acme)}/search?q=%20`)).status, 422)
  assert.equal((await owner.call(`${workspacePath(acme)}/search?q=${"x".repeat(101)}`)).status, 422)

  // The other workspace has the same tables but none of this meaning.
  const elsewhere = await search("net revenue", owner, globex)
  assert.equal(elsewhere.columns.length + elsewhere.knowledge.length, 0)
  assert.equal((await search("net revenue", member)).knowledge.length, 1)
})

test("knowledge entries: members add and edit their own; owners and admins manage any", { skip }, async () => {
  const mine = await createEntry(member, { title: "Active customer", body: "Ordered in the last 90 days." })
  assert.equal(mine.status, 201, mine.text)
  assert.equal(mine.body.result.createdBy?.name, "Member")
  assert.equal(mine.body.result.connection, null)
  assert.equal(mine.body.result.version, 1)
  const minePath = `${knowledgePath()}/${mine.body.result.id}`

  const edited = await patch<KnowledgeEntry>(member, minePath, {
    version: 1,
    body: "Placed a paid order in the last 90 days.",
    connectionId: shop.id,
  })
  assert.equal(edited.status, 200, edited.text)
  assert.equal(edited.body.result.version, 2)
  assert.equal(edited.body.result.connection?.name, "Demo store (synthetic)")

  const ownerEntry = (await search("net revenue")).knowledge[0]
  assert.ok(ownerEntry)
  const ownerPath = `${knowledgePath()}/${ownerEntry.entryId}`
  const notYours = await patch(member, ownerPath, { version: 1, title: "Gross revenue" })
  assert.equal(notYours.status, 403)
  const memberDelete = await member.call<Failure>(minePath, { method: "DELETE" })
  assert.equal(memberDelete.status, 403)
  assert.equal(memberDelete.body.error.code, "FORBIDDEN")

  const byAdmin = await patch<KnowledgeEntry>(admin, minePath, { version: 2, title: "Active customer (90 days)" })
  assert.equal(byAdmin.status, 200, byAdmin.text)
  assert.equal(byAdmin.body.result.updatedBy?.name, "Admin")
  assert.equal(byAdmin.body.result.createdBy?.name, "Member")

  const stale = await patch<KnowledgeEntry>(member, minePath, { version: 2, body: "Older draft" })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.details?.current?.title, "Active customer (90 days)")
  assert.equal(stale.body.error.details?.current?.version, 3)

  const sameTitle = await createEntry(owner, { title: "net REVENUE" })
  assert.equal(sameTitle.status, 409)
  const otherWorkspaceSource = await createEntry(owner, { title: "Churn", connectionId: globexShop.id })
  assert.equal(otherWorkspaceSource.status, 422)
  assert.equal(otherWorkspaceSource.body.error.details?.field, "connectionId")
  assert.equal((await createEntry(owner, { title: "  " })).status, 422)

  const listed = await member.call<Ok<KnowledgeList>>(`${knowledgePath()}?limit=1`)
  assert.equal(listed.status, 200, listed.text)
  assert.equal(listed.body.result.entries.length, 1)
  assert.equal(listed.body.result.entries[0]?.title, "Active customer (90 days)", "newest first")
  assert.equal(listed.body.result.entries[0]?.excerpt, "Placed a paid order in the last 90 days.")
  assert.equal(listed.body.result.nextOffset, 1)
  const next = await member.call<Ok<KnowledgeList>>(`${knowledgePath()}?limit=1&offset=1`)
  assert.equal(next.body.result.entries[0]?.title, "Net revenue")
  assert.equal(next.body.result.nextOffset, null)
  const searched = await member.call<Ok<KnowledgeList>>(`${knowledgePath()}?search=${encodeURIComponent("refunds")}`)
  assert.deepEqual(searched.body.result.entries.map((entry) => entry.title), ["Net revenue"])

  const read = await member.call<Ok<KnowledgeEntry>>(ownerPath)
  assert.equal(read.status, 200)
  assert.match(read.body.result.body, /\*\*excluding\*\*/)

  assert.equal((await owner.call(minePath, { method: "DELETE" })).status, 200)
  assert.equal((await member.call(minePath)).status, 404)

  // Removing a linked source keeps the entry and drops the link.
  const linked = await createEntry(owner, { title: "Globex orders", connectionId: globexShop.id }, globex)
  assert.equal(linked.status, 201, linked.text)
  const removed = await owner.call(`${workspacePath(globex)}/connections/${globexShop.id}`, { method: "DELETE" })
  assert.equal(removed.status, 200, removed.text)
  const unlinked = await owner.call<Ok<KnowledgeEntry>>(`${knowledgePath(globex)}/${linked.body.result.id}`)
  assert.equal(unlinked.status, 200)
  assert.equal(unlinked.body.result.connection, null)
})

test("members cannot edit manifests; non-members and other workspaces get 404", { skip }, async () => {
  const orders = await objectDetail("shop", "orders")
  const total = columnOf(orders, "total")
  const relationship = orders.outgoing[0]
  assert.ok(relationship)
  const entry = (await search("net revenue")).knowledge[0]
  assert.ok(entry)

  const edits: [string, string, unknown][] = [
    ["PATCH", `${manifestPath()}/objects/${orders.object.id}`, { version: orders.object.version, label: "x" }],
    ["PATCH", `${manifestPath()}/columns/${total.id}`, { version: total.version, label: "x" }],
    ["POST", `${manifestPath()}/relationships`, { fromColumnId: total.id, toColumnId: total.id }],
    ["PATCH", `${manifestPath()}/relationships/${relationship.id}`, { version: relationship.version, remark: "x" }],
    ["DELETE", `${manifestPath()}/relationships/${relationship.id}`, undefined],
  ]
  for (const [method, path, json] of edits) {
    const res = await member.call<Failure>(path, { method, json })
    assert.equal(res.status, 403, `member ${method} ${path}`)
    assert.equal(res.body.error.code, "FORBIDDEN")
  }
  // Admins edit manifests like owners.
  const byAdmin = await patch<ManifestObject>(admin, `${manifestPath()}/objects/${orders.object.id}`, {
    version: orders.object.version,
    label: "Orders",
  })
  assert.equal(byAdmin.status, 200, byAdmin.text)

  const everything: [string, string, unknown][] = [
    ...edits,
    ["GET", `${workspacePath(acme)}/search?q=orders`, undefined],
    ["GET", knowledgePath(), undefined],
    ["POST", knowledgePath(), { title: "Outsider" }],
    ["GET", `${knowledgePath()}/${entry.entryId}`, undefined],
    ["PATCH", `${knowledgePath()}/${entry.entryId}`, { version: 1, title: "x" }],
    ["DELETE", `${knowledgePath()}/${entry.entryId}`, undefined],
  ]
  for (const [method, path, json] of everything) {
    assert.equal((await outsider.call(path, { method, json })).status, 404, `outsider ${method} ${path}`)
  }
  // Ids of this workspace are not found under another workspace the owner belongs to.
  assert.equal(
    (await patch(owner, `${knowledgePath(globex)}/${entry.entryId}`, { version: 1, title: "x" })).status,
    404,
  )
  assert.equal((await owner.call(`${knowledgePath(globex)}/${entry.entryId}`)).status, 404)

  const noCsrf = await owner.call<Failure>(`${manifestPath()}/objects/${orders.object.id}`, {
    method: "PATCH",
    json: { version: 1, label: "x" },
    csrf: false,
  })
  assert.equal(noCsrf.status, 403)
  assert.equal(noCsrf.body.error.code, "CSRF_REQUIRED")
  const noCsrfEntry = await member.call<Failure>(knowledgePath(), { method: "POST", json: { title: "x" }, csrf: false })
  assert.equal(noCsrfEntry.body.error.code, "CSRF_REQUIRED")

  const anonymous = new TestClient(running.baseUrl)
  assert.equal((await anonymous.call(knowledgePath())).status, 401)
  assert.equal((await anonymous.call(`${workspacePath(acme)}/search?q=orders`)).status, 401)
})

test("without storage knowledge and search answer 503; without the key only manifest edits do", { skip }, async () => {
  const bare = await startApp(createApp(env()))
  try {
    for (const path of [knowledgePath(), `${workspacePath(acme)}/search?q=orders`]) {
      const res = await new TestClient(bare.baseUrl).call<Failure>(path)
      assert.equal(res.status, 503, path)
      assert.equal(res.body.error.code, "STORAGE_NOT_CONFIGURED")
    }
  } finally {
    await bare.close()
  }

  const keyless = await startApp(createApp(env(false), { pool: storage }))
  try {
    const orders = await objectDetail("shop", "orders")
    const edit = await patch(owner.at(keyless.baseUrl), `${manifestPath()}/objects/${orders.object.id}`, {
      version: orders.object.version,
      label: "x",
    })
    assert.equal(edit.status, 503)
    assert.equal((await owner.at(keyless.baseUrl).call(knowledgePath())).status, 200)
    assert.equal((await owner.at(keyless.baseUrl).call(`${workspacePath(acme)}/search?q=orders`)).status, 200)
  } finally {
    await keyless.close()
  }
})

test("the saved password never appears in responses or console output", { skip }, () => {
  const responses = [...owner.responses, ...admin.responses, ...member.responses, ...outsider.responses]
  assert.ok(responses.length > 50)
  for (const text of responses) {
    assert.ok(!text.includes(source.password), "a response included the password")
    assert.ok(!/sealed_?secret/i.test(text), "a response included the sealed secret")
  }
  for (const line of consoleCapture.lines) {
    assert.ok(!line.includes(source.password), "console output included the password")
  }
})
