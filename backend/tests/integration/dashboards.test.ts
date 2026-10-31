import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import test, { after, before } from "node:test"

import type { Pool } from "pg"

import { loadEnv, type Env } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import type {
  DashboardDetail,
  DashboardList,
  DashboardPanel,
  PanelData,
} from "../../src/dashboards/schemas.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import { QueryRunner } from "../../src/queries/runner.js"
import type { Cell } from "../../src/queries/schemas.js"
import type { SavedQueryDetail, SavedQueryRun } from "../../src/saved-queries/schemas.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { buildDemoSource } from "../../src/storage/demo-source-builder.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"
import { signIn, type TestClient, type TestResponse } from "./support/http.js"
import { manifestClient } from "./support/manifests.js"
import { startApp, type RunningApp } from "./support/server.js"
import { sourceSettings } from "./support/source.js"
import { resetStorage } from "./support/storage.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_SOURCE_DATABASE_URL = process.env.TEST_SOURCE_DATABASE_URL
const skip = !TEST_DATABASE_URL || !TEST_SOURCE_DATABASE_URL
const SESSION_SECRET = "integration-test-secret-at-least-32-chars"

const BY_STATUS_SQL = `SELECT status, count(*)::int AS orders, sum(total) AS revenue
  FROM shop.orders GROUP BY status ORDER BY status`
const TOTALS_SQL = `SELECT count(*)::int AS orders, sum(total) AS revenue,
  sum(total) FILTER (WHERE status <> 'refunded') AS kept FROM shop.orders`

interface Ok<T> {
  result: T
}
interface Failure {
  error: { code: string; message: string; details?: Record<string, unknown> }
}
type Reply<T> = TestResponse<Ok<T> & Failure>

let storage: Pool
let sourcePool: Pool
let sources: SourceAdapters
let refreshes: RefreshRunner
let queries: QueryRunner
let env: Env
let app: RunningApp
let owner: TestClient
let admin: TestClient
let alice: TestClient
let bob: TestClient
let outsider: TestClient
let acme: Workspace
let source: ReturnType<typeof sourceSettings>
let connection: Connection
let byStatus: SavedQueryDetail
let totals: SavedQueryDetail

const base = (workspace = acme) => `/api/v1/workspaces/${workspace.id}`
const dashboardsPath = (id = "", workspace = acme) => `${base(workspace)}/dashboards${id ? `/${id}` : ""}`
const panelsPath = (dashboardId: string, panelId = "") =>
  `${dashboardsPath(dashboardId)}/panels${panelId ? `/${panelId}` : ""}`

async function saveSource(name: string): Promise<Connection> {
  const saved = await owner.call<Ok<Connection>>(`${base()}/connections`, {
    method: "POST",
    json: { name, engine: "postgres", config: source.config, password: source.password, schemas: ["shop"] },
  })
  assert.equal(saved.status, 201, saved.text)
  const reads = manifestClient(owner, `${base()}/connections/${saved.body.result.id}/manifest`)
  const first = await reads.latestRefresh()
  assert.ok(first)
  assert.equal((await reads.finished(first.id)).status, "succeeded")
  return saved.body.result
}

async function savedQuery(
  client: TestClient,
  name: string,
  sql: string,
  extra: Record<string, unknown> = {},
): Promise<SavedQueryDetail> {
  const res = await client.call<Ok<SavedQueryDetail>>(`${base()}/saved-queries`, {
    method: "POST",
    json: { name, connectionId: connection.id, query: { language: "sql", sql }, ...extra },
  })
  assert.equal(res.status, 201, res.text)
  return res.body.result
}

async function runSaved(client: TestClient, id: string): Promise<SavedQueryRun> {
  const res = await client.call<Ok<SavedQueryRun>>(`${base()}/saved-queries/${id}/run`, {
    method: "POST",
    json: {},
  })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.result.execution.status, "succeeded")
  return res.body.result
}

async function createDashboard(client: TestClient, body: Record<string, unknown>): Promise<DashboardDetail> {
  const res = await client.call<Ok<DashboardDetail>>(dashboardsPath(), { method: "POST", json: body })
  assert.equal(res.status, 201, res.text)
  return res.body.result
}

function addPanel(
  client: TestClient,
  dashboardId: string,
  body: Record<string, unknown>,
): Promise<Reply<DashboardPanel>> {
  return client.call(panelsPath(dashboardId), { method: "POST", json: body })
}

async function added(
  client: TestClient,
  dashboardId: string,
  body: Record<string, unknown>,
): Promise<DashboardPanel> {
  const res = await addPanel(client, dashboardId, body)
  assert.equal(res.status, 201, res.text)
  return res.body.result
}

async function dashboard(client: TestClient, id: string): Promise<DashboardDetail> {
  const res = await client.call<Ok<DashboardDetail>>(dashboardsPath(id))
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

function available(data: PanelData | null) {
  assert.equal(data?.state, "available", JSON.stringify(data))
  return data as Extract<PanelData, { state: "available" }>
}

/** Rows straight from the source, encoded like results (exact numerics as text). */
async function direct(sql: string): Promise<Cell[][]> {
  const { rows } = await sourcePool.query<unknown[]>({ text: sql, rowMode: "array" })
  return rows.map((row) =>
    row.map((value) => (typeof value === "number" || value === null ? value : String(value)) as Cell),
  )
}

before(async () => {
  if (skip) return
  storage = createPool(TEST_DATABASE_URL as string)
  await resetStorage(storage)
  sourcePool = createPool(TEST_SOURCE_DATABASE_URL as string)
  await buildDemoSource(sourcePool)
  source = sourceSettings(TEST_SOURCE_DATABASE_URL as string)

  sources = createSourceAdapters()
  refreshes = new RefreshRunner()
  queries = new QueryRunner()
  env = loadEnv({
    NODE_ENV: "test",
    ALLOW_DEV_LOGIN: "true",
    SESSION_SECRET,
    CONNECTION_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  })
  app = await startApp(createApp(env, { pool: storage, sources, refreshes, queries, modelProvider: null }))

  owner = (await signIn(app.baseUrl, "owner@example.com", "Owner")).client
  const workspace = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
  })
  acme = workspace.body.result
  const workspaces = new WorkspacesRepository(storage)
  const join = async (email: string, name: string, role: "admin" | "member") => {
    const session = await signIn(app.baseUrl, email, name)
    await workspaces.addMember(acme.id, session.context.user.id, role)
    return session.client
  }
  admin = await join("admin@example.com", "Admin", "admin")
  alice = await join("alice@example.com", "Alice", "member")
  bob = await join("bob@example.com", "Bob", "member")
  outsider = (await signIn(app.baseUrl, "outsider@example.com", "Outsider")).client

  connection = await saveSource("Demo store (synthetic)")
  byStatus = await savedQuery(owner, "Orders by status", BY_STATUS_SQL)
  totals = await savedQuery(owner, "Order totals", TOTALS_SQL)
  await runSaved(owner, byStatus.id)
  await runSaved(owner, totals.id)
})

after(async () => {
  if (skip) return
  await app.close()
  await queries.shutdown()
  await refreshes.shutdown()
  await closeSourceAdapters(sources)
  await storage.end()
  await sourcePool.end()
})

test(
  "a dashboard of number, table, and Markdown panels from saved queries reads back the same after a restart",
  { skip },
  async () => {
    const created = await createDashboard(owner, {
      name: "Store overview",
      description: "Orders and revenue **at a glance**.",
    })
    assert.equal(created.visibility, "workspace")
    assert.equal(created.version, 1)
    assert.deepEqual(created.panels, [])

    const number = await added(owner, created.id, {
      kind: "number",
      title: "Revenue",
      savedQueryId: totals.id,
      config: {
        valueColumn: "revenue",
        comparisonColumn: "kept",
        format: "currency",
        currency: "USD",
        decimals: 2,
      },
    })
    // New panels go below the others at their kind's default size.
    assert.deepEqual(number.layout, { x: 0, y: 0, w: 3, h: 2 })
    assert.equal(number.version, 1)
    assert.deepEqual(number.config, {
      valueColumn: "revenue",
      comparisonColumn: "kept",
      format: "currency",
      decimals: 2,
      currency: "USD",
    })
    const numberData = available(number.data)
    assert.deepEqual(numberData.savedQuery, {
      id: totals.id,
      name: "Order totals",
      source: { id: connection.id, name: "Demo store (synthetic)", engine: "postgres" },
      visibility: "workspace",
      lastRunAt: numberData.savedQuery.lastRunAt,
      needsValues: false,
    })
    // Only the columns it shows, from the pinned latest result, with exact numerics.
    const [directTotals] = await direct(TOTALS_SQL)
    assert.deepEqual(
      numberData.latestRun?.result.columns.map((column) => [column.name, column.kind]),
      [
        ["revenue", "decimal"],
        ["kept", "decimal"],
      ],
    )
    assert.deepEqual(numberData.latestRun?.result.rows, [[directTotals?.[1], directTotals?.[2]]])
    const latest = (await owner.call<Ok<SavedQueryDetail>>(`${base()}/saved-queries/${totals.id}`)).body
      .result
    assert.equal(numberData.latestRun?.executionId, latest.lastExecutionId)
    assert.equal(numberData.latestRun?.createdAt, latest.latestRun?.createdAt)

    const table = await added(owner, created.id, {
      kind: "table",
      savedQueryId: byStatus.id,
      config: { columns: ["revenue", "status"] },
    })
    assert.deepEqual(table.layout, { x: 0, y: 2, w: 12, h: 4 })
    assert.equal(table.title, "")
    assert.deepEqual(
      available(table.data).latestRun?.result.rows,
      (await direct(BY_STATUS_SQL)).map((row) => [row[2], row[0]]),
    )
    const notes = await added(owner, created.id, {
      kind: "markdown",
      title: "How to read this",
      config: { body: "Revenue counts **every** order; *kept* leaves out refunds." },
    })
    assert.equal(notes.data, null)
    assert.equal(notes.savedQueryId, null)
    const neverRun = await savedQuery(
      owner,
      "Customers by country",
      "SELECT country, count(*)::int AS customers FROM shop.customers GROUP BY 1 ORDER BY 1",
    )
    const waiting = await added(owner, created.id, { kind: "table", savedQueryId: neverRun.id })
    assert.equal(available(waiting.data).latestRun, null)

    const shown = await dashboard(owner, created.id)
    assert.deepEqual(
      shown.panels.map((panel) => [panel.id, panel.kind, panel.layout]),
      [
        [number.id, "number", { x: 0, y: 0, w: 3, h: 2 }],
        [table.id, "table", { x: 0, y: 2, w: 12, h: 4 }],
        [notes.id, "markdown", { x: 0, y: 6, w: 4, h: 2 }],
        [waiting.id, "table", { x: 0, y: 8, w: 12, h: 4 }],
      ],
    )
    assert.deepEqual(shown.panels[0], number)
    assert.ok(shown.updatedAt >= created.updatedAt)

    // A fresh backend over the same storage serves the same dashboard.
    const restarted = await startApp(
      createApp(env, { pool: storage, sources, refreshes, queries, modelProvider: null }),
    )
    try {
      assert.deepEqual(await dashboard(owner.at(restarted.baseUrl), created.id), shown)
    } finally {
      await restarted.close()
    }
    // Any member sees the same content.
    assert.deepEqual(await dashboard(bob, created.id), shown)

    const listed = await bob.call<Ok<DashboardList>>(dashboardsPath())
    assert.equal(listed.status, 200, listed.text)
    const summary = listed.body.result.dashboards.find((item) => item.id === created.id)
    assert.equal(summary?.panelCount, 4)
    assert.equal(summary?.excerpt, "Orders and revenue at a glance.")
    assert.equal(summary?.createdBy?.name, "Owner")

    // Run now reuses the saved query's run route; the panel then shows that run.
    const run = await runSaved(bob, neverRun.id)
    const ran = available((await dashboard(owner, created.id)).panels[3]?.data ?? null)
    assert.equal(ran.latestRun?.executionId, run.execution.id)
    assert.equal(ran.latestRun?.createdAt, run.execution.createdAt)
    assert.deepEqual(ran.latestRun?.result.rows, run.execution.result?.rows)

    // The layout is saved whole and orders the panels top to bottom, then left to right.
    const layoutPath = `${dashboardsPath(created.id)}/layout`
    const boxes = [
      { panelId: number.id, x: 0, y: 0, w: 3, h: 2 },
      { panelId: notes.id, x: 3, y: 0, w: 9, h: 2 },
      { panelId: waiting.id, x: 0, y: 2, w: 6, h: 4 },
      { panelId: table.id, x: 6, y: 2, w: 6, h: 4 },
    ]
    const laidOut = await owner.call<Ok<DashboardDetail>>(layoutPath, {
      method: "PUT",
      json: { version: shown.layoutVersion, boxes },
    })
    assert.equal(laidOut.status, 200, laidOut.text)
    assert.equal(laidOut.body.result.layoutVersion, shown.layoutVersion + 1)
    assert.equal(laidOut.body.result.version, shown.version)
    const order = [number.id, notes.id, waiting.id, table.id]
    assert.deepEqual(
      laidOut.body.result.panels.map((panel) => [panel.id, panel.layout]),
      order.map((id) => {
        const { panelId: _panelId, ...layout } = boxes.find((item) => item.panelId === id) ?? {}
        return [id, layout]
      }),
    )
    const outdated = await owner.call<Failure>(layoutPath, {
      method: "PUT",
      json: { version: shown.layoutVersion, boxes },
    })
    assert.equal(outdated.status, 409, outdated.text)
    assert.deepEqual(
      (outdated.body.error.details?.current as DashboardDetail).panels.map((panel) => panel.id),
      order,
    )
    const version = laidOut.body.result.layoutVersion
    const missing = await owner.call<Failure>(layoutPath, {
      method: "PUT",
      json: { version, boxes: boxes.slice(1) },
    })
    assert.equal(missing.status, 409, missing.text)
    const overlapping = await owner.call<Failure>(layoutPath, {
      method: "PUT",
      json: { version, boxes: boxes.map((item) => (item.panelId === table.id ? { ...item, x: 5 } : item)) },
    })
    assert.equal(overlapping.status, 422, overlapping.text)
    assert.equal(overlapping.body.error.message, "Panels cannot overlap.")
    const cramped = await owner.call<Failure>(layoutPath, {
      method: "PUT",
      json: { version, boxes: boxes.map((item) => (item.panelId === table.id ? { ...item, h: 2 } : item)) },
    })
    assert.equal(cramped.status, 422, cramped.text)
    assert.deepEqual(cramped.body.error.details, { field: "boxes", panelId: table.id })
    const offGrid = await owner.call<Failure>(layoutPath, {
      method: "PUT",
      json: { version, boxes: boxes.map((item) => (item.panelId === table.id ? { ...item, x: 7 } : item)) },
    })
    assert.equal(offGrid.status, 422, offGrid.text)
    assert.match(offGrid.body.error.message, /fit within the 12 columns/)
    // A fresh backend serves the saved layout.
    const again = await startApp(
      createApp(env, { pool: storage, sources, refreshes, queries, modelProvider: null }),
    )
    try {
      assert.deepEqual(
        (await dashboard(owner.at(again.baseUrl), created.id)).panels.map((panel) => [
          panel.id,
          panel.layout,
        ]),
        laidOut.body.result.panels.map((panel) => [panel.id, panel.layout]),
      )
    } finally {
      await again.close()
    }

    // Panel edits name the version they started from.
    const edited = await owner.call<Ok<DashboardPanel>>(panelsPath(created.id, table.id), {
      method: "PATCH",
      json: { version: 1, title: "By status", config: { columns: ["status", "orders"] } },
    })
    assert.equal(edited.status, 200, edited.text)
    assert.equal(edited.body.result.version, 2)
    assert.deepEqual(
      available(edited.body.result.data).latestRun?.result.columns.map((column) => column.name),
      ["status", "orders"],
    )
    const stale = await owner.call<Failure>(panelsPath(created.id, table.id), {
      method: "PATCH",
      json: { version: 1, title: "Overwrite" },
    })
    assert.equal(stale.status, 409, stale.text)
    assert.equal((stale.body.error.details?.current as DashboardPanel).title, "By status")
    // A kind change is checked as a whole definition of the new kind.
    const asNumber = await owner.call<Failure>(panelsPath(created.id, table.id), {
      method: "PATCH",
      json: { version: 2, kind: "number" },
    })
    assert.equal(asNumber.status, 422, asNumber.text)
    const asMarkdown = await owner.call<Ok<DashboardPanel>>(panelsPath(created.id, table.id), {
      method: "PATCH",
      json: { version: 2, kind: "markdown", config: { body: "Moved to its own page." } },
    })
    assert.equal(asMarkdown.status, 200, asMarkdown.text)
    assert.equal(asMarkdown.body.result.savedQueryId, null)
    assert.equal(asMarkdown.body.result.data, null)

    const removed = await owner.call(panelsPath(created.id, table.id), { method: "DELETE" })
    assert.equal(removed.status, 200, removed.text)
    assert.equal((await owner.call(panelsPath(created.id, table.id), { method: "DELETE" })).status, 404)
    assert.deepEqual(
      (await dashboard(owner, created.id)).panels.map((panel) => panel.id),
      [number.id, notes.id, waiting.id],
    )

    // Renaming needs the current version; a stale save gets the current dashboard.
    const renamed = await owner.call<Ok<DashboardDetail>>(dashboardsPath(created.id), {
      method: "PATCH",
      json: { version: 1, name: "Store at a glance", description: "" },
    })
    assert.equal(renamed.status, 200, renamed.text)
    assert.equal(renamed.body.result.version, 2)
    assert.equal(renamed.body.result.panels.length, 3)
    const staleRename = await owner.call<Failure>(dashboardsPath(created.id), {
      method: "PATCH",
      json: { version: 1, name: "Overwrite" },
    })
    assert.equal(staleRename.status, 409, staleRename.text)
    assert.equal((staleRename.body.error.details?.current as DashboardDetail).name, "Store at a glance")
    const taken = await alice.call<Failure>(dashboardsPath(), {
      method: "POST",
      json: { name: "STORE AT A GLANCE" },
    })
    assert.equal(taken.status, 409, taken.text)

    const deleted = await owner.call(dashboardsPath(created.id), { method: "DELETE" })
    assert.equal(deleted.status, 200, deleted.text)
    assert.equal((await owner.call(dashboardsPath(created.id))).status, 404)
    const { rows } = await storage.query("SELECT 1 FROM dashboard_panels WHERE dashboard_id = $1", [
      created.id,
    ])
    assert.equal(rows.length, 0)
    // The saved queries the panels showed stay.
    assert.equal((await owner.call(`${base()}/saved-queries/${totals.id}`)).status, 200)
  },
)

test("panel configs are checked against the saved query's latest result", { skip }, async () => {
  const board = await createDashboard(alice, { name: "Checks" })
  const unknown = await addPanel(alice, board.id, {
    kind: "number",
    savedQueryId: totals.id,
    config: { valueColumn: "revenu" },
  })
  assert.equal(unknown.status, 422, unknown.text)
  assert.equal(unknown.body.error.code, "VALIDATION_FAILED")
  assert.equal(
    unknown.body.error.message,
    "The latest result has no column “revenu”. Its columns are: orders, revenue, kept.",
  )
  assert.deepEqual(unknown.body.error.details, { field: "config.valueColumn", column: "revenu" })
  const text = await addPanel(alice, board.id, {
    kind: "number",
    savedQueryId: byStatus.id,
    config: { valueColumn: "status" },
  })
  assert.equal(text.status, 422, text.text)
  assert.match(text.body.error.message, /“status” holds text values/)
  const missingColumn = await addPanel(alice, board.id, {
    kind: "table",
    savedQueryId: byStatus.id,
    config: { columns: ["status", "profit"] },
  })
  assert.equal(missingColumn.status, 422, missingColumn.text)
  assert.deepEqual(missingColumn.body.error.details, { field: "config.columns.1", column: "profit" })

  const badFormat = await addPanel(alice, board.id, {
    kind: "number",
    savedQueryId: totals.id,
    config: { valueColumn: "revenue", format: "scientific" },
  })
  assert.equal(badFormat.status, 422, badFormat.text)
  const issues = badFormat.body.error.details?.issues as { path: string }[]
  assert.deepEqual(
    issues.map((issue) => issue.path),
    ["config.format"],
  )
  const noCurrency = await addPanel(alice, board.id, {
    kind: "number",
    savedQueryId: totals.id,
    config: { valueColumn: "revenue", format: "currency" },
  })
  assert.equal(noCurrency.status, 422, noCurrency.text)
  const long = await addPanel(alice, board.id, { kind: "markdown", config: { body: "x".repeat(4_001) } })
  assert.equal(long.status, 422, long.text)
  assert.match(JSON.stringify(long.body.error.details), /at most 4,000 characters/)
  const atLimit = await addPanel(alice, board.id, { kind: "markdown", config: { body: "x".repeat(4_000) } })
  assert.equal(atLimit.status, 201, atLimit.text)
  // Text stored escaped, at 6 bytes a character, still fits; what jsonb cannot hold is refused.
  const escaped = await addPanel(alice, board.id, {
    kind: "markdown",
    config: { body: "\u0001".repeat(4_000) },
  })
  assert.equal(escaped.status, 201, escaped.text)
  const unpaired = await addPanel(alice, board.id, { kind: "markdown", config: { body: "half \ud800 pair" } })
  assert.equal(unpaired.status, 422, unpaired.text)

  // An unknown saved query, or one from nowhere in this workspace, is refused.
  const nowhere = await addPanel(alice, board.id, { kind: "table", savedQueryId: randomUUID() })
  assert.equal(nowhere.status, 422, nowhere.text)
  assert.deepEqual(nowhere.body.error.details, { field: "savedQueryId" })

  // Without a stored result there is nothing to check columns against yet.
  const fresh = await savedQuery(alice, "Not run yet", "SELECT count(*)::int AS orders FROM shop.orders")
  const unchecked = await addPanel(alice, board.id, {
    kind: "number",
    savedQueryId: fresh.id,
    config: { valueColumn: "anything" },
  })
  assert.equal(unchecked.status, 201, unchecked.text)
  // The largest table config fits as well, even stored escaped.
  const columns = Array.from({ length: 50 }, (_, index) => String(index).padEnd(300, "\u0002"))
  const wide = await addPanel(alice, board.id, { kind: "table", savedQueryId: fresh.id, config: { columns } })
  assert.equal(wide.status, 201, wide.text)
})

test(
  "private dashboards are their creator's alone; members change only their own; outsiders get 404",
  { skip },
  async () => {
    const secret = await createDashboard(alice, { name: "Alice's private board", visibility: "private" })
    await added(alice, secret.id, { kind: "markdown", config: { body: "Only for me." } })
    // Owners and admins cannot see private dashboards either: 404, as if they did not exist.
    for (const client of [bob, owner, admin]) {
      assert.equal((await client.call(dashboardsPath(secret.id))).status, 404)
      const list = await client.call<Ok<DashboardList>>(dashboardsPath())
      assert.ok(!list.body.result.dashboards.some((item) => item.id === secret.id))
      const edit = await client.call(dashboardsPath(secret.id), {
        method: "PATCH",
        json: { version: 1, name: "x" },
      })
      assert.equal(edit.status, 404)
      assert.equal((await client.call(dashboardsPath(secret.id), { method: "DELETE" })).status, 404)
      assert.equal(
        (await addPanel(client, secret.id, { kind: "markdown", config: { body: "x" } })).status,
        404,
      )
    }
    assert.equal((await dashboard(alice, secret.id)).panels.length, 1)

    const shared = await createDashboard(alice, { name: "Alice's shared board" })
    const note = await added(alice, shared.id, { kind: "markdown", config: { body: "Shared notes." } })
    assert.equal((await dashboard(bob, shared.id)).name, "Alice's shared board")
    // Another member views it but cannot change it or its panels.
    const forbidden = [
      bob.call(dashboardsPath(shared.id), { method: "PATCH", json: { version: 1, name: "Bob's now" } }),
      bob.call(dashboardsPath(shared.id), { method: "DELETE" }),
      addPanel(bob, shared.id, { kind: "markdown", config: { body: "Bob was here" } }),
      bob.call(panelsPath(shared.id, note.id), { method: "PATCH", json: { version: 1, title: "x" } }),
      bob.call(panelsPath(shared.id, note.id), { method: "DELETE" }),
      bob.call(`${dashboardsPath(shared.id)}/layout`, {
        method: "PUT",
        json: { version: 1, boxes: [{ panelId: note.id, x: 2, y: 0, w: 4, h: 2 }] },
      }),
    ]
    for (const res of await Promise.all(forbidden)) assert.equal(res.status, 403, res.text)
    // An admin may.
    const byAdmin = await admin.call<Ok<DashboardDetail>>(dashboardsPath(shared.id), {
      method: "PATCH",
      json: { version: 1, description: "Kept tidy by an admin." },
    })
    assert.equal(byAdmin.status, 200, byAdmin.text)
    assert.equal(byAdmin.body.result.updatedBy?.name, "Admin")

    // Mutations need the CSRF header; outsiders see nothing.
    const noCsrf = await alice.call<Failure>(dashboardsPath(), {
      method: "POST",
      json: { name: "x" },
      csrf: false,
    })
    assert.equal(noCsrf.body.error.code, "CSRF_REQUIRED")
    assert.equal((await outsider.call(dashboardsPath())).status, 404)
    assert.equal((await outsider.call(dashboardsPath(shared.id))).status, 404)
    assert.equal(
      (await addPanel(outsider, shared.id, { kind: "markdown", config: { body: "x" } })).status,
      404,
    )

    // A private saved query only goes on a private dashboard.
    const mine = await savedQuery(alice, "Alice's private totals", TOTALS_SQL, { visibility: "private" })
    const onShared = await addPanel(alice, shared.id, {
      kind: "number",
      savedQueryId: mine.id,
      config: { valueColumn: "orders" },
    })
    assert.equal(onShared.status, 422, onShared.text)
    assert.match(onShared.body.error.message, /visible only to you/)
    // Others cannot use it at all.
    const bobsBoard = await createDashboard(bob, { name: "Bob's board", visibility: "private" })
    const notVisible = await addPanel(bob, bobsBoard.id, { kind: "table", savedQueryId: mine.id })
    assert.equal(notVisible.status, 422, notVisible.text)
    await added(alice, secret.id, {
      kind: "number",
      savedQueryId: mine.id,
      config: { valueColumn: "orders" },
    })
    const share = await alice.call<Failure>(dashboardsPath(secret.id), {
      method: "PATCH",
      json: { version: 1, visibility: "workspace" },
    })
    assert.equal(share.status, 422, share.text)
    assert.match(share.body.error.message, /“Alice's private totals”/)
    // Someone else's saved query made private later does not hold sharing back, and is never named.
    const bobs = await savedQuery(bob, "Bob's soon private query", BY_STATUS_SQL)
    const draft = await createDashboard(alice, { name: "Alice's draft board", visibility: "private" })
    await added(alice, draft.id, { kind: "table", savedQueryId: bobs.id })
    const bobHides = await bob.call(`${base()}/saved-queries/${bobs.id}`, {
      method: "PATCH",
      json: { version: 1, visibility: "private" },
    })
    assert.equal(bobHides.status, 200, bobHides.text)
    const shareDraft = await alice.call<Ok<DashboardDetail>>(dashboardsPath(draft.id), {
      method: "PATCH",
      json: { version: 1, visibility: "workspace" },
    })
    assert.equal(shareDraft.status, 200, shareDraft.text)
    assert.deepEqual(shareDraft.body.result.panels[0]?.data, { state: "private" })
    assert.ok(!shareDraft.text.includes("Bob's soon private query"))

    // A saved query made private later shows as private to everyone else, without its rows.
    const later = await savedQuery(alice, "Alice's soon private query", BY_STATUS_SQL)
    await runSaved(alice, later.id)
    const panel = await added(alice, shared.id, { kind: "table", savedQueryId: later.id })
    assert.equal(available(panel.data).latestRun?.result.rows.length, (await direct(BY_STATUS_SQL)).length)
    const hidden = await alice.call(`${base()}/saved-queries/${later.id}`, {
      method: "PATCH",
      json: { version: 1, visibility: "private" },
    })
    assert.equal(hidden.status, 200, hidden.text)
    const asBob = (await dashboard(bob, shared.id)).panels.find((item) => item.id === panel.id)
    assert.deepEqual(asBob?.data, { state: "private" })
    // Not even its id is shown.
    assert.equal(asBob?.savedQueryId, null)
    assert.ok(
      available(
        (await dashboard(alice, shared.id)).panels.find((item) => item.id === panel.id)?.data ?? null,
      ),
    )
    // It stays private, not removed, once its creator's account is gone.
    await storage.query("UPDATE saved_queries SET created_by = NULL WHERE id = $1", [later.id])
    const orphaned = (await dashboard(bob, shared.id)).panels.find((item) => item.id === panel.id)
    assert.deepEqual(orphaned?.data, { state: "private" })
  },
)

test("a dashboard holds at most 30 panels and a workspace at most 200 dashboards", { skip }, async () => {
  const board = await createDashboard(bob, { name: "Crowded" })
  for (let index = 0; index < 30; index += 1) {
    await added(bob, board.id, { kind: "markdown", config: { body: `Note ${index + 1}` } })
  }
  const full = await addPanel(bob, board.id, { kind: "markdown", config: { body: "One too many" } })
  assert.equal(full.status, 409, full.text)
  assert.match(full.body.error.message, /at most 30 panels/)
  assert.equal((await dashboard(bob, board.id)).panels.length, 30)

  const created = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Busy", slug: "busy" },
  })
  const busy = created.body.result
  await storage.query(
    `INSERT INTO dashboards (workspace_id, name) SELECT $1, 'Board ' || n FROM generate_series(1, 199) AS n`,
    [busy.id],
  )
  const last = await owner.call(dashboardsPath("", busy), { method: "POST", json: { name: "Board 200" } })
  assert.equal(last.status, 201, last.text)
  const over = await owner.call<Failure>(dashboardsPath("", busy), {
    method: "POST",
    json: { name: "Board 201" },
  })
  assert.equal(over.status, 409, over.text)
  assert.match(over.body.error.message, /at most 200 dashboards/)
  const listed = await owner.call<Ok<DashboardList>>(dashboardsPath("", busy))
  assert.equal(listed.body.result.dashboards.length, 200)
})

test("deleting a saved query, or its source, leaves its panels saying it was removed", { skip }, async () => {
  const board = await createDashboard(owner, { name: "Removals" })
  const doomed = await savedQuery(bob, "Bob's revenue", TOTALS_SQL)
  await runSaved(bob, doomed.id)
  const config = {
    valueColumn: "revenue",
    comparisonColumn: null,
    format: "number",
    decimals: 0,
    currency: null,
  }
  const panel = await added(owner, board.id, { kind: "number", savedQueryId: doomed.id, config })

  const deleted = await bob.call(`${base()}/saved-queries/${doomed.id}`, { method: "DELETE" })
  assert.equal(deleted.status, 200, deleted.text)
  const orphan = (await dashboard(owner, board.id)).panels[0]
  assert.equal(orphan?.savedQueryId, null)
  assert.deepEqual(orphan?.data, { state: "removed" })
  assert.deepEqual(orphan?.config, config)
  // It needs another saved query before it can be changed.
  const retitle = await owner.call<Failure>(panelsPath(board.id, panel.id), {
    method: "PATCH",
    json: { version: 1, title: "Revenue" },
  })
  assert.equal(retitle.status, 422, retitle.text)
  const repointed = await owner.call<Ok<DashboardPanel>>(panelsPath(board.id, panel.id), {
    method: "PATCH",
    json: { version: 1, savedQueryId: totals.id },
  })
  assert.equal(repointed.status, 200, repointed.text)
  assert.equal(available(repointed.body.result.data).savedQuery.id, totals.id)

  const copy = await saveSource("Removed copy")
  const onCopy = await owner.call<Ok<SavedQueryDetail>>(`${base()}/saved-queries`, {
    method: "POST",
    json: { name: "On the copy", connectionId: copy.id, query: { language: "sql", sql: BY_STATUS_SQL } },
  })
  assert.equal(onCopy.status, 201, onCopy.text)
  const copyPanel = await added(owner, board.id, { kind: "table", savedQueryId: onCopy.body.result.id })
  assert.equal((await owner.call(`${base()}/connections/${copy.id}`, { method: "DELETE" })).status, 200)
  const gone = (await dashboard(owner, board.id)).panels.find((item) => item.id === copyPanel.id)
  assert.deepEqual(gone?.data, { state: "removed" })
})

test(
  "dashboards show stored results without the encryption key; running a panel needs it",
  { skip },
  async () => {
    const board = await createDashboard(owner, { name: "Keyless" })
    const panel = await added(owner, board.id, { kind: "table", savedQueryId: byStatus.id })
    const keyless = await startApp(
      createApp(loadEnv({ NODE_ENV: "test", SESSION_SECRET }), { pool: storage }),
    )
    try {
      const shown = await owner.at(keyless.baseUrl).call<Ok<DashboardDetail>>(dashboardsPath(board.id))
      assert.equal(shown.status, 200, shown.text)
      assert.deepEqual(shown.body.result.panels[0]?.data, panel.data)
      const run = await owner
        .at(keyless.baseUrl)
        .call<Failure>(`${base()}/saved-queries/${byStatus.id}/run`, {
          method: "POST",
          json: {},
        })
      assert.equal(run.body.error.code, "CONNECTIONS_NOT_CONFIGURED")
    } finally {
      await keyless.close()
    }
  },
)
