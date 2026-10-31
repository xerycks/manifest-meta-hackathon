import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import test, { after, before } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"

import type { Pool } from "pg"

import { loadEnv } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import {
  SourceConnectionError,
  type SourceAdapter,
  type SourceAdapters,
} from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import type { PostgresConfig } from "../../src/connections/schemas.js"
import { ManifestsRepository } from "../../src/manifests/repository.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import type {
  ConnectionManifest,
  ManifestObjectDetail,
  ManifestRefresh,
} from "../../src/manifests/schemas.js"
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
  error: { code: string; message: string; details?: { refreshId?: string } }
}

type PostgresAdapter = SourceAdapter<PostgresConfig>

let storage: Pool
let sourcePool: Pool
let realSources: SourceAdapters
/** Replaces the real discovery for one test, e.g. to inject a failure. */
let discoverOverride: PostgresAdapter["discover"] | null = null
let refreshes: RefreshRunner
let running: RunningApp
let consoleCapture: ReturnType<typeof captureConsole>
let owner: TestClient
let member: TestClient
let outsider: TestClient
let acme: Workspace
let globex: Workspace
let source: { config: PostgresConfig; password: string }
let connection: Connection

const TERMINAL = new Set(["succeeded", "failed", "cancelled"])

function env(withKey = true) {
  return loadEnv({
    NODE_ENV: "test",
    ALLOW_DEV_LOGIN: "true",
    SESSION_SECRET,
    ...(withKey ? { CONNECTION_ENCRYPTION_KEY: KEY } : {}),
  })
}

const connectionsPath = (workspace: Workspace) => `/api/v1/workspaces/${workspace.id}/connections`
const manifestPath = (workspace = acme, id = connection.id) =>
  `${connectionsPath(workspace)}/${id}/manifest`

async function createWorkspace(client: TestClient, name: string, slug: string): Promise<Workspace> {
  const res = await client.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name, slug },
  })
  assert.equal(res.status, 201, res.text)
  return res.body.result
}

async function latestRefresh(): Promise<ManifestRefresh | null> {
  const res = await owner.call<Ok<ManifestRefresh | null>>(`${manifestPath()}/refreshes/latest`)
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (done(value)) return value
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function finished(refreshId: string): Promise<ManifestRefresh> {
  return waitFor(
    async () => {
      const res = await owner.call<Ok<ManifestRefresh>>(`${manifestPath()}/refreshes/${refreshId}`)
      assert.equal(res.status, 200, res.text)
      return res.body.result
    },
    (refresh) => TERMINAL.has(refresh.status),
    `refresh ${refreshId}`,
  )
}

async function refreshNow(): Promise<ManifestRefresh> {
  const res = await owner.call<Ok<ManifestRefresh>>(`${manifestPath()}/refresh`, { method: "POST" })
  assert.equal(res.status, 202, res.text)
  assert.equal(res.body.result.trigger, "manual")
  return finished(res.body.result.id)
}

async function manifest(search?: string): Promise<ConnectionManifest> {
  const query = search === undefined ? "" : `?search=${encodeURIComponent(search)}`
  const res = await owner.call<Ok<ConnectionManifest>>(`${manifestPath()}${query}`)
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

function objectId(published: ConnectionManifest, schema: string, name: string): string {
  const found = published.schemas
    .find((entry) => entry.name === schema)
    ?.objects.find((object) => object.name === name)
  assert.ok(found, `${schema}.${name} is listed`)
  return found.id
}

async function detail(id: string): Promise<ManifestObjectDetail> {
  const res = await owner.call<Ok<ManifestObjectDetail>>(`${manifestPath()}/objects/${id}`)
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

/** Source backends of this app that are waiting on a lock right now. */
async function blockedSourceQueries(): Promise<number> {
  const { rows } = await sourcePool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'manifest-source'
        AND wait_event_type = 'Lock'`,
  )
  return rows[0]?.count ?? 0
}

/** Holds an exclusive lock on shop.orders; discovery waits on it while reading a view over that table. */
async function lockOrders(): Promise<() => Promise<void>> {
  const client = await sourcePool.connect()
  await client.query("BEGIN")
  await client.query("LOCK TABLE shop.orders IN ACCESS EXCLUSIVE MODE")
  return async () => {
    await client.query("ROLLBACK")
    client.release()
  }
}

before(async () => {
  if (skip) return
  storage = createPool(TEST_DATABASE_URL as string)
  await resetStorage(storage)
  sourcePool = createPool(TEST_SOURCE_DATABASE_URL as string)
  await buildDemoSource(sourcePool)
  source = sourceSettings(TEST_SOURCE_DATABASE_URL as string)

  consoleCapture = captureConsole()
  realSources = createSourceAdapters()
  const sources: SourceAdapters = {
    ...realSources,
    postgres: {
      ...realSources.postgres,
      discover: (saved, request) =>
        (discoverOverride ?? realSources.postgres.discover)(saved, request),
    },
  }
  refreshes = new RefreshRunner()
  running = await startApp(createApp(env(), { pool: storage, sources, refreshes }))

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
  await closeSourceAdapters(realSources)
  await storage.end()
  await sourcePool.end()
})

test("a new source is discovered automatically and its related tables can be browsed", { skip }, async () => {
  const created = await owner.call<Ok<Connection>>(connectionsPath(acme), {
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
  connection = created.body.result

  const first = await latestRefresh()
  assert.ok(first, "a refresh started with the source")
  assert.equal(first.trigger, "source_created")
  const done = await finished(first.id)
  assert.equal(done.status, "succeeded", done.error ?? "")
  assert.equal(done.phase, "publishing")
  assert.equal(done.objectsDone, 6)
  assert.equal(done.objectsTotal, 6)
  assert.equal(done.counts?.objects, 6)
  assert.equal(done.counts?.relationships, 6)
  assert.equal(done.counts?.objectsAdded, 6)
  assert.equal(done.counts?.columnsAdded, done.counts?.columns)
  assert.equal(done.counts?.objectsRemoved, 0)

  const published = await manifest()
  assert.equal(published.lastPublished?.id, done.id)
  assert.equal(published.truncated, false)
  assert.deepEqual(
    published.schemas.map((schema) => [schema.name, schema.objects.map((object) => object.name)]),
    [
      ["shop", ["customers", "order_items", "orders", "products"]],
      ["support", ["agents", "tickets"]],
    ],
  )
  const ordersSummary = published.schemas[0]?.objects.find((object) => object.name === "orders")
  assert.equal(ordersSummary?.kind, "table")
  assert.equal(ordersSummary?.present, true)
  assert.equal(ordersSummary?.columnCount, 10)

  const orders = await detail(objectId(published, "shop", "orders"))
  assert.equal(orders.object.schema, "shop")
  assert.match(orders.object.comment ?? "", /One row per checkout/)
  const id = orders.columns.find((column) => column.name === "id")
  assert.equal(id?.isPrimaryKey, true)
  assert.equal(id?.nullable, false)
  assert.equal(id?.dataType, "integer")
  const status = orders.columns.find((column) => column.name === "status")
  assert.match(status?.comment ?? "", /pending -> paid/)
  assert.equal(orders.columns.find((column) => column.name === "refunded_at")?.nullable, true)
  assert.equal(orders.columns.find((column) => column.name === "subtotal")?.defaultValue, "0")
  assert.deepEqual(
    orders.columns.map((column) => column.ordinal),
    orders.columns.map((_, index) => index + 1),
  )

  // Outgoing foreign key to customers, and the tables that reference orders.
  assert.deepEqual(
    orders.outgoing.map((relationship) => [
      relationship.from.columns,
      `${relationship.to.schema}.${relationship.to.name}`,
      relationship.to.columns,
    ]),
    [[["customer_id"], "shop.customers", ["id"]]],
  )
  assert.deepEqual(
    orders.incoming.map((relationship) => `${relationship.from.schema}.${relationship.from.name}`).sort(),
    ["shop.order_items", "support.tickets"],
  )
  const customers = await detail(orders.outgoing[0]?.to.objectId ?? "")
  assert.equal(customers.object.name, "customers")
  assert.ok(customers.incoming.some((relationship) => relationship.from.name === "orders"))

  const searched = await manifest("ORDER")
  assert.deepEqual(
    searched.schemas.map((schema) => [schema.name, schema.objects.map((object) => object.name)]),
    [
      ["shop", ["order_items", "orders"]],
      ["support", []],
    ],
  )
  // Wildcards are matched literally.
  assert.ok((await manifest("%")).schemas.every((schema) => schema.objects.length === 0))
})

test("a refresh reflects an added column and keeps existing ids", { skip }, async () => {
  const before = await manifest()
  const ordersId = objectId(before, "shop", "orders")
  const previous = await detail(ordersId)

  await sourcePool.query(`
    CREATE TYPE shop.gift_wrap AS ENUM ('none', 'paper', 'box');
    ALTER TABLE shop.orders ADD COLUMN gift_wrap shop.gift_wrap NOT NULL DEFAULT 'none';
    COMMENT ON COLUMN shop.orders.gift_wrap IS 'How the order was wrapped (synthetic).';
    CREATE VIEW shop.order_totals AS
      SELECT customer_id, sum(total) AS revenue FROM shop.orders GROUP BY customer_id;
  `)
  const refresh = await refreshNow()
  assert.equal(refresh.status, "succeeded", refresh.error ?? "")
  assert.equal(refresh.counts?.objectsAdded, 1)
  assert.equal(refresh.counts?.columnsAdded, 3)
  assert.equal(refresh.counts?.columnsRemoved, 0)

  const after = await manifest()
  assert.equal(after.lastPublished?.id, refresh.id)
  assert.equal(objectId(after, "shop", "orders"), ordersId)
  const orders = await detail(ordersId)
  for (const column of previous.columns) {
    assert.equal(orders.columns.find((entry) => entry.name === column.name)?.id, column.id, column.name)
  }
  const added = orders.columns.find((column) => column.name === "gift_wrap")
  assert.ok(added)
  assert.equal(added.present, true)
  assert.equal(added.ordinal, previous.columns.length + 1)
  assert.equal(added.nullable, false)
  assert.deepEqual(added.enumValues, ["none", "paper", "box"])
  assert.equal(added.comment, "How the order was wrapped (synthetic).")

  const view = await detail(objectId(after, "shop", "order_totals"))
  assert.equal(view.object.kind, "view")
  assert.match(view.object.viewDefinition ?? "", /FROM shop\.orders/)
  assert.equal(view.columns.length, 2)
})

test("dropped columns and views stay as not present and return with their ids", { skip }, async () => {
  const before = await manifest()
  const ordersId = objectId(before, "shop", "orders")
  const viewId = objectId(before, "shop", "order_totals")
  const wrapId = (await detail(ordersId)).columns.find((column) => column.name === "gift_wrap")?.id

  await sourcePool.query(`
    DROP VIEW shop.order_totals;
    ALTER TABLE shop.orders DROP COLUMN gift_wrap;
  `)
  const removal = await refreshNow()
  assert.equal(removal.status, "succeeded", removal.error ?? "")
  assert.equal(removal.counts?.objectsRemoved, 1)
  assert.equal(removal.counts?.columnsRemoved, 3)

  const dropped = (await detail(ordersId)).columns.find((column) => column.name === "gift_wrap")
  assert.equal(dropped?.id, wrapId)
  assert.equal(dropped?.present, false)
  assert.ok(dropped?.removedAt)
  const removedView = await detail(viewId)
  assert.equal(removedView.object.present, false)
  assert.ok(removedView.object.removedAt)
  const listed = (await manifest()).schemas[0]?.objects ?? []
  assert.equal(listed.find((object) => object.id === viewId)?.present, false)
  assert.equal(listed.at(-1)?.id, viewId, "removed objects are listed after present ones")

  await sourcePool.query(`
    ALTER TABLE shop.orders ADD COLUMN gift_wrap shop.gift_wrap;
    CREATE VIEW shop.order_totals AS
      SELECT customer_id, sum(total) AS revenue FROM shop.orders GROUP BY customer_id;
  `)
  const restore = await refreshNow()
  assert.equal(restore.counts?.objectsAdded, 1)
  assert.equal(restore.counts?.columnsAdded, 3)
  const back = (await detail(ordersId)).columns.find((column) => column.name === "gift_wrap")
  assert.equal(back?.id, wrapId)
  assert.equal(back?.present, true)
  assert.equal(back?.removedAt, null)
  const restoredView = await detail(viewId)
  assert.equal(restoredView.object.present, true)
  assert.equal(objectId(await manifest(), "shop", "order_totals"), viewId)
})

test("a failed discovery leaves the published metadata untouched", { skip }, async () => {
  const published = await manifest()
  const ordersId = objectId(published, "shop", "orders")
  const orders = await detail(ordersId)
  await sourcePool.query("ALTER TABLE shop.orders ADD COLUMN not_published text")

  // Injected: discovery fails after reading part of the catalog.
  discoverOverride = async (_saved, request) => {
    await request.onProgress({ phase: "reading_columns", objectsDone: 3, objectsTotal: 7 })
    throw new SourceConnectionError("host_unreachable", "Could not reach PostgreSQL (injected).")
  }
  try {
    const failed = await refreshNow()
    assert.equal(failed.status, "failed")
    assert.equal(failed.error, "Could not reach PostgreSQL (injected).")
    assert.equal(failed.phase, "reading_columns")
    assert.equal(failed.objectsDone, 3)
    assert.equal(failed.counts, null)
  } finally {
    discoverOverride = null
  }
  assert.deepEqual(await manifest(), published)
  assert.deepEqual(await detail(ordersId), orders)

  // A real source failure: the saved database no longer exists.
  await storage.query(
    `UPDATE connections SET config = jsonb_set(config, '{database}', '"manifest_missing_db"'),
            updated_at = now()
      WHERE id = $1`,
    [connection.id],
  )
  try {
    const failed = await refreshNow()
    assert.equal(failed.status, "failed")
    assert.match(failed.error ?? "", /no database with that name/)
  } finally {
    await storage.query(
      `UPDATE connections SET config = jsonb_set(config, '{database}', to_jsonb($2::text)),
              updated_at = now()
        WHERE id = $1`,
      [connection.id, source.config.database],
    )
  }
  assert.deepEqual(await manifest(), published)
  assert.deepEqual(await detail(ordersId), orders)
  await sourcePool.query("ALTER TABLE shop.orders DROP COLUMN not_published")
})

test("cancelling a refresh stops the source query, records it, and keeps metadata", { skip }, async () => {
  const published = await manifest()
  const release = await lockOrders()
  const started = await owner.call<Ok<ManifestRefresh>>(`${manifestPath()}/refresh`, {
    method: "POST",
  })
  assert.equal(started.status, 202, started.text)
  const refresh = started.body.result
  assert.equal(refresh.status, "queued")
  try {

    // Discovery is now waiting on the source for the locked table.
    await waitFor(blockedSourceQueries, (count) => count > 0, "a blocked catalog query")
    const running = await latestRefresh()
    assert.equal(running?.id, refresh.id)
    assert.equal(running?.status, "running")
    assert.equal(running?.phase, "reading_objects")

    const second = await owner.call<Failure>(`${manifestPath()}/refresh`, { method: "POST" })
    assert.equal(second.status, 409)
    assert.equal(second.body.error.code, "CONFLICT")
    assert.equal(second.body.error.details?.refreshId, refresh.id)

    const cancelled = await owner.call<Ok<ManifestRefresh>>(
      `${manifestPath()}/refreshes/${refresh.id}/cancel`,
      { method: "POST" },
    )
    assert.equal(cancelled.status, 200, cancelled.text)
    assert.equal(cancelled.body.result.status, "cancelled")
    assert.ok(cancelled.body.result.finishedAt)

    // The catalog query was cancelled on the source while the lock is still held.
    await waitFor(blockedSourceQueries, (count) => count === 0, "the source query to be cancelled")
  } finally {
    await release()
  }

  await sleep(200)
  const recorded = await finished(refresh.id)
  assert.equal(recorded.status, "cancelled")
  assert.equal(recorded.error, null)
  assert.deepEqual(await manifest(), published)

  const again = await owner.call<Failure>(`${manifestPath()}/refreshes/${refresh.id}/cancel`, {
    method: "POST",
  })
  assert.equal(again.status, 409)

  const next = await refreshNow()
  assert.equal(next.status, "succeeded", next.error ?? "")
})

test("changing the selected schemas refreshes for the new selection", { skip }, async () => {
  const before = await manifest()
  const ticketsId = objectId(before, "support", "tickets")

  const narrowed = await owner.call<Ok<Connection>>(`${connectionsPath(acme)}/${connection.id}`, {
    method: "PATCH",
    json: { schemas: ["shop"] },
  })
  assert.equal(narrowed.status, 200, narrowed.text)
  const changed = await latestRefresh()
  assert.equal(changed?.trigger, "source_changed")
  assert.equal((await finished(changed?.id ?? "")).status, "succeeded")
  const shopOnly = await manifest()
  assert.deepEqual(
    shopOnly.schemas.map((schema) => schema.name),
    ["shop"],
  )
  assert.equal((await detail(ticketsId)).object.present, false)
  // The orders → tickets relationship is kept, marked not present.
  const orders = await detail(objectId(shopOnly, "shop", "orders"))
  assert.equal(orders.incoming.find((relationship) => relationship.from.name === "tickets")?.present, false)

  const widened = await owner.call<Ok<Connection>>(`${connectionsPath(acme)}/${connection.id}`, {
    method: "PATCH",
    json: { schemas: ["shop", "support"] },
  })
  assert.equal(widened.status, 200, widened.text)
  assert.equal((await finished((await latestRefresh())?.id ?? "")).status, "succeeded")
  const restored = await manifest()
  assert.equal(objectId(restored, "support", "tickets"), ticketsId)
  assert.equal((await detail(ticketsId)).object.present, true)
})

test("members browse but cannot refresh or cancel; others get 404", { skip }, async () => {
  const published = await manifest()
  const ordersId = objectId(published, "shop", "orders")
  const latest = await latestRefresh()
  assert.ok(latest)

  for (const path of [
    manifestPath(),
    `${manifestPath()}/objects/${ordersId}`,
    `${manifestPath()}/refreshes/latest`,
    `${manifestPath()}/refreshes/${latest.id}`,
  ]) {
    assert.equal((await member.call(path)).status, 200, path)
  }
  for (const path of [`${manifestPath()}/refresh`, `${manifestPath()}/refreshes/${latest.id}/cancel`]) {
    const res = await member.call<Failure>(path, { method: "POST" })
    assert.equal(res.status, 403, path)
    assert.equal(res.body.error.code, "FORBIDDEN")
  }

  const noCsrf = await owner.call<Failure>(`${manifestPath()}/refresh`, { method: "POST", csrf: false })
  assert.equal(noCsrf.status, 403)
  assert.equal(noCsrf.body.error.code, "CSRF_REQUIRED")

  const hidden: [string, string][] = [
    ["GET", manifestPath()],
    ["GET", `${manifestPath()}/objects/${ordersId}`],
    ["GET", `${manifestPath()}/refreshes/latest`],
    ["POST", `${manifestPath()}/refresh`],
    ["POST", `${manifestPath()}/refreshes/${latest.id}/cancel`],
  ]
  for (const [method, path] of hidden) {
    assert.equal((await outsider.call(path, { method })).status, 404, `outsider ${method} ${path}`)
  }
  // The same ids under another workspace the owner belongs to are not found.
  for (const path of [
    manifestPath(globex),
    `${manifestPath(globex)}/objects/${ordersId}`,
    `${manifestPath(globex)}/refreshes/${latest.id}`,
  ]) {
    assert.equal((await owner.call(path)).status, 404, path)
  }
  assert.equal(
    (await owner.call(`${manifestPath(globex)}/refresh`, { method: "POST" })).status,
    404,
  )
  // An object id is only found under its own source.
  assert.equal((await owner.call(`${manifestPath(acme, randomUUID())}/objects/${ordersId}`)).status, 404)

  assert.equal((await new TestClient(running.baseUrl).call(manifestPath())).status, 401)
})

test("refreshes interrupted by a restart or shutdown are recorded as failed", { skip }, async () => {
  // Shutdown: a second backend instance stops while its refresh waits on the source.
  const shutdownRunner = new RefreshRunner()
  const second = await startApp(
    createApp(env(), { pool: storage, sources: realSources, refreshes: shutdownRunner }),
  )
  const release = await lockOrders()
  const started = await owner.at(second.baseUrl).call<Ok<ManifestRefresh>>(
    `${manifestPath()}/refresh`,
    { method: "POST" },
  )
  assert.equal(started.status, 202, started.text)
  const refreshId = started.body.result.id
  try {
    await waitFor(blockedSourceQueries, (count) => count > 0, "a blocked catalog query")
    await shutdownRunner.shutdown()
  } finally {
    await release()
    await second.close()
  }
  const stopped = await finished(refreshId)
  assert.equal(stopped.status, "failed")
  assert.match(stopped.error ?? "", /backend stopped during this refresh/)

  // Restart: a run left active by a crashed process is failed at startup.
  const { rows } = await storage.query<{ id: string }>(
    `INSERT INTO manifest_refreshes (workspace_id, connection_id, status, trigger, phase, started_at)
     VALUES ($1, $2, 'running', 'manual', 'reading_columns', now()) RETURNING id`,
    [acme.id, connection.id],
  )
  const interruptedId = rows[0]?.id ?? ""
  assert.equal(await new ManifestsRepository(storage).failInterruptedRefreshes(), 1)
  const interrupted = await finished(interruptedId)
  assert.equal(interrupted.status, "failed")
  assert.match(interrupted.error ?? "", /Interrupted by a restart/)
  assert.equal((await manifest()).lastPublished?.status, "succeeded")
})

test("refresh history stays bounded and keeps the published run", { skip }, async () => {
  const published = (await manifest()).lastPublished
  assert.ok(published)
  // 25 newer finished runs push the published one out of the newest 20.
  await storage.query(
    `INSERT INTO manifest_refreshes (workspace_id, connection_id, status, trigger, created_at, finished_at)
     SELECT $1, $2, 'failed', 'manual', now() + make_interval(mins => n), now() + make_interval(mins => n)
       FROM generate_series(1, 25) AS n`,
    [acme.id, connection.id],
  )
  try {
    const repository = new ManifestsRepository(storage)
    const queued = await repository.createRefresh({
      workspaceId: acme.id,
      connectionId: connection.id,
      trigger: "manual",
      triggeredBy: null,
    })
    assert.equal(queued.status, "queued")
    await repository.finish(
      { id: queued.id, workspaceId: acme.id, connectionId: connection.id },
      { status: "cancelled", error: null },
    )
    const { rows } = await storage.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM manifest_refreshes WHERE connection_id = $1",
      [connection.id],
    )
    // The newest 20, the published run, and the new one.
    assert.equal(rows[0]?.count, 22)
    assert.equal((await manifest()).lastPublished?.id, published.id)
  } finally {
    await storage.query("DELETE FROM manifest_refreshes WHERE connection_id = $1 AND created_at > now()", [
      connection.id,
    ])
  }
})

test("without CONNECTION_ENCRYPTION_KEY manifest routes answer 503", { skip }, async () => {
  const keyless = await startApp(createApp(env(false), { pool: storage }))
  try {
    const res = await owner.at(keyless.baseUrl).call<Failure>(manifestPath())
    assert.equal(res.status, 503)
    assert.equal(res.body.error.code, "CONNECTIONS_NOT_CONFIGURED")
    assert.equal((await outsider.at(keyless.baseUrl).call(manifestPath())).status, 404)
  } finally {
    await keyless.close()
  }
})

test("the saved password never appears in responses or console output", { skip }, () => {
  const responses = [...owner.responses, ...member.responses, ...outsider.responses]
  assert.ok(responses.length > 50)
  for (const text of responses) {
    assert.ok(!text.includes(source.password), "a response included the password")
    assert.ok(!/sealed_?secret/i.test(text), "a response included the sealed secret")
  }
  for (const line of consoleCapture.lines) {
    assert.ok(!line.includes(source.password), "console output included the password")
  }
})
