import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import test, { after, before } from "node:test"

import type { Pool } from "pg"

import {
  ACTIVE_RUN_STATUSES,
  type AgentRun,
  type AgentRunWithEvents,
  type RunEvent,
} from "../../src/agent/contracts.js"
import { createDemoModel } from "../../src/agent/demo-model.js"
import type { ModelProvider } from "../../src/agent/provider.js"
import { AgentRunsRepository } from "../../src/agent/repository.js"
import { AgentRunner } from "../../src/agent/runner.js"
import {
  ScriptedProvider,
  type ScriptedTurn,
  type ScriptView,
  type ToolOutcome,
} from "../../src/agent/scripted.js"
import { loadEnv } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import { KEPT_EXECUTIONS, QueryExecutionsRepository } from "../../src/queries/repository.js"
import { QueryRunner } from "../../src/queries/runner.js"
import type { Cell, ExecutionRecord } from "../../src/queries/schemas.js"
import { createApp, type AppDeps } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { buildDemoSource } from "../../src/storage/demo-source-builder.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"
import { captureConsole } from "./support/console.js"
import { signIn, type TestClient } from "./support/http.js"
import { manifestClient, waitFor } from "./support/manifests.js"
import { startApp, type RunningApp } from "./support/server.js"
import { sourceSettings } from "./support/source.js"
import { resetStorage } from "./support/storage.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_SOURCE_DATABASE_URL = process.env.TEST_SOURCE_DATABASE_URL
const skip = !TEST_DATABASE_URL || !TEST_SOURCE_DATABASE_URL
const SESSION_SECRET = "integration-test-secret-at-least-32-chars"
const KEY = randomBytes(32).toString("hex")
const SOURCE_NAME = "Demo store (synthetic)"
const DELIVERED_SQL =
  "SELECT count(*) AS orders, sum(total) AS revenue FROM orders WHERE status = 'delivered'"

interface Ok<T> {
  result: T
}
interface Failure {
  error: { code: string; message: string; details?: Record<string, unknown> }
}
interface QueryOutput {
  executionId: string
  rows: Cell[][]
  rowCount: number
}

let storage: Pool
let sourcePool: Pool
let sources: SourceAdapters
let refreshes: RefreshRunner
let queries: QueryRunner
const runners: AgentRunner[] = []
const apps: RunningApp[] = []
let consoleCapture: ReturnType<typeof captureConsole>
let main: RunningApp
let owner: TestClient
let ownerId: string
let member: TestClient
let outsider: TestClient
let acme: Workspace
let globex: Workspace
let source: ReturnType<typeof sourceSettings>
let connection: Connection
/** A source that was removed, and one whose server stopped answering. */
let removedId: string
let failingId: string
/** A knowledge entry about the failing source. */
let failingEntryId: string
let consoleExecutionId: string
const prompts: string[] = []
const seen: Record<string, ToolOutcome[]> = {}

const runsPath = (workspace = acme) => `/api/v1/workspaces/${workspace.id}/agent/runs`
const queriesPath = (connectionId = connection.id) =>
  `/api/v1/workspaces/${acme.id}/connections/${connectionId}/queries`

const call = (name: string, input: unknown) => ({ name, input })
const sql = (connectionId: string, text: string, purpose = "Test query") =>
  call("run_query", { connectionId, query: { language: "sql", sql: text }, purpose })
const submit = (
  markdown: string,
  status: "complete" | "partial",
  evidence: { executionId: string; label: string }[] = [],
  missing?: string[],
): ScriptedTurn => ({
  calls: [call("submit_answer", { markdown, status, evidence, ...(missing ? { missing } : {}) })],
})

function listedSource(view: ScriptView): string {
  const output = view.last("list_sources")?.output as { sources: { id: string; name: string }[] }
  return output.sources.find((entry) => entry.name === SOURCE_NAME)?.id ?? ""
}

function lastQuery(view: ScriptView): QueryOutput {
  const outcome = view.results.findLast((result) => result.name === "run_query" && result.ok)
  assert.ok(outcome, "a query succeeded")
  return outcome.output as QueryOutput
}

/** Test scenarios, chosen by a [tag] in the question. */
const SCENARIOS: Record<string, (view: ScriptView) => ScriptedTurn> = {
  grounded(view) {
    if (view.turn === 0) return { text: "Let me find the store's data. ", calls: [call("list_sources", {})] }
    if (view.turn === 1) {
      return {
        calls: [
          call("describe_object", { connectionId: listedSource(view), schema: "shop", name: "orders" }),
        ],
      }
    }
    if (view.turn === 2) {
      seen.grounded = view.results
      return { calls: [sql(listedSource(view), DELIVERED_SQL, "Delivered orders and their revenue")] }
    }
    const result = lastQuery(view)
    const [orders, revenue] = result.rows[0] ?? []
    return submit(`Delivered orders: ${String(orders)}; revenue ${String(revenue)} USD.`, "complete", [
      { executionId: result.executionId, label: "Delivered orders and revenue" },
    ])
  },
  invalid(view) {
    if (view.turn === 0) {
      return {
        calls: [
          call("run_query", { connectionId: "not-a-uuid", query: { language: "sql" }, purpose: "" }),
          call("describe_object", { connectionId: connection.id }),
        ],
      }
    }
    if (view.turn === 1) {
      seen.invalid = view.results
      return {
        calls: [sql(connection.id, "SELECT count(*) AS products FROM shop.products", "Count products")],
      }
    }
    const result = lastQuery(view)
    return submit(`There are ${String(result.rows[0]?.[0])} products.`, "complete", [
      { executionId: result.executionId, label: "Product count" },
    ])
  },
  unavailable(view) {
    if (view.turn === 0) return { calls: [sql(removedId, "SELECT 1"), sql(failingId, "SELECT 1")] }
    seen.unavailable = view.results
    return submit(
      "Neither source could be read.",
      "partial",
      [],
      ["Data from the removed and failing sources"],
    )
  },
  scoped(view) {
    if (view.turn === 0) {
      return {
        calls: [
          call("list_sources", {}),
          sql(failingId, "SELECT 1"),
          call("read_knowledge", { entryId: failingEntryId }),
        ],
      }
    }
    seen.scoped = view.results
    return submit("Only one source was available.", "partial")
  },
  rejected(view) {
    if (view.turn === 0) return { calls: [sql(connection.id, "DELETE FROM shop.orders", "Remove orders")] }
    seen.rejected = view.results
    return submit("I can only read data.", "partial", [], ["Permission to change data"])
  },
  evidence(view) {
    if (view.turn === 0) return { calls: [sql(connection.id, "SELECT count(*) AS orders FROM shop.orders")] }
    const result = lastQuery(view)
    if (view.turn === 1) {
      return submit("There are many orders.", "complete", [
        { executionId: randomUUID(), label: "Made up" },
        { executionId: consoleExecutionId, label: "Another run's query" },
      ])
    }
    seen.evidence = view.results
    return submit(`There are ${String(result.rows[0]?.[0])} orders.`, "complete", [
      { executionId: result.executionId, label: "Order count" },
    ])
  },
  loop: () => ({ calls: [call("list_sources", {})] }),
  slow(view) {
    if (view.turn === 0) return { calls: [sql(connection.id, "SELECT pg_sleep(20)", "Wait a while")] }
    return submit("Done waiting.", "complete")
  },
  followup(view) {
    const earlier = view.history.at(-1)
    return submit(
      `Following up on “${earlier?.question ?? "nothing"}”, answered as: ${earlier?.answer ?? "nothing"}`,
      "partial",
    )
  },
  nokey(view) {
    if (view.turn === 0) return { calls: [call("list_sources", {}), sql(connection.id, "SELECT 1")] }
    seen.nokey = view.results
    return submit("No data could be read.", "partial", [], ["Query results"])
  },
  plain: () => submit("Nothing to look up.", "complete"),
}

const scripted = new ScriptedProvider("test script", (view) => {
  const tag = /\[(\w+)\]/.exec(view.question)?.[1] ?? ""
  const scenario = SCENARIOS[tag]
  if (!scenario) throw new Error(`No test scenario for: ${view.question}`)
  return scenario(view)
})

/** Records each system prompt, then answers from the script. */
const recording: ModelProvider = {
  provider: scripted.provider,
  model: scripted.model,
  turn(request) {
    prompts.push(request.system)
    return scripted.turn(request)
  },
}

async function serve(env: Record<string, string>, deps: AppDeps): Promise<RunningApp> {
  const agents = new AgentRunner()
  runners.push(agents)
  const app = await startApp(
    createApp(loadEnv({ NODE_ENV: "test", ALLOW_DEV_LOGIN: "true", SESSION_SECRET, ...env }), {
      pool: storage,
      sources,
      refreshes,
      queries,
      agents,
      ...deps,
    }),
  )
  apps.push(app)
  return app
}

async function ask(
  client: TestClient,
  question: string,
  extra: { conversationId?: string; connectionIds?: string[] } = {},
): Promise<AgentRun> {
  const res = await client.call<Ok<AgentRun>>(runsPath(), { method: "POST", json: { question, ...extra } })
  assert.equal(res.status, 202, res.text)
  return res.body.result
}

async function finished(client: TestClient, runId: string): Promise<AgentRunWithEvents> {
  return waitFor(
    async () => {
      const res = await client.call<Ok<AgentRunWithEvents>>(`${runsPath()}/${runId}`)
      assert.equal(res.status, 200, res.text)
      return res.body.result
    },
    (run) => !ACTIVE_RUN_STATUSES.includes(run.status),
    `run ${runId} to finish`,
  )
}

async function answered(client: TestClient, question: string, extra = {}): Promise<AgentRunWithEvents> {
  const run = await finished(client, (await ask(client, question, extra)).id)
  assert.equal(run.status, "completed", JSON.stringify(run.error))
  return run
}

const toolEvents = (run: AgentRunWithEvents) =>
  run.events.flatMap((event) => (event.type === "tool.finished" ? [event.data] : []))

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

async function noBusySessions(): Promise<void> {
  await waitFor(
    async () => {
      const { rows } = await sourcePool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = 'manifest-source'
            AND state IN ('active', 'idle in transaction', 'idle in transaction (aborted)')`,
      )
      return rows[0]?.count ?? 0
    },
    (count) => count === 0,
    "no busy source sessions",
  )
}

async function saveSource(name: string): Promise<Connection> {
  const saved = await owner.call<Ok<Connection>>(`/api/v1/workspaces/${acme.id}/connections`, {
    method: "POST",
    json: {
      name,
      engine: "postgres",
      config: source.config,
      password: source.password,
      schemas: ["shop", "support"],
    },
  })
  assert.equal(saved.status, 201, saved.text)
  const reads = manifestClient(
    owner,
    `/api/v1/workspaces/${acme.id}/connections/${saved.body.result.id}/manifest`,
  )
  const first = await reads.latestRefresh()
  assert.ok(first)
  assert.equal((await reads.finished(first.id)).status, "succeeded")
  return saved.body.result
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
  refreshes = new RefreshRunner()
  queries = new QueryRunner()
  main = await serve(
    { CONNECTION_ENCRYPTION_KEY: KEY, AGENT_MAX_STEPS: "6", AGENT_RUN_TIMEOUT_MS: "60000" },
    { modelProvider: recording },
  )

  const ownerSession = await signIn(main.baseUrl, "owner@example.com", "Owner")
  owner = ownerSession.client
  ownerId = ownerSession.context.user.id
  const created = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
  })
  assert.equal(created.status, 201, created.text)
  acme = created.body.result
  globex = (
    await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
      method: "POST",
      json: { name: "Globex", slug: "globex" },
    })
  ).body.result
  const memberSession = await signIn(main.baseUrl, "member@example.com", "Member")
  member = memberSession.client
  await new WorkspacesRepository(storage).addMember(acme.id, memberSession.context.user.id, "member")
  outsider = (await signIn(main.baseUrl, "outsider@example.com", "Outsider")).client

  await owner.call(`/api/v1/workspaces/${acme.id}/settings/description`, {
    method: "PUT",
    json: { value: "Online coffee and tea store (synthetic)." },
  })
  const entry = await owner.call(`/api/v1/workspaces/${acme.id}/knowledge`, {
    method: "POST",
    json: { title: "Net revenue", body: "Revenue from orders that were not cancelled or refunded." },
  })
  assert.equal(entry.status, 201, entry.text)

  connection = await saveSource(SOURCE_NAME)
  const removed = await saveSource("Removed copy")
  removedId = removed.id
  assert.equal(
    (await owner.call(`/api/v1/workspaces/${acme.id}/connections/${removedId}`, { method: "DELETE" })).status,
    200,
  )
  const failing = await saveSource("Failing copy")
  failingId = failing.id
  // The source's server stops answering: nothing listens on port 1.
  await storage.query(
    "UPDATE connections SET config = jsonb_set(config, '{port}', '1'), updated_at = now() WHERE id = $1",
    [failingId],
  )
  await sources.postgres.evict(failingId)
  const failingEntry = await owner.call<Ok<{ id: string }>>(`/api/v1/workspaces/${acme.id}/knowledge`, {
    method: "POST",
    json: { title: "Failing copy notes", body: "Only about the failing copy.", connectionId: failingId },
  })
  assert.equal(failingEntry.status, 201, failingEntry.text)
  failingEntryId = failingEntry.body.result.id

  const consoleRun = await owner.call<Ok<ExecutionRecord>>(queriesPath(), {
    method: "POST",
    json: { id: randomUUID(), query: { language: "sql", sql: "SELECT 1 AS one" } },
  })
  assert.equal(consoleRun.status, 200, consoleRun.text)
  consoleExecutionId = consoleRun.body.result.id
})

after(async () => {
  if (skip) return
  consoleCapture.restore()
  for (const app of apps) await app.close()
  for (const runner of runners) await runner.shutdown()
  await queries.shutdown()
  await refreshes.shutdown()
  await closeSourceAdapters(sources)
  await storage.end()
  await sourcePool.end()
})

test(
  "a question is answered from source context, metadata, and an executed query whose numbers match the source",
  { skip },
  async () => {
    const queued = await ask(
      owner,
      "How many orders were delivered, and what revenue did they bring? [grounded]",
    )
    assert.equal(queued.status, "queued")
    assert.equal(queued.provider, "scripted")
    assert.equal(queued.model, "test script")
    const run = await finished(owner, queued.id)
    assert.equal(run.status, "completed", JSON.stringify(run.error))
    assert.equal(run.steps, 4)
    assert.deepEqual(run.connectionIds, [])
    assert.ok(run.startedAt && run.finishedAt)

    // The model saw the workspace, the source with its outline, and the knowledge base.
    const prompt = prompts.at(-1) ?? ""
    assert.match(prompt, /workspace “Acme”/)
    assert.match(prompt, /Online coffee and tea store \(synthetic\)/)
    assert.match(prompt, new RegExp(`### ${SOURCE_NAME.replace(/[()]/g, "\\$&")}\\n- id: ${connection.id}`))
    assert.match(prompt, / {2}shop\n[\s\S]*- orders · 10 columns/)
    assert.match(prompt, /- Net revenue \(id: /)
    assert.ok(!prompt.includes("Removed copy"))

    // describe_object returned the documented meaning of the columns.
    const described = seen.grounded?.find((result) => result.name === "describe_object")
    assert.ok(described?.ok)
    const detail = described.output as {
      object: { name: string }
      columns: { name: string; comment?: string }[]
    }
    assert.equal(detail.object.name, "orders")
    assert.match(
      detail.columns.find((column) => column.name === "total")?.comment ?? "",
      /Exclude cancelled and refunded/,
    )

    const answer = run.answer
    assert.ok(answer)
    assert.equal(answer.status, "complete")
    const [evidence] = answer.evidence
    assert.ok(evidence)
    assert.equal(evidence.connectionId, connection.id)
    assert.equal(evidence.label, "Delivered orders and revenue")
    assert.deepEqual(evidence.query, { language: "sql", sql: DELIVERED_SQL })
    assert.deepEqual(
      evidence.columns.map((column) => column.name),
      ["orders", "revenue"],
    )
    const direct = await sourcePool.query<{ orders: string; revenue: string }>(
      "SELECT count(*)::text AS orders, sum(total)::text AS revenue FROM shop.orders WHERE status = 'delivered'",
    )
    const expected = direct.rows[0]
    assert.ok(expected)
    assert.deepEqual(evidence.rows, [[expected.orders, expected.revenue]])
    assert.equal(answer.markdown, `Delivered orders: ${expected.orders}; revenue ${expected.revenue} USD.`)

    // Events are numbered in order and tell the story of the run.
    assert.deepEqual(
      run.events.map((event) => event.seq),
      run.events.map((_, index) => index + 1),
    )
    assert.deepEqual(
      run.events
        .filter((event) => event.type !== "answer.delta")
        .map((event) => [event.type, "tool" in event.data ? event.data.tool : null]),
      [
        ["run.started", null],
        ["tool.started", "list_sources"],
        ["tool.finished", "list_sources"],
        ["tool.started", "describe_object"],
        ["tool.finished", "describe_object"],
        ["tool.started", "run_query"],
        ["tool.finished", "run_query"],
        ["tool.started", "submit_answer"],
        ["tool.finished", "submit_answer"],
        ["answer.completed", null],
      ],
    )
    assert.ok(
      run.events.some(
        (event) => event.type === "answer.delta" && event.data.text === "Let me find the store's data. ",
      ),
    )
    const queried = toolEvents(run).find((data) => data.tool === "run_query")
    assert.equal(queried?.executionId, evidence.executionId)
    assert.equal(queried?.summary, "1 row")
    const later = await owner.call<Ok<AgentRunWithEvents>>(
      `${runsPath()}/${run.id}?after=${run.events.length - 2}`,
    )
    assert.deepEqual(
      later.body.result.events.map((event: RunEvent) => event.type),
      ["tool.finished", "answer.completed"],
    )

    // The cited execution is an agent run by this user, openable by any member, and pinned.
    const execution = await member.call<Ok<ExecutionRecord>>(`${queriesPath()}/${evidence.executionId}`)
    assert.equal(execution.status, 200, execution.text)
    assert.equal(execution.body.result.origin, "agent")
    assert.equal(execution.body.result.userId, ownerId)
    assert.deepEqual(execution.body.result.result?.rows, evidence.rows)
    const { rows } = await storage.query<{ pinned: boolean }>(
      "SELECT pinned FROM query_executions WHERE id = $1",
      [evidence.executionId],
    )
    assert.equal(rows[0]?.pinned, true)
  },
)

test("invalid tool input comes back as a tool error and the model recovers", { skip }, async () => {
  const run = await answered(owner, "How many products are there? [invalid]")
  assert.deepEqual(
    seen.invalid?.map((result) => [result.name, result.ok]),
    [
      ["run_query", false],
      ["describe_object", false],
    ],
  )
  assert.match(
    String(seen.invalid?.[0]?.output),
    /^Error: Invalid input for run_query: connectionId: .*purpose/,
  )
  assert.match(String(seen.invalid?.[1]?.output), /Give objectId, or both schema and name/)
  assert.deepEqual(
    toolEvents(run).map((data) => data.ok),
    [false, false, true, true],
  )
  const count = await sourcePool.query<{ count: string }>("SELECT count(*)::text AS count FROM shop.products")
  assert.equal(run.answer?.markdown, `There are ${count.rows[0]?.count} products.`)
})

test("removed, failing, and out-of-scope sources are recoverable tool errors", { skip }, async () => {
  const run = await answered(owner, "What do the other sources say? [unavailable]")
  const [removed, failing] = seen.unavailable ?? []
  assert.equal(removed?.ok, false)
  assert.match(String(removed?.output), /no longer exists/)
  assert.equal(failing?.ok, false)
  assert.match(String(failing?.output), /^Error: SOURCE_CONNECTION_FAILED: /)
  assert.equal(run.answer?.status, "partial")
  assert.deepEqual(run.answer?.missing, ["Data from the removed and failing sources"])
  const failedExecution = toolEvents(run).find((data) => data.executionId)?.executionId
  assert.ok(failedExecution)
  const record = await owner.call<Ok<ExecutionRecord>>(`${queriesPath(failingId)}/${failedExecution}`)
  assert.equal(record.body.result.status, "failed")

  const scoped = await answered(owner, "Only the demo store, please. [scoped]", {
    connectionIds: [connection.id],
  })
  assert.deepEqual(scoped.connectionIds, [connection.id])
  const listed = seen.scoped?.[0]?.output as { sources: { id: string }[] }
  assert.deepEqual(
    listed.sources.map((entry) => entry.id),
    [connection.id],
  )
  assert.match(String(seen.scoped?.[1]?.output), /not one of the sources for this question/)
  assert.match(String(seen.scoped?.[2]?.output), /not one of the sources for this question/)
})

test(
  "a disallowed query is a QUERY_REJECTED tool error, recorded as a rejected agent execution",
  { skip },
  async () => {
    const ordersBefore = (await sourcePool.query("SELECT count(*) FROM shop.orders")).rows[0]
    const run = await answered(owner, "Delete the old orders. [rejected]")
    assert.match(
      String(seen.rejected?.[0]?.output),
      /^Error: QUERY_REJECTED \(statement_not_allowed\): .*Offending name: DELETE\./,
    )
    const executionId = toolEvents(run)[0]?.executionId
    assert.ok(executionId)
    const record = await owner.call<Ok<ExecutionRecord>>(`${queriesPath()}/${executionId}`)
    assert.equal(record.body.result.status, "rejected")
    assert.equal(record.body.result.origin, "agent")
    assert.deepEqual((await sourcePool.query("SELECT count(*) FROM shop.orders")).rows[0], ordersBefore)
  },
)

test(
  "evidence must cite this run's succeeded executions; the model fixes it after a tool error",
  { skip },
  async () => {
    const run = await answered(owner, "How many orders are there? [evidence]")
    const refused = seen.evidence?.find((result) => result.name === "submit_answer")
    assert.equal(refused?.ok, false)
    assert.match(String(refused?.output), new RegExp(`Not found: .*${consoleExecutionId}`))
    assert.equal(run.answer?.evidence.length, 1)
    assert.notEqual(run.answer?.evidence[0]?.executionId, consoleExecutionId)
    assert.equal(run.steps, 3)
  },
)

test("the step limit fails the run with a clear error", { skip }, async () => {
  const run = await finished(owner, (await ask(owner, "Keep looking. [loop]")).id)
  assert.equal(run.status, "failed")
  assert.equal(run.error?.code, "AGENT_STEP_LIMIT")
  assert.match(run.error?.message ?? "", /within 6 steps/)
  assert.equal(run.steps, 6)
  assert.equal(run.answer, null)
  assert.deepEqual(run.events.at(-1)?.data, run.error)
})

test(
  "cancelling during a slow query stops it on the source; busy conversations and users are refused",
  { skip },
  async () => {
    const first = await ask(owner, "Wait for it. [slow]")
    const second = await ask(owner, "Wait for it too. [slow]")
    await sleepingOnSource(2)
    const sameConversation = await owner.call<Failure>(runsPath(), {
      method: "POST",
      json: { question: "Another one [plain]", conversationId: first.conversationId },
    })
    assert.equal(sameConversation.status, 409, sameConversation.text)
    const third = await owner.call<Failure>(runsPath(), {
      method: "POST",
      json: { question: "A third [plain]" },
    })
    assert.equal(third.status, 429, third.text)
    assert.equal(third.body.error.code, "AGENT_BUSY")
    assert.ok(third.headers.get("retry-after"))
    // Someone else in the workspace can still ask.
    await answered(member, "Mine [plain]")

    for (const run of [first, second]) {
      const cancelled = await owner.call<Ok<AgentRunWithEvents>>(`${runsPath()}/${run.id}/cancel`, {
        method: "POST",
      })
      assert.equal(cancelled.status, 200, cancelled.text)
      assert.equal(cancelled.body.result.status, "cancelled")
      assert.equal(cancelled.body.result.error, null)
      assert.equal(cancelled.body.result.events.at(-1)?.type, "run.cancelled")
    }
    await noBusySessions()
    const { rows } = await storage.query<{ status: string }>(
      "SELECT status FROM query_executions WHERE origin = 'agent' AND query::text LIKE '%pg_sleep(20)%'",
    )
    assert.deepEqual(
      rows.map((row) => row.status),
      ["cancelled", "cancelled"],
    )
    const again = await owner.call<Failure>(`${runsPath()}/${first.id}/cancel`, { method: "POST" })
    assert.equal(again.status, 409)
  },
)

test("a follow-up question sees the earlier question and answer of its conversation", { skip }, async () => {
  const opening = await answered(owner, "How many orders were delivered? [grounded]")
  const followUp = await answered(owner, "And how does that compare? [followup]", {
    conversationId: opening.conversationId,
  })
  assert.equal(followUp.conversationId, opening.conversationId)
  assert.match(
    followUp.answer?.markdown ?? "",
    /Following up on “How many orders were delivered\? \[grounded\]”, answered as: Delivered orders: \d+/,
  )
  const fresh = await answered(owner, "Anything earlier? [followup]")
  assert.notEqual(fresh.conversationId, opening.conversationId)
  assert.match(fresh.answer?.markdown ?? "", /Following up on “nothing”/)
})

test("runs and conversations are private: other users and non-members get 404", { skip }, async () => {
  const run = await answered(owner, "Private question [plain]")
  assert.equal((await member.call(`${runsPath()}/${run.id}`)).status, 404)
  assert.equal((await member.call(`${runsPath()}/${run.id}/cancel`, { method: "POST" })).status, 404)
  const borrowed = await member.call(runsPath(), {
    method: "POST",
    json: { question: "Continue theirs [plain]", conversationId: run.conversationId },
  })
  assert.equal(borrowed.status, 404)
  assert.equal((await outsider.call(`${runsPath()}/${run.id}`)).status, 404)
  assert.equal(
    (await outsider.call(runsPath(), { method: "POST", json: { question: "Hi [plain]" } })).status,
    404,
  )
  assert.equal((await owner.call(`${runsPath(globex)}/${run.id}`)).status, 404)

  const withoutCsrf = await owner.call(runsPath(), {
    method: "POST",
    csrf: false,
    json: { question: "Hi [plain]" },
  })
  assert.equal(withoutCsrf.status, 403)
  const empty = await owner.call<Failure>(runsPath(), { method: "POST", json: { question: "   " } })
  assert.equal(empty.status, 422)
  const nul = await owner.call<Failure>(runsPath(), { method: "POST", json: { question: "Hi\u0000 [plain]" } })
  assert.equal(nul.status, 422, nul.text)
  const unknownSource = await owner.call<Failure>(runsPath(), {
    method: "POST",
    json: { question: "Hi [plain]", connectionIds: [randomUUID()] },
  })
  assert.equal(unknownSource.status, 422)
  assert.equal((await owner.call(`${runsPath()}/${randomUUID()}`)).status, 404)
})

test(
  "without a provider the agent answers 503; without the key queries are a recoverable tool error",
  { skip },
  async () => {
    const unconfigured = await serve({ CONNECTION_ENCRYPTION_KEY: KEY }, { modelProvider: null })
    const client = owner.at(unconfigured.baseUrl)
    const refused = await client.call<Failure>(runsPath(), {
      method: "POST",
      json: { question: "Anyone? [plain]" },
    })
    assert.equal(refused.status, 503)
    assert.equal(refused.body.error.code, "AGENT_NOT_CONFIGURED")
    assert.equal((await client.call(`${runsPath()}/${randomUUID()}`)).status, 503)
    assert.equal(
      (await outsider.at(unconfigured.baseUrl).call(runsPath(), { method: "POST", json: { question: "x" } }))
        .status,
      404,
    )
    assert.equal(
      (await client.call(`/api/v1/workspaces/${acme.id}/knowledge`)).status,
      200,
      "everything else works",
    )

    const keyless = await serve({}, { modelProvider: recording })
    const run = await answered(owner.at(keyless.baseUrl), "Read something [nokey]")
    const listed = seen.nokey?.[0]?.output as { sources: { name: string }[] }
    assert.ok(listed.sources.some((entry) => entry.name === SOURCE_NAME))
    assert.match(String(seen.nokey?.[1]?.output), /CONNECTION_ENCRYPTION_KEY/)
    assert.equal(run.answer?.status, "partial")
  },
)

test("the run deadline fails a run and stops its query on the source", { skip }, async () => {
  const hurried = await serve(
    { CONNECTION_ENCRYPTION_KEY: KEY, AGENT_RUN_TIMEOUT_MS: "1500" },
    { modelProvider: recording },
  )
  const client = owner.at(hurried.baseUrl)
  const queued = await client.call<Ok<AgentRun>>(runsPath(), {
    method: "POST",
    json: { question: "Too slow [slow]" },
  })
  const run = await finished(client, queued.body.result.id)
  assert.equal(run.status, "failed")
  assert.equal(run.error?.code, "AGENT_TIMEOUT")
  assert.match(run.error?.message ?? "", /longer than 2 seconds/)
  await noBusySessions()
})

test(
  "the scripted demo model answers its questions from real queries and admits the rest",
  { skip },
  async () => {
    const demo = await serve({ CONNECTION_ENCRYPTION_KEY: KEY }, { modelProvider: createDemoModel() })
    const client = owner.at(demo.baseUrl)
    const questions = [
      "What was net revenue by month?",
      "What are our top products?",
      "What is the refund rate?",
      "How many support tickets are open?",
    ]
    for (const question of questions) {
      const run = await answered(client, question)
      assert.equal(run.model, "demo (synthetic)")
      const answer = run.answer
      assert.ok(answer)
      assert.equal(answer.status, "complete", question)
      assert.match(answer.markdown, /scripted demo model \(synthetic\)/)
      const [evidence] = answer.evidence
      assert.ok(evidence && evidence.query.language === "sql")
      const direct = await sourcePool.query<Cell[]>({ text: evidence.query.sql, rowMode: "array" })
      assert.deepEqual(evidence.rows, direct.rows.slice(0, 20), question)
      assert.ok(evidence.rows.length > 0, question)
    }
    const other = await answered(client, "Which customers are likely to churn?")
    assert.equal(other.answer?.status, "partial")
    assert.equal(other.answer?.evidence.length, 0)
  },
)

test("pinned evidence survives history pruning, and a restart fails interrupted runs", { skip }, async () => {
  const run = await answered(owner, "Count again [evidence]")
  const cited = run.answer?.evidence[0]?.executionId
  assert.ok(cited)
  const repository = new QueryExecutionsRepository(storage)
  const error = { code: "QUERY_REJECTED", message: "Refused for the test.", reason: null, name: null }
  for (let index = 0; index < KEPT_EXECUTIONS + 5; index += 1) {
    await repository.insert(
      {
        id: randomUUID(),
        workspaceId: acme.id,
        connectionId: connection.id,
        userId: null,
        origin: "console",
        query: { language: "sql", sql: "SELECT 1" },
        limits: { maxRows: 10, timeoutMs: 1_000 },
      },
      { status: "rejected", error },
    )
  }
  assert.ok(await repository.get(acme.id, connection.id, cited), "the cited execution is still stored")

  const runs = new AgentRunsRepository(storage)
  const conversationId = randomUUID()
  await runs.createConversation({
    id: conversationId,
    workspaceId: acme.id,
    userId: ownerId,
    title: "Interrupted",
  })
  const stranded = await runs.insertRun({
    id: randomUUID(),
    workspaceId: acme.id,
    conversationId,
    userId: ownerId,
    question: "Interrupted?",
    connectionIds: [],
    provider: "scripted",
    model: "test script",
  })
  assert.ok(stranded)
  await runs.appendEvent(acme.id, stranded.id, {
    seq: 1,
    type: "run.started",
    data: { provider: "scripted", model: "x" },
  })
  assert.ok((await runs.failInterrupted()) >= 1)
  const after = await owner.call<Ok<AgentRunWithEvents>>(`${runsPath()}/${stranded.id}`)
  assert.equal(after.body.result.status, "failed")
  assert.equal(after.body.result.error?.code, "AGENT_INTERRUPTED")
  assert.deepEqual(
    after.body.result.events.map((event) => [event.seq, event.type]),
    [
      [1, "run.started"],
      [2, "run.failed"],
    ],
  )
})

test(
  "shutting down aborts running questions, records them as interrupted, and leaves no work on the source",
  { skip },
  async () => {
    const queued = await ask(owner, "Shut down while waiting [slow]")
    await sleepingOnSource()
    await runners[0]?.shutdown()
    const run = await finished(owner, queued.id)
    assert.equal(run.status, "failed")
    assert.equal(run.error?.code, "AGENT_INTERRUPTED")
    await noBusySessions()
  },
)

test("passwords never appear in responses, prompts, or console output", { skip }, () => {
  const responses = [...owner.responses, ...member.responses, ...outsider.responses]
  assert.ok(responses.length > 30)
  for (const text of [...responses, ...prompts, ...consoleCapture.lines]) {
    assert.ok(!text.includes(source.password), "the source password leaked")
    assert.ok(!/sealed_?secret/i.test(text), "the sealed secret leaked")
  }
})
