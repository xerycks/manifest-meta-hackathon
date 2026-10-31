import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import test, { after, before } from "node:test"

import type { Pool } from "pg"

import { loadEnv, type Env } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import { DashboardRefresher } from "../../src/dashboards/refresh.js"
import type {
  DashboardDetail,
  DashboardPanel,
  DashboardRefresh,
  PanelData,
  PanelStatus,
} from "../../src/dashboards/schemas.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import type { ExecutionRecord } from "../../src/queries/schemas.js"
import { QueryRunner } from "../../src/queries/runner.js"
import type { SavedQueryDetail, SavedQueryRun } from "../../src/saved-queries/schemas.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { buildDemoSource } from "../../src/storage/demo-source-builder.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"
import { signIn, type TestClient, type TestResponse } from "./support/http.js"
import { manifestClient, waitFor } from "./support/manifests.js"
import { startApp, type RunningApp } from "./support/server.js"
import { sourceSettings } from "./support/source.js"
import { resetStorage } from "./support/storage.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_SOURCE_DATABASE_URL = process.env.TEST_SOURCE_DATABASE_URL
const skip = !TEST_DATABASE_URL || !TEST_SOURCE_DATABASE_URL
const SESSION_SECRET = "integration-test-secret-at-least-32-chars"

const BY_STATUS_SQL = `SELECT status, count(*)::int AS orders, sum(total) AS revenue
  FROM shop.orders GROUP BY status ORDER BY status`
/** The same rows after a pause on the source, so a run stays in flight for a while. */
const slow = (seconds: number) => `WITH pause AS (SELECT pg_sleep(${seconds}))
  SELECT status, count(*)::int AS orders, sum(total) AS revenue
    FROM shop.orders, pause GROUP BY status ORDER BY status`

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
let refresher: DashboardRefresher
let env: Env
let app: RunningApp
let owner: TestClient
let bob: TestClient
let outsider: TestClient
let acme: Workspace
let connection: Connection

const base = () => `/api/v1/workspaces/${acme.id}`
const dashboardsPath = (id = "") => `${base()}/dashboards${id ? `/${id}` : ""}`
const refreshPath = (id: string) => `${dashboardsPath(id)}/refresh`

async function savedQuery(
  name: string,
  sql: string,
  extra: Record<string, unknown> = {},
): Promise<SavedQueryDetail> {
  const res = await owner.call<Ok<SavedQueryDetail>>(`${base()}/saved-queries`, {
    method: "POST",
    json: { name, connectionId: connection.id, query: { language: "sql", sql }, ...extra },
  })
  assert.equal(res.status, 201, res.text)
  return res.body.result
}

async function runSaved(id: string): Promise<SavedQueryRun> {
  const res = await owner.call<Ok<SavedQueryRun>>(`${base()}/saved-queries/${id}/run`, {
    method: "POST",
    json: {},
  })
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.result.execution.status, "succeeded")
  return res.body.result
}

async function createDashboard(
  name: string,
  client = owner,
  visibility = "workspace",
): Promise<DashboardDetail> {
  const res = await client.call<Ok<DashboardDetail>>(dashboardsPath(), {
    method: "POST",
    json: { name, visibility },
  })
  assert.equal(res.status, 201, res.text)
  return res.body.result
}

async function added(
  dashboardId: string,
  body: Record<string, unknown>,
  client = owner,
): Promise<DashboardPanel> {
  const res = await client.call<Ok<DashboardPanel>>(`${dashboardsPath(dashboardId)}/panels`, {
    method: "POST",
    json: body,
  })
  assert.equal(res.status, 201, res.text)
  return res.body.result
}

async function dashboard(id: string, client = owner): Promise<DashboardDetail> {
  const res = await client.call<Ok<DashboardDetail>>(dashboardsPath(id))
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

async function startRefresh(id: string, client = owner, panelIds?: string[]): Promise<DashboardRefresh> {
  const res = await client.call<Ok<DashboardRefresh>>(refreshPath(id), {
    method: "POST",
    json: panelIds ? { panelIds } : {},
  })
  assert.equal(res.status, 202, res.text)
  return res.body.result
}

async function progress(id: string, client = owner): Promise<DashboardRefresh> {
  const res = await client.call<Ok<DashboardRefresh>>(refreshPath(id))
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

/** Waits until the dashboard's refresh has finished and no panel is refreshing. */
function finished(id: string, client = owner): Promise<DashboardRefresh> {
  return waitFor(
    () => progress(id, client),
    (state) => !state.active && state.panels.every((panel) => panel.status?.state !== "refreshing"),
    `the refresh of ${id} to finish`,
  )
}

function statusOf(state: DashboardRefresh | DashboardDetail, panelId: string): PanelStatus | null {
  const panel = state.panels.find((candidate) => candidate.id === panelId)
  assert.ok(panel, `panel ${panelId} is listed`)
  return panel.status
}

function latestRun(data: PanelData | null) {
  assert.equal(data?.state, "available", JSON.stringify(data))
  return (data as Extract<PanelData, { state: "available" }>).latestRun
}

async function executions(
  savedQueryId: string,
): Promise<{ id: string; origin: string; status: string; created_at: Date }[]> {
  const { rows } = await storage.query<{ id: string; origin: string; status: string; created_at: Date }>(
    `SELECT id, origin, status, created_at FROM query_executions
      WHERE workspace_id = $1 AND saved_query_id = $2 ORDER BY created_at`,
    [acme.id, savedQueryId],
  )
  return rows
}

/** Waits until this app has `count` sessions sleeping in pg_sleep on the source. */
async function sleepingOnSource(count = 1): Promise<void> {
  await waitFor(
    async () => {
      const { rows } = await sourcePool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE application_name = 'manifest-source' AND state = 'active' AND wait_event = 'PgSleep'`,
      )
      return rows[0]?.count ?? 0
    },
    (sleeping) => sleeping >= count,
    `${count} query(ies) to run on the source`,
  )
}

/** This app's sessions on the source that are running or holding a transaction open. */
async function busySourceSessions(): Promise<number> {
  const { rows } = await sourcePool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'manifest-source'
        AND state IN ('active', 'idle in transaction', 'idle in transaction (aborted)')`,
  )
  return rows[0]?.count ?? 0
}

before(async () => {
  if (skip) return
  storage = createPool(TEST_DATABASE_URL as string)
  await resetStorage(storage)
  sourcePool = createPool(TEST_SOURCE_DATABASE_URL as string)
  await buildDemoSource(sourcePool)
  const source = sourceSettings(TEST_SOURCE_DATABASE_URL as string)

  sources = createSourceAdapters()
  refreshes = new RefreshRunner()
  queries = new QueryRunner()
  // Short waits between attempts, so a refresh refused a slot retries quickly.
  refresher = new DashboardRefresher({
    concurrency: 2,
    firstDelayMs: 50,
    maxDelayMs: 200,
    busyTimeoutMs: 30_000,
  })
  env = loadEnv({
    NODE_ENV: "test",
    ALLOW_DEV_LOGIN: "true",
    SESSION_SECRET,
    CONNECTION_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  })
  app = await startApp(
    createApp(env, {
      pool: storage,
      sources,
      refreshes,
      queries,
      dashboardRefreshes: refresher,
      modelProvider: null,
    }),
  )

  owner = (await signIn(app.baseUrl, "owner@example.com", "Owner")).client
  const workspace = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
  })
  acme = workspace.body.result
  const bobSession = await signIn(app.baseUrl, "bob@example.com", "Bob")
  await new WorkspacesRepository(storage).addMember(acme.id, bobSession.context.user.id, "member")
  bob = bobSession.client
  outsider = (await signIn(app.baseUrl, "outsider@example.com", "Outsider")).client

  const saved = await owner.call<Ok<Connection>>(`${base()}/connections`, {
    method: "POST",
    json: {
      name: "Demo store (synthetic)",
      engine: "postgres",
      config: source.config,
      password: source.password,
      schemas: ["shop"],
    },
  })
  assert.equal(saved.status, 201, saved.text)
  connection = saved.body.result
  const reads = manifestClient(owner, `${base()}/connections/${connection.id}/manifest`)
  const first = await reads.latestRefresh()
  assert.ok(first)
  assert.equal((await reads.finished(first.id)).status, "succeeded")
})

after(async () => {
  if (skip) return
  await app.close()
  await refresher.shutdown()
  await queries.shutdown()
  await refreshes.shutdown()
  await closeSourceAdapters(sources)
  await sourcePool.end()
  await storage.end()
})

test(
  "panels sharing a saved query, a second viewer's refresh, and a panel refresh all join one run",
  { skip },
  async () => {
    const shared = await savedQuery("Orders by status (slow)", slow(1))
    const quick = await savedQuery("Orders by status", BY_STATUS_SQL)
    const board = await createDashboard("Refresh together")
    const bars = await added(board.id, {
      kind: "bar",
      savedQueryId: shared.id,
      config: { xColumn: "status", yColumns: ["revenue"] },
    })
    const table = await added(board.id, { kind: "table", savedQueryId: shared.id })
    const other = await added(board.id, { kind: "table", savedQueryId: quick.id })
    const note = await added(board.id, { kind: "markdown", config: { body: "Synthetic demo data." } })
    // Never run yet: stale, with no last success.
    assert.deepEqual(bars.status, { state: "stale", reason: "not_run", lastSuccessAt: null })
    assert.equal(note.status, null)

    // Any member who can view the dashboard may refresh it.
    const started = await startRefresh(board.id, bob)
    assert.equal(started.active, true)
    assert.equal(statusOf(started, bars.id)?.state, "refreshing")
    assert.equal(statusOf(started, note.id), null)
    await sleepingOnSource()
    const joined = await startRefresh(board.id, owner)
    assert.equal(statusOf(joined, table.id)?.state, "refreshing")
    await startRefresh(board.id, owner, [table.id])
    const midway = await dashboard(board.id)
    assert.equal(midway.refresh.active, true)
    assert.equal(statusOf(midway, bars.id)?.state, "refreshing")

    const done = await finished(board.id)
    const runs = await executions(shared.id)
    assert.equal(runs.length, 1, JSON.stringify(runs))
    assert.equal(runs[0]?.origin, "dashboard")
    assert.equal(runs[0]?.status, "succeeded")
    assert.equal((await executions(quick.id)).length, 1)

    const ranAt = runs[0]?.created_at.toISOString()
    assert.deepEqual(statusOf(done, bars.id), { state: "fresh", lastSuccessAt: ranAt })
    assert.deepEqual(statusOf(done, table.id), { state: "fresh", lastSuccessAt: ranAt })
    assert.equal(statusOf(done, other.id)?.state, "fresh")
    const shown = await dashboard(board.id, bob)
    assert.equal(shown.refresh.active, false)
    for (const panel of [bars, table]) {
      const current = shown.panels.find((candidate) => candidate.id === panel.id)
      assert.equal(latestRun(current?.data ?? null)?.executionId, runs[0]?.id)
    }
  },
)

test("a refresh refused a slot waits and retries instead of failing", { skip }, async () => {
  const quick = await savedQuery("Orders by status (waits)", BY_STATUS_SQL)
  const board = await createDashboard("Busy source")
  const panel = await added(board.id, { kind: "table", savedQueryId: quick.id })
  // Two console queries take both of the source's slots.
  const console = [1, 2].map(() =>
    owner.call<Ok<ExecutionRecord>>(`${base()}/connections/${connection.id}/queries`, {
      method: "POST",
      json: { id: randomUUID(), query: { language: "sql", sql: "SELECT pg_sleep(1.5)" } },
    }),
  )
  await sleepingOnSource(2)
  const started = await startRefresh(board.id)
  assert.equal(statusOf(started, panel.id)?.state, "refreshing")
  const busy = await Promise.all(console)
  for (const res of busy) assert.equal(res.body.result.status, "succeeded", res.text)

  const done = await finished(board.id)
  assert.equal(statusOf(done, panel.id)?.state, "fresh")
  const runs = await executions(quick.id)
  assert.equal(runs.length, 1)
  // It ran once a slot was free, after the console queries.
  const freed = Math.min(...busy.map((res) => Date.parse(res.body.result.finishedAt ?? "")))
  assert.ok((runs[0]?.created_at.getTime() ?? 0) >= freed - 5, "the refresh ran after a slot was freed")
})

test("a failed refresh keeps the last good result and says why", { skip }, async () => {
  const flaky = await savedQuery("Order count (flaky)", "SELECT count(*)::int AS orders FROM shop.orders")
  const good = await runSaved(flaky.id)
  const board = await createDashboard("Keeps the last good result")
  const panel = await added(board.id, {
    kind: "gauge",
    savedQueryId: flaky.id,
    config: { valueColumn: "orders", max: 1000, thresholds: [{ value: 500, status: "warning" }] },
  })
  assert.deepEqual(panel.status, { state: "fresh", lastSuccessAt: good.execution.createdAt })

  // The query now fails on the source, at run time.
  const changed = await owner.call<Ok<SavedQueryDetail>>(`${base()}/saved-queries/${flaky.id}`, {
    method: "PATCH",
    json: {
      version: flaky.version,
      query: { language: "sql", sql: "SELECT count(*) / 0 AS orders FROM shop.orders" },
    },
  })
  assert.equal(changed.status, 200, changed.text)
  await startRefresh(board.id)
  const done = await finished(board.id)
  const status = statusOf(done, panel.id)
  assert.equal(status?.state, "failed", JSON.stringify(status))
  if (status?.state !== "failed") return
  assert.equal(status.failure.code, "QUERY_FAILED")
  assert.match(status.failure.message, /division by zero/i)
  assert.equal(status.lastSuccessAt, good.execution.createdAt)

  const shown = await dashboard(board.id)
  const current = shown.panels.find((candidate) => candidate.id === panel.id)
  assert.equal(current?.status?.state, "failed")
  assert.equal(latestRun(current?.data ?? null)?.executionId, good.execution.id)
  assert.deepEqual(latestRun(current?.data ?? null)?.result.rows, good.execution.result?.rows)
})

test("cancelling a refresh stops its queries on the source", { skip }, async () => {
  const sleepy = await savedQuery("Orders by status (very slow)", slow(20))
  const board = await createDashboard("Cancel me")
  const panel = await added(board.id, { kind: "table", savedQueryId: sleepy.id })
  await startRefresh(board.id)
  await sleepingOnSource()

  const cancelled = await owner.call<Ok<DashboardRefresh>>(refreshPath(board.id), { method: "DELETE" })
  assert.equal(cancelled.status, 200, cancelled.text)
  assert.equal(cancelled.body.result.active, false)
  assert.deepEqual(statusOf(cancelled.body.result, panel.id), {
    state: "stale",
    reason: "cancelled",
    lastSuccessAt: null,
  })
  const runs = await executions(sleepy.id)
  assert.deepEqual(
    runs.map((run) => run.status),
    ["cancelled"],
  )
  await waitFor(busySourceSessions, (count) => count === 0, "no busy source sessions")
  // Nothing is left to cancel.
  const again = await owner.call<Ok<DashboardRefresh>>(refreshPath(board.id), { method: "DELETE" })
  assert.equal(again.status, 200, again.text)
  assert.equal(again.body.result.active, false)
})

test("chart panels check their columns, carry their rows, and grow to fit a new kind", { skip }, async () => {
  const byStatus = await savedQuery("Orders by status (charts)", BY_STATUS_SQL)
  const ran = await runSaved(byStatus.id)
  const board = await createDashboard("Charts")
  const unknown = await owner.call<Failure>(`${dashboardsPath(board.id)}/panels`, {
    method: "POST",
    json: {
      kind: "line",
      savedQueryId: byStatus.id,
      config: { xColumn: "status", yColumns: ["orders", "revenu"] },
    },
  })
  assert.equal(unknown.status, 422, unknown.text)
  assert.deepEqual(unknown.body.error.details, { field: "config.yColumns.1", column: "revenu" })
  const text = await owner.call<Failure>(`${dashboardsPath(board.id)}/panels`, {
    method: "POST",
    json: {
      kind: "sankey",
      savedQueryId: byStatus.id,
      config: { sourceColumn: "orders", targetColumn: "revenue", valueColumn: "status" },
    },
  })
  assert.equal(text.status, 422, text.text)
  assert.match(text.body.error.message, /a Sankey diagram needs a column of numbers/)

  const bars = await added(board.id, {
    kind: "bar",
    title: "Revenue by status",
    savedQueryId: byStatus.id,
    config: {
      xColumn: "status",
      yColumns: ["revenue", "orders"],
      sort: "value_desc",
      format: "currency",
      currency: "USD",
    },
  })
  assert.deepEqual(bars.layout, { x: 0, y: 0, w: 6, h: 4 })
  const rows = latestRun(bars.data)?.result
  assert.deepEqual(
    rows?.columns.map((column) => column.name),
    ["status", "revenue", "orders"],
  )
  assert.deepEqual(
    rows?.rows,
    ran.execution.result?.rows.map((row) => [row[0], row[2], row[1]]),
  )
  const ticker = await added(board.id, {
    kind: "ticker",
    savedQueryId: byStatus.id,
    config: { labelColumn: "status", valueColumn: "orders" },
  })
  assert.deepEqual(ticker.layout, { x: 0, y: 4, w: 12, h: 2 })

  // A note squeezed into one row grows to the bar chart's minimum when it becomes one, pushing the ticker down.
  const note = await added(board.id, { kind: "markdown", config: { body: "Synthetic." } })
  const before = await dashboard(board.id)
  const squeezed = await owner.call<Ok<DashboardDetail>>(`${dashboardsPath(board.id)}/layout`, {
    method: "PUT",
    json: {
      version: before.layoutVersion,
      boxes: [
        { panelId: bars.id, x: 0, y: 0, w: 6, h: 4 },
        { panelId: note.id, x: 10, y: 0, w: 2, h: 1 },
        { panelId: ticker.id, x: 6, y: 1, w: 6, h: 2 },
      ],
    },
  })
  assert.equal(squeezed.status, 200, squeezed.text)
  const changed = await owner.call<Ok<DashboardPanel>>(`${dashboardsPath(board.id)}/panels/${note.id}`, {
    method: "PATCH",
    json: {
      version: 1,
      kind: "bar",
      savedQueryId: byStatus.id,
      config: { xColumn: "status", yColumns: ["orders"] },
    },
  })
  assert.equal(changed.status, 200, changed.text)
  assert.deepEqual(changed.body.result.layout, { x: 9, y: 0, w: 3, h: 3 })
  const after = await dashboard(board.id)
  assert.equal(after.layoutVersion, squeezed.body.result.layoutVersion + 1)
  assert.deepEqual(after.panels.find((panel) => panel.id === ticker.id)?.layout, { x: 6, y: 3, w: 6, h: 2 })

  // A panel at the grid's last row leaves no room below it for another.
  const lowest = await owner.call<Ok<DashboardDetail>>(`${dashboardsPath(board.id)}/layout`, {
    method: "PUT",
    json: {
      version: after.layoutVersion,
      boxes: after.panels.map((panel) => ({
        panelId: panel.id,
        ...(panel.id === ticker.id ? { ...panel.layout, y: 500 } : panel.layout),
      })),
    },
  })
  assert.equal(lowest.status, 200, lowest.text)
  const noRoom = await owner.call<Failure>(`${dashboardsPath(board.id)}/panels`, {
    method: "POST",
    json: { kind: "markdown", config: { body: "One too many rows." } },
  })
  assert.equal(noRoom.status, 409, noRoom.text)
  assert.match(noRoom.body.error.message, /no room for this panel within the grid's 500 rows/)
  assert.equal((await dashboard(board.id)).panels.length, 3)
})

test(
  "refreshes need a dashboard the caller can see, panels that can run, CSRF, and the key",
  { skip },
  async () => {
    const board = await createDashboard("Permissions")
    const note = await added(board.id, { kind: "markdown", config: { body: "Notes" } })
    const needy = await savedQuery(
      "Orders since",
      "SELECT count(*)::int AS orders FROM shop.orders WHERE ordered_at >= {{since}}",
      {
        parameters: [{ name: "since", type: "date", required: true }],
      },
    )
    const needsValues = await added(board.id, { kind: "table", savedQueryId: needy.id })

    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await outsider.call(refreshPath(board.id), {
        method,
        ...(method === "POST" ? { json: {} } : {}),
      })
      assert.equal(res.status, 404, `${method}: ${res.text}`)
    }
    const secret = await createDashboard("Only mine", owner, "private")
    assert.equal((await bob.call(refreshPath(secret.id))).status, 404)
    assert.equal((await bob.call(refreshPath(secret.id), { method: "POST", json: {} })).status, 404)

    const noCsrf = await owner.call(refreshPath(board.id), { method: "POST", json: {}, csrf: false })
    assert.equal(noCsrf.status, 403)
    const markdown: Reply<DashboardRefresh> = await owner.call(refreshPath(board.id), {
      method: "POST",
      json: { panelIds: [note.id] },
    })
    assert.equal(markdown.status, 422, markdown.text)
    const withValues: Reply<DashboardRefresh> = await owner.call(refreshPath(board.id), {
      method: "POST",
      json: { panelIds: [needsValues.id] },
    })
    assert.equal(withValues.status, 422, withValues.text)
    assert.match(withValues.body.error.message, /needs parameter values/)
    const unknown = await owner.call(refreshPath(board.id), {
      method: "POST",
      json: { panelIds: [randomUUID()] },
    })
    assert.equal(unknown.status, 404, unknown.text)
    // A full refresh skips what it cannot run.
    const skipped = await startRefresh(board.id)
    assert.equal(skipped.active, false)
    assert.deepEqual(statusOf(skipped, needsValues.id), {
      state: "stale",
      reason: "not_run",
      lastSuccessAt: null,
    })

    // Without CONNECTION_ENCRYPTION_KEY, dashboards still read but cannot refresh.
    const keyless = await startApp(
      createApp(loadEnv({ NODE_ENV: "test", ALLOW_DEV_LOGIN: "true", SESSION_SECRET }), {
        pool: storage,
        modelProvider: null,
      }),
    )
    try {
      const client = owner.at(keyless.baseUrl)
      assert.equal((await client.call(dashboardsPath(board.id))).status, 200)
      const refused = await client.call<Failure>(refreshPath(board.id), { method: "POST", json: {} })
      assert.equal(refused.status, 503, refused.text)
      assert.equal(refused.body.error.code, "CONNECTIONS_NOT_CONFIGURED")
    } finally {
      await keyless.close()
    }
  },
)
