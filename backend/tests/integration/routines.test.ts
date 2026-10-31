import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import test, { after, before, beforeEach } from "node:test"

import type { Pool } from "pg"

import type { AgentRun, ConversationPage } from "../../src/agent/contracts.js"
import { AgentRunner } from "../../src/agent/runner.js"
import { ScriptedProvider, type ScriptedTurn, type ScriptView } from "../../src/agent/scripted.js"
import { loadEnv } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import { QueryRunner } from "../../src/queries/runner.js"
import { RoutineDispatcher } from "../../src/routines/dispatcher.js"
import { RoutinesRepository } from "../../src/routines/repository.js"
import {
  ROUTINE_LIMITS,
  type RoutineDetail,
  type RoutineList,
  type RoutineRun,
  type RoutineRunPage,
  type SchedulePreview,
} from "../../src/routines/schemas.js"
import type { SavedQueryDetail } from "../../src/saved-queries/schemas.js"
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
const KEY = randomBytes(32).toString("hex")

const BY_STATUS_SQL =
  "SELECT status, count(*)::int AS orders FROM shop.orders GROUP BY status ORDER BY status"
const SINCE_SQL = "SELECT count(*)::int AS orders FROM shop.orders WHERE ordered_at >= {{since}}"
/** Valid to save, but fails on the source every time it runs. */
const FAILING_SQL = "SELECT 1 / (count(*) - count(*)) AS boom FROM shop.orders"
const SLOW_SQL = "WITH pause AS (SELECT pg_sleep(2)) SELECT count(*)::int AS orders FROM shop.orders, pause"

interface Ok<T> {
  result: T
}
interface Failure {
  error: { code: string; message: string; details?: Record<string, unknown> }
}
type Reply<T> = TestResponse<Ok<T> & Failure>

/** One backend process: an app, its dispatcher, and its query runner. */
interface Backend {
  app: RunningApp
  dispatcher: RoutineDispatcher
  queries: QueryRunner
  agents: AgentRunner
}

let storage: Pool
let sourcePool: Pool
let sources: SourceAdapters
let refreshes: RefreshRunner
const backends: Backend[] = []
let main: Backend
let owner: TestClient
let bob: TestClient
let bobId: string
let carol: TestClient
let outsider: TestClient
let acme: Workspace
let connection: Connection
let ownerId: string

/** The clock every dispatcher reads schedules with: Monday 2 November 2026, 08:58 UTC to start. */
let clock = Date.parse("2026-11-02T08:58:00Z")
const setClock = (iso: string) => {
  clock = Date.parse(iso)
}

const base = () => `/api/v1/workspaces/${acme.id}`
const routinesPath = (sub = "") => `${base()}/routines${sub}`

const call = (name: string, input: unknown) => ({ name, input })
const executionOf = (view: ScriptView) =>
  String((view.last("run_query")?.output as { executionId?: string } | undefined)?.executionId)
const submit = (markdown: string, evidence: { executionId: string; label: string }[] = []): ScriptedTurn => ({
  calls: [call("submit_answer", { markdown, status: "complete", evidence })],
})

/** Test scenarios, chosen by a [tag] in the question. */
const SCENARIOS: Record<string, (view: ScriptView) => ScriptedTurn> = {
  count(view) {
    if (view.turn === 0) {
      return {
        calls: [
          call("run_query", {
            connectionId: connection.id,
            query: { language: "sql", sql: "SELECT count(*) AS orders FROM shop.orders" },
            purpose: "Count orders",
          }),
        ],
      }
    }
    return submit("There are orders (synthetic).", [{ executionId: executionOf(view), label: "Orders" }])
  },
  ask(view) {
    if (view.turn === 0) return { calls: [call("ask_user", { question: "Which month do you mean?" })] }
    return submit("Noted.")
  },
}

const scripted = new ScriptedProvider("test script", (view) => {
  const tag = /\[(\w+)\]/.exec(view.question)?.[1] ?? ""
  const scenario = SCENARIOS[tag]
  if (!scenario) throw new Error(`No test scenario for: ${view.question}`)
  return scenario(view)
})

/** Starts a backend process on the shared storage, with its own dispatcher on the shared clock. */
async function serve(options: { modelProvider?: ScriptedProvider | null } = {}): Promise<Backend> {
  const dispatcher = new RoutineDispatcher({
    now: () => clock,
    concurrency: 4,
    firstDelayMs: 20,
    maxDelayMs: 100,
    busyTimeoutMs: 10_000,
  })
  const queries = new QueryRunner()
  const agents = new AgentRunner()
  const app = await startApp(
    createApp(
      loadEnv({ NODE_ENV: "test", ALLOW_DEV_LOGIN: "true", SESSION_SECRET, CONNECTION_ENCRYPTION_KEY: KEY }),
      {
        pool: storage,
        sources,
        refreshes,
        queries,
        agents,
        routineDispatcher: dispatcher,
        modelProvider: options.modelProvider === undefined ? scripted : options.modelProvider,
      },
    ),
  )
  const backend = { app, dispatcher, queries, agents }
  backends.push(backend)
  return backend
}

/** Claims what is due on these backends at once, and waits for the runs they started. */
async function tick(...on: Backend[]): Promise<void> {
  const targets = on.length > 0 ? on : [main]
  await Promise.all(targets.map((backend) => backend.dispatcher.tick()))
  await Promise.all(targets.map((backend) => backend.dispatcher.drained()))
}

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

async function createRoutine(body: Record<string, unknown>, client = owner): Promise<RoutineDetail> {
  const res = await client.call<Ok<RoutineDetail>>(routinesPath(), { method: "POST", json: body })
  assert.equal(res.status, 201, res.text)
  return res.body.result
}

const savedQueryRoutine = (name: string, savedQueryId: string, extra: Record<string, unknown> = {}) =>
  createRoutine({ name, kind: "saved_query", savedQueryId, cron: "*/5 * * * *", timeZone: "UTC", ...extra })

async function routine(id: string, client = owner): Promise<RoutineDetail> {
  const res = await client.call<Ok<RoutineDetail>>(routinesPath(`/${id}`))
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

async function runs(id: string, client = owner): Promise<RoutineRun[]> {
  const res = await client.call<Ok<RoutineRunPage>>(routinesPath(`/${id}/runs?limit=100`))
  assert.equal(res.status, 200, res.text)
  return res.body.result.runs
}

async function action(id: string, name: "pause" | "resume", client = owner): Promise<Reply<RoutineDetail>> {
  return client.call<Ok<RoutineDetail> & Failure>(routinesPath(`/${id}/${name}`), { method: "POST" })
}

async function runNow(id: string, mutationId = randomUUID(), client = owner): Promise<Reply<RoutineRun>> {
  return client.call<Ok<RoutineRun> & Failure>(routinesPath(`/${id}/run`), {
    method: "POST",
    json: { mutationId },
  })
}

interface ExecutionRow {
  origin: string
  user_id: string
  saved_query_id: string
  parameters: unknown
}

async function execution(id: string): Promise<ExecutionRow> {
  const { rows } = await storage.query<ExecutionRow>(
    `SELECT origin, user_id, saved_query_id, parameters FROM query_executions
      WHERE workspace_id = $1 AND id = $2`,
    [acme.id, id],
  )
  assert.ok(rows[0], `execution ${id} is recorded`)
  return rows[0]
}

/** Waits until a session of the test source is sleeping in pg_sleep. */
async function sleepingOnSource(): Promise<void> {
  await waitFor(
    async () => {
      const { rows } = await sourcePool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE application_name = 'manifest-source' AND state = 'active' AND wait_event = 'PgSleep'`,
      )
      return rows[0]?.count ?? 0
    },
    (count) => count >= 1,
    "a query to run on the source",
  )
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
  main = await serve()

  const ownerSession = await signIn(main.app.baseUrl, "owner@example.com", "Owner")
  owner = ownerSession.client
  ownerId = ownerSession.context.user.id
  const workspace = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
  })
  acme = workspace.body.result
  const workspaces = new WorkspacesRepository(storage)
  const bobSession = await signIn(main.app.baseUrl, "bob@example.com", "Bob")
  bob = bobSession.client
  bobId = bobSession.context.user.id
  await workspaces.addMember(acme.id, bobId, "member")
  const carolSession = await signIn(main.app.baseUrl, "carol@example.com", "Carol")
  carol = carolSession.client
  await workspaces.addMember(acme.id, carolSession.context.user.id, "admin")
  outsider = (await signIn(main.app.baseUrl, "outsider@example.com", "Outsider")).client

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

// Each test schedules its own routines: earlier ones are paused so they are not due on its clock.
beforeEach(async () => {
  if (skip) return
  await storage.query(
    "UPDATE routines SET enabled = false, paused_reason = 'manual', next_run_at = NULL WHERE enabled",
  )
})

after(async () => {
  if (skip) return
  for (const backend of backends) {
    await backend.dispatcher.stop()
    await Promise.all([backend.queries.shutdown(), backend.agents.shutdown(), backend.dispatcher.drained()])
    await backend.app.close().catch(() => {})
  }
  await refreshes.shutdown()
  await closeSourceAdapters(sources)
  await sourcePool.end()
  await storage.end()
})

test(
  "a saved query routine runs on schedule once per slot, as its owner, and records the outcome",
  { skip },
  async () => {
    setClock("2026-11-02T08:58:00Z")
    const since = await savedQuery("Orders since", SINCE_SQL, {
      parameters: [{ name: "since", type: "date", default: { kind: "relative", value: "days_ago:30" } }],
    })
    const created = await createRoutine({
      name: "Morning orders",
      kind: "saved_query",
      savedQueryId: since.id,
      parameters: { since: "start_of_month" },
      cron: "0 9 * * *",
      timeZone: "UTC",
    })
    assert.equal(created.nextRunAt, "2026-11-02T09:00:00.000Z")
    assert.deepEqual(created.upcoming, [
      "2026-11-02T09:00:00.000Z",
      "2026-11-03T09:00:00.000Z",
      "2026-11-04T09:00:00.000Z",
    ])
    assert.equal(created.schedule, "At 09:00")
    assert.deepEqual(created.savedQuery, { state: "available", id: since.id, name: "Orders since" })
    assert.deepEqual(created.owner, { id: ownerId, name: "Owner" })
    assert.deepEqual(created.delivery, { channel: "in_app" })
    assert.equal(created.enabled, true)

    // Not due yet.
    setClock("2026-11-02T08:59:30Z")
    await tick()
    assert.deepEqual(await runs(created.id), [])

    setClock("2026-11-02T09:00:07Z")
    await tick()
    await tick()
    const [run, ...others] = await runs(created.id)
    assert.equal(others.length, 0)
    assert.ok(run)
    assert.equal(run.trigger, "schedule")
    assert.equal(run.scheduledFor, "2026-11-02T09:00:00.000Z")
    assert.equal(run.status, "succeeded", JSON.stringify(run.error))
    assert.equal(run.execution?.connectionId, connection.id)
    const recorded = await execution(run.execution?.id ?? "")
    assert.equal(recorded.origin, "routine")
    assert.equal(recorded.user_id, ownerId)
    assert.equal(recorded.saved_query_id, since.id)
    assert.match((recorded.parameters as { since: string }).since, /^\d{4}-\d{2}-01$/)

    const after = await routine(created.id)
    assert.equal(after.nextRunAt, "2026-11-03T09:00:00.000Z")
    assert.equal(after.lastStatus, "succeeded")
    assert.ok(after.lastRunAt)
    assert.equal(after.consecutiveFailures, 0)
    // The saved query keeps the routine's run as its latest result.
    const reread = await owner.call<Ok<SavedQueryDetail>>(`${base()}/saved-queries/${since.id}`)
    assert.equal(reread.body.result.lastExecutionId, run.execution?.id)
  },
)

test("two backends ticking at the same time never run a slot twice", { skip }, async () => {
  setClock("2026-11-02T09:01:00Z")
  const second = await serve()
  const query = await savedQuery("Orders by status", BY_STATUS_SQL)
  const created: RoutineDetail[] = []
  for (let index = 1; index <= 6; index += 1) {
    created.push(await savedQueryRoutine(`Every five minutes ${index}`, query.id))
  }
  for (const slot of ["2026-11-02T09:05:00.000Z", "2026-11-02T09:10:00.000Z"]) {
    setClock(new Date(Date.parse(slot) + 3_000).toISOString())
    await Promise.all([tick(main, second), tick(second, main), tick(main), tick(second)])
    for (const item of created) {
      const slotRuns = (await runs(item.id)).filter((run) => run.scheduledFor === slot)
      assert.equal(slotRuns.length, 1, `${item.name} ran once at ${slot}`)
      assert.equal(slotRuns[0]?.status, "succeeded", JSON.stringify(slotRuns[0]?.error))
    }
  }
  const { rows } = await storage.query<{ runs: number }>(
    `SELECT count(*)::int AS runs FROM routine_runs
      WHERE workspace_id = $1 AND routine_id = ANY ($2::uuid[]) GROUP BY routine_id, scheduled_for`,
    [acme.id, created.map((item) => item.id)],
  )
  assert.equal(rows.length, 12)
  assert.ok(rows.every((row) => row.runs === 1))
  const executions = await storage.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM query_executions WHERE workspace_id = $1 AND saved_query_id = $2",
    [acme.id, query.id],
  )
  assert.equal(executions.rows[0]?.count, 12)
})

test("a paused routine does not run, and resuming does not run the slots it missed", { skip }, async () => {
  setClock("2026-11-02T10:01:00Z")
  const query = await savedQuery("Paused orders", BY_STATUS_SQL)
  const created = await savedQueryRoutine("Paused routine", query.id)
  const paused = await action(created.id, "pause")
  assert.equal(paused.status, 200, paused.text)
  assert.equal(paused.body.result.enabled, false)
  assert.equal(paused.body.result.pausedReason, "manual")
  assert.equal(paused.body.result.nextRunAt, null)
  assert.deepEqual(paused.body.result.upcoming, [])

  setClock("2026-11-02T11:02:00Z")
  await tick()
  assert.deepEqual(await runs(created.id), [])

  const resumed = await action(created.id, "resume")
  assert.equal(resumed.status, 200, resumed.text)
  assert.equal(resumed.body.result.enabled, true)
  assert.equal(resumed.body.result.pausedReason, null)
  assert.equal(resumed.body.result.nextRunAt, "2026-11-02T11:05:00.000Z")
  await tick()
  assert.deepEqual(await runs(created.id), [])

  setClock("2026-11-02T11:05:02Z")
  await tick()
  const history = await runs(created.id)
  assert.deepEqual(
    history.map((run) => [run.scheduledFor, run.status]),
    [["2026-11-02T11:05:00.000Z", "succeeded"]],
  )
  // Pausing through an edit works the same way.
  const edited = await owner.call<Ok<RoutineDetail>>(routinesPath(`/${created.id}`), {
    method: "PATCH",
    json: { version: created.version, enabled: false },
  })
  assert.equal(edited.status, 200, edited.text)
  assert.equal(edited.body.result.nextRunAt, null)
  assert.equal(edited.body.result.pausedReason, "manual")
})

test(
  "after downtime a routine runs once, for the latest slot, and notes the slots it skipped",
  { skip },
  async () => {
    setClock("2026-11-02T12:01:00Z")
    const query = await savedQuery("Downtime orders", BY_STATUS_SQL)
    const created = await savedQueryRoutine("Catch up", query.id, { timeZone: "Asia/Kolkata" })
    assert.equal(created.nextRunAt, "2026-11-02T12:05:00.000Z")

    // No backend ran from 12:05 to 13:02.
    setClock("2026-11-02T13:02:00Z")
    await tick()
    await tick()
    const [latest, note, ...rest] = await runs(created.id)
    assert.equal(rest.length, 0)
    assert.equal(latest?.scheduledFor, "2026-11-02T13:00:00.000Z")
    assert.equal(latest?.status, "succeeded")
    assert.equal(note?.status, "skipped")
    assert.equal(note?.scheduledFor, "2026-11-02T12:05:00.000Z")
    assert.deepEqual(note?.missed, {
      count: 11,
      more: false,
      first: "2026-11-02T12:05:00.000Z",
      last: "2026-11-02T12:55:00.000Z",
    })
    assert.equal(note?.error?.code, "MISSED_RUNS")
    // Read in the routine's time zone: 17:35 to 18:25 in India.
    assert.match(
      note?.error?.message ?? "",
      /11 scheduled runs from 2026-11-02 17:35 to 2026-11-02 18:25 \(Asia\/Kolkata\)/,
    )
    assert.equal((await routine(created.id)).nextRunAt, "2026-11-02T13:05:00.000Z")
  },
)

test(
  "three failed runs in a row pause a routine; a manual run still works and resuming resets it",
  { skip },
  async () => {
    setClock("2026-11-02T14:01:00Z")
    const failing = await savedQuery("Always fails", FAILING_SQL)
    const created = await savedQueryRoutine("Failing routine", failing.id)
    for (const slot of ["14:05", "14:10", "14:15"]) {
      setClock(`2026-11-02T${slot}:01Z`)
      await tick()
    }
    const paused = await routine(created.id)
    assert.equal(paused.enabled, false)
    assert.equal(paused.pausedReason, "failures")
    assert.equal(paused.nextRunAt, null)
    assert.equal(paused.consecutiveFailures, 3)
    assert.equal(paused.lastStatus, "failed")
    const history = await runs(created.id)
    assert.equal(history.length, 3)
    for (const run of history) {
      assert.equal(run.status, "failed")
      assert.equal(run.error?.code, "QUERY_FAILED")
      assert.match(run.error?.message ?? "", /division by zero/i)
      assert.ok(run.execution, "the failed execution is linked")
    }

    setClock("2026-11-02T14:20:01Z")
    await tick()
    assert.equal((await runs(created.id)).length, 3)

    // A manual run works while paused and does not resume the schedule.
    const manual = await runNow(created.id)
    assert.equal(manual.status, 202, manual.text)
    await main.dispatcher.drained()
    const afterManual = await routine(created.id)
    assert.equal(afterManual.enabled, false)
    assert.equal(afterManual.pausedReason, "failures")
    assert.equal(afterManual.consecutiveFailures, 4)

    const resumed = await action(created.id, "resume")
    assert.equal(resumed.body.result.enabled, true)
    assert.equal(resumed.body.result.consecutiveFailures, 0)
    assert.equal(resumed.body.result.nextRunAt, "2026-11-02T14:25:00.000Z")
  },
)

test(
  "a manual run is idempotent on its mutation id, runs as the owner, and leaves the schedule alone",
  { skip },
  async () => {
    setClock("2026-11-02T15:01:00Z")
    const query = await savedQuery("Manual orders", BY_STATUS_SQL)
    const created = await savedQueryRoutine("Manual routine", query.id)
    const mutationId = randomUUID()
    const [first, second] = await Promise.all([
      runNow(created.id, mutationId),
      runNow(created.id, mutationId),
    ])
    assert.deepEqual([first.status, second.status].sort(), [200, 202], `${first.text} ${second.text}`)
    assert.equal(first.body.result.id, second.body.result.id)
    const again = await runNow(created.id, mutationId)
    assert.equal(again.status, 200, again.text)
    assert.equal(again.body.result.id, first.body.result.id)
    assert.equal(first.body.result.trigger, "manual")
    assert.equal(first.body.result.scheduledFor, null)
    await main.dispatcher.drained()

    // A backend already running as many routine runs as it may refuses another, but not a resend.
    const holds: (() => void)[] = []
    for (let index = 0; index < main.dispatcher.options.concurrency; index += 1) {
      main.dispatcher.launch(`hold-${index}`, () => new Promise<void>((resolve) => holds.push(resolve)))
    }
    try {
      const busy = await runNow(created.id)
      assert.equal(busy.status, 429, busy.text)
      assert.equal(busy.body.error.code, "ROUTINE_BUSY")
      const resent = await runNow(created.id, mutationId)
      assert.equal(resent.status, 200, resent.text)
      assert.equal(resent.body.result.id, first.body.result.id)
    } finally {
      for (const release of holds) release()
    }
    await main.dispatcher.drained()

    const [run, ...rest] = await runs(created.id)
    assert.equal(rest.length, 0)
    assert.equal(run?.status, "succeeded")
    assert.deepEqual(run?.requestedBy, { id: ownerId, name: "Owner" })
    assert.equal((await routine(created.id)).nextRunAt, created.nextRunAt)

    // An admin may run someone else's routine; it still runs as its owner.
    const byAdmin = await runNow(created.id, randomUUID(), carol)
    assert.equal(byAdmin.status, 202, byAdmin.text)
    await main.dispatcher.drained()
    const adminRun = (await runs(created.id)).find((item) => item.id === byAdmin.body.result.id)
    assert.equal(adminRun?.requestedBy?.name, "Carol")
    assert.equal((await execution(adminRun?.execution?.id ?? "")).user_id, ownerId)

    const missing = await owner.call<Failure>(routinesPath(`/${created.id}/run`), {
      method: "POST",
      json: {},
    })
    assert.equal(missing.status, 422)
  },
)

test(
  "a stopped backend interrupts its routine run, a restart interrupts what a crash left, and neither retries",
  { skip },
  async () => {
    setClock("2026-11-02T16:01:00Z")
    const slow = await savedQuery("Slow orders", SLOW_SQL)
    const created = await savedQueryRoutine("Slow routine", slow.id)

    // SIGTERM: the dispatcher stops first, then the runners; the run records that it was interrupted.
    const stopping = await serve()
    setClock("2026-11-02T16:05:01Z")
    await stopping.dispatcher.tick()
    await sleepingOnSource()
    const [running] = await runs(created.id)
    assert.equal(running?.status, "running")
    await stopping.dispatcher.stop()
    await Promise.all([
      stopping.queries.shutdown(),
      stopping.agents.shutdown(),
      stopping.dispatcher.drained(),
    ])
    const [interrupted] = await runs(created.id)
    assert.equal(interrupted?.status, "interrupted")
    assert.equal(interrupted?.error?.code, "ROUTINE_INTERRUPTED")
    assert.equal((await routine(created.id)).lastStatus, "interrupted")
    // Another backend does not run the slot again.
    await tick()
    assert.equal((await runs(created.id)).length, 1)

    // A crash: the run is left running until the next start's recovery marks it interrupted.
    const manual = await runNow(created.id)
    assert.equal(manual.status, 202, manual.text)
    await sleepingOnSource()
    assert.equal(await new RoutinesRepository(storage).recoverAfterRestart(), 1)
    const recovered = (await runs(created.id)).find((run) => run.id === manual.body.result.id)
    assert.equal(recovered?.status, "interrupted")
    // The query finishing afterwards does not overwrite that, and nothing is retried.
    await main.dispatcher.drained()
    await tick()
    const history = await runs(created.id)
    assert.equal(history.length, 2)
    assert.ok(history.every((run) => run.status === "interrupted"))
  },
)

test(
  "a question routine asks as its owner in its own conversation, which the Ask list marks",
  { skip },
  async () => {
    setClock("2026-11-02T17:01:00Z")
    const created = await createRoutine({
      name: "Order count",
      kind: "question",
      question: "[count] How many orders are there?",
      connectionIds: [connection.id],
      cron: "0 9 * * 1",
    })
    assert.equal(created.timeZone, "UTC")
    assert.equal(created.savedQuery, null)
    assert.equal(created.schedule, "At 09:00, only on Monday")

    for (let index = 0; index < 2; index += 1) {
      const started = await runNow(created.id)
      assert.equal(started.status, 202, started.text)
      await main.dispatcher.drained()
    }
    const history = await runs(created.id)
    assert.equal(history.length, 2)
    for (const run of history) {
      assert.equal(run.status, "succeeded", JSON.stringify(run.error))
      assert.ok(run.agentRunId)
    }
    const conversationId = history[0]?.conversationId
    assert.ok(conversationId)
    assert.equal(history[1]?.conversationId, conversationId)
    assert.equal((await routine(created.id)).conversationId, conversationId)

    const agentRun = await owner.call<Ok<AgentRun>>(`${base()}/agent/runs/${history[0]?.agentRunId}`)
    assert.equal(agentRun.status, 200, agentRun.text)
    assert.equal(agentRun.body.result.status, "completed")
    assert.equal(agentRun.body.result.userId, ownerId)
    assert.deepEqual(agentRun.body.result.connectionIds, [connection.id])
    assert.equal(agentRun.body.result.answer?.evidence.length, 1)

    const list = await owner.call<Ok<ConversationPage>>(`${base()}/agent/conversations`)
    const listed = list.body.result.conversations.find((item) => item.id === conversationId)
    assert.equal(listed?.title, "Routine: Order count")
    assert.deepEqual(listed?.routine, { id: created.id, name: "Order count" })
    // Conversations stay private: other members see the run but not the conversation.
    const seenByBob = await runs(created.id, bob)
    assert.equal(seenByBob[0]?.conversationId, null)
    assert.equal((await routine(created.id, bob)).conversationId, null)

    // Nobody can answer a routine's clarification, so asking one fails the run.
    const asking = await createRoutine({
      name: "Vague",
      kind: "question",
      question: "[ask] Orders?",
      cron: "0 9 * * 1",
    })
    await runNow(asking.id)
    await main.dispatcher.drained()
    const [failed] = await runs(asking.id)
    assert.equal(failed?.status, "failed")
    assert.equal(failed?.error?.code, "AGENT_NO_CLARIFICATION")
    assert.match(failed?.error?.message ?? "", /Which month do you mean\?/)
  },
)

test(
  "members view routines, only the owner or an owner or admin manages them, and outsiders get 404",
  { skip },
  async () => {
    setClock("2026-11-02T18:01:00Z")
    const query = await savedQuery("Shared orders", BY_STATUS_SQL)
    const created = await savedQueryRoutine("Owner's routine", query.id)

    const listed = await bob.call<Ok<RoutineList>>(routinesPath())
    assert.equal(listed.status, 200)
    assert.ok(listed.body.result.routines.some((item) => item.id === created.id))
    assert.equal((await bob.call(routinesPath(`/${created.id}`))).status, 200)
    assert.equal((await bob.call(routinesPath(`/${created.id}/runs`))).status, 200)

    const forbidden = [
      await bob.call<Failure>(routinesPath(`/${created.id}`), {
        method: "PATCH",
        json: { version: created.version, name: "Mine now" },
      }),
      await action(created.id, "pause", bob),
      await action(created.id, "resume", bob),
      await runNow(created.id, randomUUID(), bob),
      await bob.call<Failure>(routinesPath(`/${created.id}`), { method: "DELETE" }),
    ]
    for (const res of forbidden) {
      assert.equal(res.status, 403, res.text)
      assert.equal(res.body.error.code, "FORBIDDEN")
    }
    for (const res of [
      await outsider.call<Failure>(routinesPath()),
      await outsider.call<Failure>(routinesPath(`/${created.id}`)),
      await outsider.call<Failure>(routinesPath(`/${created.id}/runs`)),
      await outsider.call<Failure>(routinesPath(`/${created.id}/run`), {
        method: "POST",
        json: { mutationId: randomUUID() },
      }),
    ]) {
      assert.equal(res.status, 404, res.text)
    }
    const noCsrf = await owner.call<Failure>(routinesPath(`/${created.id}/pause`), {
      method: "POST",
      csrf: false,
    })
    assert.equal(noCsrf.status, 403)
    assert.equal(noCsrf.body.error.code, "CSRF_REQUIRED")

    // An admin manages anyone's routine; a member creates and manages their own.
    assert.equal((await action(created.id, "pause", carol)).status, 200)
    const bobs = await createRoutine(
      { name: "Bob's own", kind: "saved_query", savedQueryId: query.id, cron: "0 8 * * *" },
      bob,
    )
    assert.deepEqual(bobs.owner, { id: bobId, name: "Bob" })
    assert.equal((await action(bobs.id, "pause", bob)).status, 200)

    // A private saved query: others cannot build on it, and see only that it is private.
    const secret = await savedQuery("Owner only", BY_STATUS_SQL, { visibility: "private" })
    const refused = await bob.call<Failure>(routinesPath(), {
      method: "POST",
      json: { name: "Peek", kind: "saved_query", savedQueryId: secret.id, cron: "0 8 * * *" },
    })
    assert.equal(refused.status, 422, refused.text)
    assert.equal(refused.body.error.details?.field, "savedQueryId")
    const ownerSecret = await savedQueryRoutine("Owner's secret", secret.id)
    assert.deepEqual((await routine(ownerSecret.id, bob)).savedQuery, { state: "private", id: secret.id })
    // Its runs show to everyone, but only the owner gets the link to the private query's result.
    assert.equal((await runNow(ownerSecret.id)).status, 202)
    await main.dispatcher.drained()
    const [secretRun] = await runs(ownerSecret.id)
    assert.equal(secretRun?.status, "succeeded", JSON.stringify(secretRun?.error))
    assert.ok(secretRun?.execution, "the owner sees the query run")
    const [seenRun] = await runs(ownerSecret.id, bob)
    assert.equal(seenRun?.id, secretRun?.id)
    assert.equal(seenRun?.execution, null)

    // An owner who left the workspace: runs fail and say why.
    await storage.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
      acme.id,
      bobId,
    ])
    try {
      assert.equal((await runNow(bobs.id, randomUUID(), carol)).status, 202)
      await main.dispatcher.drained()
      const [orphaned] = await runs(bobs.id)
      assert.equal(orphaned?.status, "failed")
      assert.equal(orphaned?.error?.code, "ROUTINE_OWNER_REMOVED")
    } finally {
      await new WorkspacesRepository(storage).addMember(acme.id, bobId, "member")
    }

    // A deleted saved query: the routine says it was removed, and runs fail.
    const doomed = await savedQuery("Soon deleted", BY_STATUS_SQL)
    const orphan = await savedQueryRoutine("Orphan", doomed.id)
    assert.equal((await owner.call(`${base()}/saved-queries/${doomed.id}`, { method: "DELETE" })).status, 200)
    assert.deepEqual((await routine(orphan.id)).savedQuery, { state: "removed" })
    await runNow(orphan.id)
    await main.dispatcher.drained()
    const [removed] = await runs(orphan.id)
    assert.equal(removed?.error?.code, "SAVED_QUERY_REMOVED")

    // Deleting a routine deletes its history.
    const deleted = await owner.call<Ok<{ deleted: true }>>(routinesPath(`/${orphan.id}`), {
      method: "DELETE",
    })
    assert.equal(deleted.status, 200)
    assert.equal((await owner.call(routinesPath(`/${orphan.id}`))).status, 404)
    const left = await storage.query("SELECT 1 FROM routine_runs WHERE routine_id = $1", [orphan.id])
    assert.equal(left.rowCount, 0)
  },
)

test("schedules, parameters, names, and versions are checked, and edits reschedule", { skip }, async () => {
  setClock("2026-11-02T19:01:00Z")
  const since = await savedQuery("Checked orders", SINCE_SQL, {
    parameters: [{ name: "since", type: "date", required: true }],
  })
  const bad = async (body: Record<string, unknown>, status: number, code: string) => {
    const res = await owner.call<Failure>(routinesPath(), {
      method: "POST",
      json: { name: "Checked", kind: "saved_query", savedQueryId: since.id, cron: "0 9 * * *", ...body },
    })
    assert.equal(res.status, status, res.text)
    assert.equal(res.body.error.code, code)
    return res.body.error
  }
  const today = { since: "today" }
  const tooOften = await bad({ cron: "*/2 * * * *", parameters: today }, 422, "VALIDATION_FAILED")
  assert.equal(tooOften.details?.field, "cron")
  assert.match(tooOften.message, /at most once every 5 minutes/)
  await bad({ cron: "0 25 * * *", parameters: { since: "today" } }, 422, "VALIDATION_FAILED")
  await bad({ cron: "@hourly", parameters: { since: "today" } }, 422, "VALIDATION_FAILED")
  // The required parameter has no default, so the routine must give it a value.
  const missing = await bad({}, 422, "INVALID_PARAMETERS")
  assert.deepEqual(missing.details?.missing, ["since"])
  const unknown = await bad({ parameters: { since: "today", until: "today" } }, 422, "INVALID_PARAMETERS")
  assert.deepEqual(unknown.details?.unknown, ["until"])

  // Without a time zone, the workspace's is used.
  await owner.call(`${base()}/settings/timezone`, { method: "PUT", json: { value: "Asia/Kolkata" } })
  try {
    const created = await createRoutine({
      name: "Checked",
      kind: "saved_query",
      savedQueryId: since.id,
      parameters: { since: "yesterday" },
      cron: "0 9 * * *",
    })
    assert.equal(created.timeZone, "Asia/Kolkata")
    // 09:00 in India on Tuesday 3 November is 03:30 UTC.
    assert.equal(created.nextRunAt, "2026-11-03T03:30:00.000Z")
    await bad({ name: "CHECKED", parameters: { since: "today" } }, 409, "CONFLICT")

    const rescheduled = await owner.call<Ok<RoutineDetail>>(routinesPath(`/${created.id}`), {
      method: "PATCH",
      json: { version: created.version, cron: "30 18 * * *", timeZone: "UTC" },
    })
    assert.equal(rescheduled.status, 200, rescheduled.text)
    assert.equal(rescheduled.body.result.nextRunAt, "2026-11-03T18:30:00.000Z")
    assert.equal(rescheduled.body.result.version, created.version + 1)
    const stale = await owner.call<Failure>(routinesPath(`/${created.id}`), {
      method: "PATCH",
      json: { version: created.version, name: "Late edit" },
    })
    assert.equal(stale.status, 409)
    assert.equal((stale.body.error.details?.current as RoutineDetail).cron, "30 18 * * *")

    // A question in place of the saved query: fields of the other kind go with it.
    const switched = await owner.call<Ok<RoutineDetail>>(routinesPath(`/${created.id}`), {
      method: "PATCH",
      json: { version: created.version + 1, kind: "question", question: "[count] Orders?" },
    })
    assert.equal(switched.status, 200, switched.text)
    assert.equal(switched.body.result.kind, "question")
    assert.equal(switched.body.result.savedQuery, null)
    assert.deepEqual(switched.body.result.parameters, {})
    const mixed = await owner.call<Failure>(routinesPath(`/${created.id}`), {
      method: "PATCH",
      json: { version: created.version + 2, parameters: { since: "today" } },
    })
    assert.equal(mixed.status, 422, mixed.text)
  } finally {
    await owner.call(`${base()}/settings/timezone`, { method: "PUT", json: { value: "UTC" } })
  }

  const preview = await owner.call<Ok<SchedulePreview>>(
    routinesPath(`/schedule-preview?cron=${encodeURIComponent("0 9 * * 1-5")}&timeZone=Asia/Kolkata`),
  )
  assert.equal(preview.status, 200, preview.text)
  assert.deepEqual(preview.body.result, {
    cron: "0 9 * * 1-5",
    timeZone: "Asia/Kolkata",
    schedule: "At 09:00, Monday through Friday",
    upcoming: ["2026-11-03T03:30:00.000Z", "2026-11-04T03:30:00.000Z", "2026-11-05T03:30:00.000Z"],
  })
  const everyMinute = encodeURIComponent("* * * * *")
  const badPreview = await bob.call<Failure>(routinesPath(`/schedule-preview?cron=${everyMinute}`))
  assert.equal(badPreview.status, 422)
  assert.match(badPreview.body.error.message, /every minute/)
})

test(
  "a routine whose stored schedule cannot be read pauses and says why, and the others still run",
  { skip },
  async () => {
    setClock("2026-11-02T20:01:00Z")
    const query = await savedQuery("Unreadable orders", BY_STATUS_SQL)
    const broken = await savedQueryRoutine("Unreadable", query.id)
    const healthy = await savedQueryRoutine("Readable", query.id)
    // As if its time zone stopped being known after an upgrade.
    await storage.query("UPDATE routines SET timezone = 'Mars/Base' WHERE id = $1", [broken.id])

    setClock("2026-11-02T20:05:01Z")
    const logged: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => logged.push(args[0])
    try {
      await tick()
    } finally {
      console.error = original
    }
    assert.ok(logged.some((line) => String(line).includes(broken.id)), JSON.stringify(logged))
    const paused = await routine(broken.id)
    assert.equal(paused.enabled, false)
    assert.equal(paused.pausedReason, "failures")
    assert.equal(paused.nextRunAt, null)
    assert.equal(paused.lastStatus, "failed")
    const [failed, ...rest] = await runs(broken.id)
    assert.equal(rest.length, 0)
    assert.equal(failed?.status, "failed")
    assert.equal(failed?.scheduledFor, "2026-11-02T20:05:00.000Z")
    assert.equal(failed?.error?.code, "ROUTINE_SCHEDULE_UNREADABLE")
    assert.equal((await runs(healthy.id))[0]?.status, "succeeded")

    // It is not claimed again, and resuming it says what to fix.
    setClock("2026-11-02T20:10:01Z")
    await tick()
    assert.equal((await runs(broken.id)).length, 1)
    const resumed = await action(broken.id, "resume")
    assert.equal(resumed.status, 422, resumed.text)
    assert.equal(resumed.body.error.details?.field, "cron")
  },
)

test("failed runs that end at the same time each count toward the pause", { skip }, async () => {
  setClock("2026-11-02T21:01:00Z")
  const query = await savedQuery("Counted orders", BY_STATUS_SQL)
  const created = await savedQueryRoutine("Counted", query.id)
  const repository = new RoutinesRepository(storage)
  const queued: string[] = []
  for (let index = 0; index < ROUTINE_LIMITS.failuresBeforePause; index += 1) {
    const run = await repository.insertManualRun(acme.id, created.id, randomUUID(), ownerId)
    assert.ok(run)
    queued.push(run.id)
  }
  const failure = { status: "failed" as const, error: { code: "QUERY_FAILED", message: "Failed (test)" } }
  await Promise.all(queued.map((id) => repository.finishRun(acme.id, id, failure)))
  const after = await routine(created.id)
  assert.equal(after.consecutiveFailures, ROUTINE_LIMITS.failuresBeforePause)
  assert.equal(after.enabled, false)
  assert.equal(after.pausedReason, "failures")
  assert.equal(after.nextRunAt, null)
})

test("question routines need a model provider", { skip }, async () => {
  const withoutModel = await serve({ modelProvider: null })
  const res = await owner.at(withoutModel.app.baseUrl).call<Failure>(routinesPath(), {
    method: "POST",
    json: { name: "No model", kind: "question", question: "Orders?", cron: "0 9 * * 1" },
  })
  assert.equal(res.status, 503, res.text)
  assert.equal(res.body.error.code, "AGENT_NOT_CONFIGURED")
})
