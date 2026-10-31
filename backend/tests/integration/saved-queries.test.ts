import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import test, { after, before } from "node:test"

import type { Pool } from "pg"

import { ACTIVE_RUN_STATUSES, type AgentRunWithEvents, type EvidenceItem } from "../../src/agent/contracts.js"
import { AgentRunner } from "../../src/agent/runner.js"
import { ScriptedProvider, type ScriptView } from "../../src/agent/scripted.js"
import { loadEnv } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import { cellText } from "../../src/queries/csv.js"
import { QueryRunner } from "../../src/queries/runner.js"
import type { Cell, ExecutionRecord, ExecutionSummary } from "../../src/queries/schemas.js"
import type {
  SavedQueryDetail,
  SavedQueryList,
  SavedQueryRun,
  SavedQueryRunPage,
} from "../../src/saved-queries/schemas.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { buildDemoSource } from "../../src/storage/demo-source-builder.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"
import { captureConsole } from "./support/console.js"
import { signIn, type TestClient, type TestResponse } from "./support/http.js"
import { manifestClient, waitFor } from "./support/manifests.js"
import { startApp, type RunningApp } from "./support/server.js"
import { sourceSettings } from "./support/source.js"
import { resetStorage } from "./support/storage.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_SOURCE_DATABASE_URL = process.env.TEST_SOURCE_DATABASE_URL
const skip = !TEST_DATABASE_URL || !TEST_SOURCE_DATABASE_URL
const SESSION_SECRET = "integration-test-secret-at-least-32-chars"
const TIME_ZONE = "Asia/Kolkata"

const REVENUE_SQL = `SELECT status, count(*)::int AS orders, sum(total) AS revenue
  FROM shop.orders GROUP BY status ORDER BY status`
const RANGE_SQL = `SELECT count(*)::int AS orders, coalesce(sum(total), 0) AS revenue
  FROM shop.orders WHERE ordered_at >= {{since}} AND ordered_at < {{until}}`

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
let agents: AgentRunner
let app: RunningApp
let consoleCapture: ReturnType<typeof captureConsole>
let owner: TestClient
let ownerId: string
let alice: TestClient
let bob: TestClient
let outsider: TestClient
let acme: Workspace
let source: ReturnType<typeof sourceSettings>
let connection: Connection
let answer: AgentRunWithEvents
let evidence: EvidenceItem

const base = () => `/api/v1/workspaces/${acme.id}`
const savedPath = (id = "") => `${base()}/saved-queries${id ? `/${id}` : ""}`
const executionPath = (record: { connectionId: string; id: string }) =>
  `${base()}/connections/${record.connectionId}/queries/${record.id}`

/** The scripted model answers "[revenue]" with one cited query. */
const provider = new ScriptedProvider("saved query script", (view: ScriptView) => {
  if (view.turn === 0) {
    return {
      calls: [
        {
          name: "run_query",
          input: {
            connectionId: connection.id,
            query: { language: "sql", sql: REVENUE_SQL },
            purpose: "Orders and revenue by status",
          },
        },
      ],
    }
  }
  const outcome = view.results.findLast((result) => result.name === "run_query" && result.ok)
  const output = outcome?.output as { executionId: string }
  return {
    calls: [
      {
        name: "submit_answer",
        input: {
          markdown: "Orders and revenue by status are below.",
          status: "complete",
          evidence: [{ executionId: output.executionId, label: "Orders and revenue by status" }],
        },
      },
    ],
  }
})

async function saveSource(name: string, schemas = ["shop", "support"]): Promise<Connection> {
  const saved = await owner.call<Ok<Connection>>(`${base()}/connections`, {
    method: "POST",
    json: { name, engine: "postgres", config: source.config, password: source.password, schemas },
  })
  assert.equal(saved.status, 201, saved.text)
  const reads = manifestClient(owner, `${base()}/connections/${saved.body.result.id}/manifest`)
  const first = await reads.latestRefresh()
  assert.ok(first)
  assert.equal((await reads.finished(first.id)).status, "succeeded")
  return saved.body.result
}

function create(client: TestClient, body: Record<string, unknown>): Promise<Reply<SavedQueryDetail>> {
  return client.call(savedPath(), {
    method: "POST",
    json: { connectionId: connection.id, ...body },
  })
}

async function created(client: TestClient, body: Record<string, unknown>): Promise<SavedQueryDetail> {
  const res = await create(client, body)
  assert.equal(res.status, 201, res.text)
  return res.body.result
}

function run(client: TestClient, id: string, parameters?: Record<string, unknown>): Promise<Reply<SavedQueryRun>> {
  return client.call(`${savedPath(id)}/run`, { method: "POST", json: parameters ? { parameters } : {} })
}

async function succeeded(client: TestClient, id: string, parameters?: Record<string, unknown>) {
  const res = await run(client, id, parameters)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.result.execution.status, "succeeded", JSON.stringify(res.body.result.execution.error))
  return res.body.result
}

async function detail(client: TestClient, id: string): Promise<SavedQueryDetail> {
  const res = await client.call<Ok<SavedQueryDetail>>(savedPath(id))
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

async function pinned(executionId: string): Promise<boolean> {
  const { rows } = await storage.query<{ pinned: boolean }>(
    "SELECT pinned FROM query_executions WHERE workspace_id = $1 AND id = $2",
    [acme.id, executionId],
  )
  return rows[0]?.pinned ?? false
}

/** Rows straight from the source, encoded like results (exact numerics as text). */
async function direct(sql: string, values: unknown[] = []): Promise<Cell[][]> {
  const { rows } = await sourcePool.query<unknown[]>({ text: sql, values, rowMode: "array" })
  return rows.map((row) =>
    row.map((value) => (typeof value === "number" || value === null ? value : String(value)) as Cell),
  )
}

/** A strict RFC 4180 reader for the exported files. */
function parseCsv(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ""
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ",") {
      record.push(field)
      field = ""
    } else if (char === "\r" && text[index + 1] === "\n") {
      record.push(field)
      records.push(record)
      record = []
      field = ""
      index += 1
    } else {
      assert.notEqual(char, "\n", "bare LF outside quotes")
      field += char
    }
  }
  assert.equal(field, "", "the file ends with CRLF")
  return records
}

/** Downloads an export as bytes (Response.text() would drop the byte order mark). */
async function exported(client: TestClient, path: string): Promise<{ res: Response; records: string[][] }> {
  const cookie = [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
  const res = await fetch(`${client.baseUrl}${path}/export.csv`, { headers: { Cookie: cookie } })
  const bytes = Buffer.from(await res.arrayBuffer())
  assert.equal(res.status, 200, bytes.toString("utf8"))
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8")
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 byte order mark")
  return { res, records: parseCsv(bytes.subarray(3).toString("utf8")) }
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
  agents = new AgentRunner()
  const env = loadEnv({
    NODE_ENV: "test",
    ALLOW_DEV_LOGIN: "true",
    SESSION_SECRET,
    CONNECTION_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  })
  app = await startApp(
    createApp(env, { pool: storage, sources, refreshes, queries, agents, modelProvider: provider }),
  )

  const ownerSession = await signIn(app.baseUrl, "owner@example.com", "Owner")
  owner = ownerSession.client
  ownerId = ownerSession.context.user.id
  const workspace = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
  })
  acme = workspace.body.result
  const workspaces = new WorkspacesRepository(storage)
  const aliceSession = await signIn(app.baseUrl, "alice@example.com", "Alice")
  alice = aliceSession.client
  await workspaces.addMember(acme.id, aliceSession.context.user.id, "member")
  const bobSession = await signIn(app.baseUrl, "bob@example.com", "Bob")
  bob = bobSession.client
  await workspaces.addMember(acme.id, bobSession.context.user.id, "member")
  outsider = (await signIn(app.baseUrl, "outsider@example.com", "Outsider")).client

  connection = await saveSource("Demo store (synthetic)")

  const asked = await owner.call<Ok<AgentRunWithEvents>>(`${base()}/agent/runs`, {
    method: "POST",
    json: { question: "What are orders and revenue by status? [revenue]" },
  })
  assert.equal(asked.status, 202, asked.text)
  answer = await waitFor(
    async () =>
      (await owner.call<Ok<AgentRunWithEvents>>(`${base()}/agent/runs/${asked.body.result.id}`)).body.result,
    (current) => !ACTIVE_RUN_STATUSES.includes(current.status),
    "the answer",
  )
  assert.equal(answer.status, "completed", JSON.stringify(answer.error))
  const cited = answer.answer?.evidence[0]
  assert.ok(cited)
  evidence = cited
})

after(async () => {
  if (skip) return
  consoleCapture.restore()
  await app.close()
  await agents.shutdown()
  await queries.shutdown()
  await refreshes.shutdown()
  await closeSourceAdapters(sources)
  await storage.end()
  await sourcePool.end()
})

test(
  "an answer's evidence becomes a saved query that reopens, reruns, and keeps its latest result",
  { skip },
  async () => {
    const saved = await created(owner, {
      name: evidence.label,
      description: "Saved from the **status** answer.",
      connectionId: evidence.connectionId,
      query: evidence.query,
      origin: { runId: answer.id, executionId: evidence.executionId },
    })
    assert.equal(saved.name, "Orders and revenue by status")
    assert.deepEqual(saved.source, { id: connection.id, name: "Demo store (synthetic)", engine: "postgres" })
    assert.deepEqual(saved.query, { language: "sql", sql: REVENUE_SQL })
    assert.deepEqual(saved.origin, { runId: answer.id, executionId: evidence.executionId })
    assert.equal(saved.visibility, "workspace")
    assert.equal(saved.version, 1)
    assert.equal(saved.createdBy?.id, ownerId)
    assert.deepEqual(saved.parameters, [])
    assert.deepEqual(saved.warnings, [])
    assert.equal(saved.timeZone, "UTC")
    assert.equal(saved.latestRun, null)

    // Reopened by another member, from the list and directly.
    const listed = await alice.call<Ok<SavedQueryList>>(`${savedPath()}?search=revenue`)
    assert.equal(listed.status, 200, listed.text)
    assert.deepEqual(
      listed.body.result.savedQueries.map((item) => [item.id, item.excerpt]),
      [[saved.id, "Saved from the status answer."]],
    )
    assert.equal((await detail(alice, saved.id)).description, "Saved from the **status** answer.")

    // Any member reruns it; the rows match the source.
    const first = await succeeded(alice, saved.id)
    assert.equal(first.execution.origin, "saved_query")
    assert.equal(first.execution.savedQueryId, saved.id)
    assert.deepEqual(first.execution.parameters, {})
    assert.deepEqual(first.parameters, [])
    assert.deepEqual(first.execution.result?.rows, await direct(REVENUE_SQL))
    assert.deepEqual(first.execution.result?.rows, evidence.rows)

    const reopened = await detail(owner, saved.id)
    assert.equal(reopened.latestRun?.id, first.execution.id)
    assert.deepEqual(reopened.latestRun?.result?.rows, first.execution.result?.rows)
    assert.ok(reopened.lastRunAt)
    assert.ok(await pinned(first.execution.id))

    // A newer run becomes the latest result; the previous one is no longer pinned.
    const second = await succeeded(owner, saved.id)
    assert.equal((await detail(owner, saved.id)).latestRun?.id, second.execution.id)
    assert.ok(await pinned(second.execution.id))
    assert.ok(!(await pinned(first.execution.id)))
    // The answer's own evidence stays pinned.
    assert.ok(await pinned(evidence.executionId))

    const history = await alice.call<Ok<SavedQueryRunPage>>(`${savedPath(saved.id)}/runs?limit=1`)
    assert.equal(history.status, 200, history.text)
    assert.deepEqual(history.body.result.runs.map((item: ExecutionSummary) => item.id), [second.execution.id])
    assert.equal(history.body.result.nextOffset, 1)
    const older = await alice.call<Ok<SavedQueryRunPage>>(`${savedPath(saved.id)}/runs?limit=1&offset=1`)
    assert.deepEqual(older.body.result.runs.map((item) => item.id), [first.execution.id])
    assert.equal(older.body.result.nextOffset, null)

    // The origin must be an execution the asker's answer cites.
    const madeUp = await create(owner, {
      name: "Made up origin",
      query: evidence.query,
      origin: { runId: answer.id, executionId: randomUUID() },
    })
    assert.equal(madeUp.status, 422, madeUp.text)
    const notTheirs = await create(alice, {
      name: "Someone else's answer",
      query: evidence.query,
      origin: { runId: answer.id, executionId: evidence.executionId },
    })
    assert.equal(notTheirs.status, 422, notTheirs.text)

    const taken = await create(bob, { name: "orders AND revenue by STATUS", query: evidence.query })
    assert.equal(taken.status, 409, taken.text)

    const nonMember = await outsider.call(savedPath(saved.id))
    assert.equal(nonMember.status, 404)
  },
)

test(
  "date parameters resolve in the workspace time zone, with defaults and overrides matching direct SQL",
  { skip },
  async () => {
    assert.equal(
      (await alice.call(`${base()}/settings/timezone`, { method: "PUT", json: { value: TIME_ZONE } })).status,
      403,
    )
    const badZone = await owner.call<Failure>(`${base()}/settings/timezone`, {
      method: "PUT",
      json: { value: "Mars/Olympus_Mons" },
    })
    assert.equal(badZone.status, 422, badZone.text)
    assert.match(badZone.body.error.message, /IANA time zone/)
    const zone = await owner.call(`${base()}/settings/timezone`, { method: "PUT", json: { value: TIME_ZONE } })
    assert.equal(zone.status, 200, zone.text)

    const parameters = [
      { name: "since", label: "Since", type: "datetime", default: { kind: "relative", value: "days_ago:7" } },
      { name: "until", label: "Until", type: "datetime", default: { kind: "relative", value: "today" } },
    ]
    const saved = await created(alice, {
      name: "Orders in a range",
      query: { language: "sql", sql: RANGE_SQL },
      parameters,
    })
    assert.equal(saved.timeZone, TIME_ZONE)
    assert.deepEqual(
      saved.defaults.map(({ name, from, value }) => ({ name, from, offset: value?.slice(-6) })),
      [
        { name: "since", from: "default", offset: "+05:30" },
        { name: "until", from: "default", offset: "+05:30" },
      ],
    )

    const defaults = await succeeded(bob, saved.id)
    const [since, until] = defaults.parameters.map((parameter) => parameter.value)
    assert.ok(since && until)
    assert.match(since, /T00:00:00\+05:30$/)
    assert.deepEqual(defaults.execution.parameters, { since, until })
    // What ran: positional parameters bound to the resolved values.
    assert.deepEqual(defaults.execution.query, {
      language: "sql",
      sql: RANGE_SQL.replace("{{since}}", "$1").replace("{{until}}", "$2"),
      params: [since, until],
    })
    const directSql = RANGE_SQL.replace("{{since}}", "$1").replace("{{until}}", "$2")
    assert.deepEqual(defaults.execution.result?.rows, await direct(directSql, [since, until]))

    const wider = await succeeded(bob, saved.id, { since: "days_ago:365", until: "2100-01-01" })
    assert.deepEqual(
      wider.parameters.map(({ name, from, input }) => ({ name, from, input })),
      [
        { name: "since", from: "run", input: { kind: "relative", value: "days_ago:365" } },
        { name: "until", from: "run", input: { kind: "absolute", value: "2100-01-01" } },
      ],
    )
    assert.equal(wider.parameters[1]?.value, "2100-01-01T00:00:00+05:30")
    const widerRows = await direct(directSql, wider.parameters.map((parameter) => parameter.value))
    assert.deepEqual(wider.execution.result?.rows, widerRows)
    const count = (rows: Cell[][] | undefined) => Number(rows?.[0]?.[0] ?? 0)
    assert.ok(count(wider.execution.result?.rows) > count(defaults.execution.result?.rows))

    // The run history shows what each run resolved to.
    const history = await bob.call<Ok<SavedQueryRunPage>>(`${savedPath(saved.id)}/runs`)
    assert.deepEqual(
      history.body.result.runs.map((item) => item.parameters?.until),
      ["2100-01-01T00:00:00+05:30", until],
    )

    // Unknown names and invalid values are refused before anything runs.
    const unknown = await run(bob, saved.id, { sinse: "2026-01-01" })
    assert.equal(unknown.status, 422, unknown.text)
    assert.equal(unknown.body.error.code, "INVALID_PARAMETERS")
    assert.deepEqual(unknown.body.error.details, { unknown: ["sinse"] })
    const invalid = await run(bob, saved.id, { since: "2026-02-30" })
    assert.equal(invalid.status, 422, invalid.text)
    assert.deepEqual(invalid.body.error.details?.invalid, [
      { name: "since", message: "2026-02-30 is not a date between the years 1000 and 9999." },
    ])
    const injected = await run(bob, saved.id, { since: "2026-01-01'); DELETE FROM shop.orders; --" })
    assert.equal(injected.status, 422, injected.text)

    // A required parameter without a default needs a value at run time.
    const required = await created(alice, {
      name: "Orders since a day",
      query: {
        language: "sql",
        sql: "SELECT count(*)::int AS orders FROM shop.orders WHERE ordered_at >= {{day}}::date",
      },
      parameters: [{ name: "day", type: "date", required: true }],
    })
    assert.deepEqual(required.defaults[0]?.value, null)
    const missing = await run(bob, required.id)
    assert.equal(missing.status, 422, missing.text)
    assert.deepEqual(missing.body.error.details, { missing: ["day"] })
    assert.equal((await run(bob, required.id, { day: "2025-01-01" })).status, 200)

    // Definitions and placeholders must match when saving.
    const unused = await create(alice, {
      name: "Unused parameter",
      query: { language: "sql", sql: "SELECT count(*) FROM shop.orders WHERE ordered_at >= {{since}}" },
      parameters: [...parameters],
    })
    assert.equal(unused.status, 422, unused.text)
    assert.deepEqual(unused.body.error.details, { unused: ["until"] })
    const undefinedName = await create(alice, {
      name: "Undefined parameter",
      query: { language: "sql", sql: "SELECT count(*) FROM shop.orders WHERE ordered_at >= {{start}}" },
    })
    assert.equal(undefinedName.status, 422, undefinedName.text)
    assert.deepEqual(undefinedName.body.error.details, { unknown: ["start"] })
    const badDefault = await create(alice, {
      name: "Bad default",
      query: { language: "sql", sql: "SELECT {{d}}::date" },
      parameters: [{ name: "d", type: "date", default: { kind: "absolute", value: "31/10/2026" } }],
    })
    assert.equal(badDefault.status, 422, badDefault.text)
    // Checked by the validators without running: a write is refused when saving.
    const write = await create(alice, {
      name: "A write",
      query: { language: "sql", sql: "DELETE FROM shop.orders" },
    })
    assert.equal(write.status, 422, write.text)
    assert.equal(write.body.error.code, "QUERY_REJECTED")
    assert.equal(write.body.error.details?.executionId, null)

    // Reading the database clock is allowed, with a warning.
    const clock = await created(alice, {
      name: "Orders today by the database clock",
      query: {
        language: "sql",
        sql: "SELECT count(*)::int AS orders FROM shop.orders WHERE ordered_at >= current_date",
      },
    })
    assert.equal(clock.warnings[0]?.code, "database_clock")
    assert.match(clock.warnings[0]?.message ?? "", /current_date/)

    await owner.call(`${base()}/settings/timezone`, { method: "PUT", json: { value: "UTC" } })
  },
)

test(
  "edits need the current version, private queries are their creator's, and members change only their own",
  { skip },
  async () => {
    const shared = await created(alice, { name: "Alice's shared query", query: evidence.query })
    const renamed = await alice.call<Ok<SavedQueryDetail>>(savedPath(shared.id), {
      method: "PATCH",
      json: { version: 1, name: "Alice's renamed query", description: "Now with a description." },
    })
    assert.equal(renamed.status, 200, renamed.text)
    assert.equal(renamed.body.result.version, 2)

    // A save based on version 1 is stale: 409 with the current record.
    const stale = await alice.call<Failure>(savedPath(shared.id), {
      method: "PATCH",
      json: { version: 1, name: "Overwrite" },
    })
    assert.equal(stale.status, 409, stale.text)
    const current = stale.body.error.details?.current as SavedQueryDetail
    assert.equal(current.version, 2)
    assert.equal(current.name, "Alice's renamed query")

    // Another member may read and run it, not change or delete it.
    assert.equal((await run(bob, shared.id)).status, 200)
    const bobEdit = await bob.call(savedPath(shared.id), {
      method: "PATCH",
      json: { version: 2, name: "Bob's now" },
    })
    assert.equal(bobEdit.status, 403, bobEdit.text)
    assert.equal((await bob.call(savedPath(shared.id), { method: "DELETE" })).status, 403)
    // An owner may.
    const ownerEdit = await owner.call<Ok<SavedQueryDetail>>(savedPath(shared.id), {
      method: "PATCH",
      json: { version: 2, query: { language: "sql", sql: "SELECT count(*)::int AS orders FROM shop.orders" } },
    })
    assert.equal(ownerEdit.status, 200, ownerEdit.text)
    assert.equal(ownerEdit.body.result.updatedBy?.id, ownerId)
    const badEdit = await owner.call(savedPath(shared.id), {
      method: "PATCH",
      json: { version: 3, query: { language: "sql", sql: "SELECT * FROM pg_catalog.pg_authid" } },
    })
    assert.equal(badEdit.status, 422, badEdit.text)

    // Private: only Alice sees, runs, or exports it; everyone else gets 404.
    const secret = await created(alice, {
      name: "Alice's private query",
      query: evidence.query,
      visibility: "private",
    })
    for (const client of [bob, owner]) {
      assert.equal((await client.call(savedPath(secret.id))).status, 404)
      assert.equal((await run(client, secret.id)).status, 404)
      assert.equal((await client.call(`${savedPath(secret.id)}/runs`)).status, 404)
      const edit = await client.call(savedPath(secret.id), { method: "PATCH", json: { version: 1, name: "x" } })
      assert.equal(edit.status, 404)
      assert.equal((await client.call(savedPath(secret.id), { method: "DELETE" })).status, 404)
      const list = await client.call<Ok<SavedQueryList>>(savedPath())
      assert.ok(!list.body.result.savedQueries.some((item) => item.id === secret.id))
    }
    const own = await alice.call<Ok<SavedQueryList>>(`${savedPath()}?connectionId=${connection.id}`)
    assert.ok(own.body.result.savedQueries.some((item) => item.id === secret.id))
    assert.equal((await run(alice, secret.id)).status, 200)

    const removed = await alice.call(savedPath(shared.id), { method: "DELETE" })
    assert.equal(removed.status, 200, removed.text)
    assert.equal((await alice.call(savedPath(shared.id))).status, 404)
    assert.equal((await outsider.call(savedPath())).status, 404)
  },
)

test(
  "reruns use the source's current schemas, and removing a source removes its saved queries",
  { skip },
  async () => {
    const tickets = await created(owner, {
      name: "Open tickets",
      query: { language: "sql", sql: "SELECT count(*)::int AS open FROM support.tickets WHERE status = 'open'" },
    })
    assert.equal((await run(owner, tickets.id)).status, 200)

    const narrowed = await owner.call(`${base()}/connections/${connection.id}`, {
      method: "PATCH",
      json: { schemas: ["shop"] },
    })
    assert.equal(narrowed.status, 200, narrowed.text)
    const refused = await run(alice, tickets.id)
    assert.equal(refused.status, 422, refused.text)
    assert.equal(refused.body.error.code, "QUERY_REJECTED")
    assert.match(
      refused.body.error.message,
      /"support\.tickets" is outside the schemas this source may read \(shop\)/,
    )
    assert.equal(refused.body.error.details?.reason, "relation_not_allowed")
    const recorded = await owner.call<Ok<ExecutionRecord>>(
      executionPath({ connectionId: connection.id, id: String(refused.body.error.details?.executionId) }),
    )
    assert.equal(recorded.body.result.status, "rejected")
    assert.equal(recorded.body.result.savedQueryId, tickets.id)
    const restored = await owner.call(`${base()}/connections/${connection.id}`, {
      method: "PATCH",
      json: { schemas: ["shop", "support"] },
    })
    assert.equal(restored.status, 200, restored.text)
    assert.equal((await run(alice, tickets.id)).status, 200)

    const copy = await saveSource("Removed copy")
    const onCopy = await created(owner, { name: "On the copy", connectionId: copy.id, query: evidence.query })
    assert.equal((await owner.call(`${base()}/connections/${copy.id}`, { method: "DELETE" })).status, 200)
    const gone = await owner.call<Failure>(savedPath(onCopy.id))
    assert.equal(gone.status, 404)
    assert.equal(gone.body.error.message, "Saved query not found")
    assert.equal((await run(owner, onCopy.id)).status, 404)
    const unknownSource = await create(owner, { name: "Nowhere", connectionId: copy.id, query: evidence.query })
    assert.equal(unknownSource.status, 422, unknownSource.text)
  },
)

test(
  "CSV exports equal the stored result cell for cell, for saved-query, console, and answer runs",
  { skip },
  async () => {
    const sql = `SELECT o.id, o.ordered_at, o.total, o.refunded_at, c.full_name,
        'say "hi", then
leave' AS note, '=1+1' AS formula, -12.5::numeric AS negative, o.status = 'delivered' AS delivered,
        NULL::text AS nothing
      FROM shop.orders o JOIN shop.customers c ON c.id = o.customer_id
     ORDER BY o.id LIMIT 40`
    const saved = await created(bob, { name: "Orders with awkward text", query: { language: "sql", sql } })
    const ran = await succeeded(bob, saved.id)
    const stored = await alice.call<Ok<ExecutionRecord>>(executionPath(ran.execution))
    const result = stored.body.result.result
    assert.ok(result)

    const { res, records } = await exported(alice, executionPath(ran.execution))
    const day = ran.execution.createdAt.slice(0, 10)
    assert.equal(
      res.headers.get("content-disposition"),
      `attachment; filename="manifest-query-${day}-${ran.execution.id.slice(0, 8)}.csv"`,
    )
    assert.equal(res.headers.get("x-manifest-truncated"), null)
    assert.deepEqual(records[0], result.columns.map((column) => column.name))
    assert.equal(records.length, result.rows.length + 1)
    result.rows.forEach((row, index) => {
      const cells = row.map((cell) => {
        const text = cellText(cell)
        return /^[=+\-@\t\r]/.test(text) && !/^[+-]?\d+(\.\d*)?$/.test(text) ? `'${text}` : text
      })
      assert.deepEqual(records[index + 1], cells, `row ${index + 1}`)
    })
    const first = records[1] ?? []
    assert.equal(first[5], 'say "hi", then\nleave')
    assert.equal(first[6], "'=1+1")
    assert.equal(first[7], "-12.5")
    assert.equal(first[8], result.rows[0]?.[8] ? "true" : "false")
    assert.equal(first[9], "", "NULL is empty")
    assert.match(first[1] ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

    // A result cut by its row limit says so, and its file name says partial.
    const many = await created(bob, {
      name: "Every order item",
      query: { language: "sql", sql: "SELECT id, order_id, line_total FROM shop.order_items ORDER BY id" },
    })
    const cut = await succeeded(bob, many.id)
    assert.equal(cut.execution.truncated, true)
    const partial = await exported(bob, executionPath(cut.execution))
    assert.equal(partial.res.headers.get("x-manifest-truncated"), "rows")
    assert.match(partial.res.headers.get("content-disposition") ?? "", /-partial\.csv"$/)
    assert.equal(partial.records.length, 1_001)

    // The answer's evidence and a console run export the same way.
    const evidenceRun = { connectionId: evidence.connectionId, id: evidence.executionId }
    const evidenceCsv = await exported(alice, executionPath(evidenceRun))
    assert.deepEqual(evidenceCsv.records.slice(1), evidence.rows.map((row) => row.map(cellText)))
    const consoleRun = await owner.call<Ok<ExecutionRecord>>(`${base()}/connections/${connection.id}/queries`, {
      method: "POST",
      json: { id: randomUUID(), query: { language: "sql", sql: "SELECT 1 AS one, NULL::text AS nothing" } },
    })
    assert.equal(consoleRun.status, 200, consoleRun.text)
    const consoleCsv = await exported(bob, executionPath(consoleRun.body.result))
    assert.deepEqual(consoleCsv.records, [["one", "nothing"], ["1", ""]])

    // Runs without rows, unknown runs, and non-members get no file.
    const failed = await owner.call<Ok<ExecutionRecord>>(`${base()}/connections/${connection.id}/queries`, {
      method: "POST",
      json: { id: randomUUID(), query: { language: "sql", sql: "SELECT 1 / 0" } },
    })
    assert.equal(failed.body.result.status, "failed")
    assert.equal((await owner.call(`${executionPath(failed.body.result)}/export.csv`)).status, 409)
    assert.equal(
      (await owner.call(`${executionPath({ connectionId: connection.id, id: randomUUID() })}/export.csv`)).status,
      404,
    )
    assert.equal((await outsider.call(`${executionPath(ran.execution)}/export.csv`)).status, 404)
  },
)

test("an answer exports as Markdown for the user who asked", { skip }, async () => {
  const path = `${base()}/agent/runs/${answer.id}/export.md`
  const res = await owner.call<string>(path)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8")
  const day = (answer.finishedAt ?? answer.createdAt).slice(0, 10)
  assert.equal(
    res.headers.get("content-disposition"),
    `attachment; filename="answer-what-are-orders-and-revenue-by-status-revenue-${day}.md"`,
  )
  assert.match(res.text, /^# What are orders and revenue by status\? \[revenue\]\n/)
  assert.match(res.text, /Orders and revenue by status are below\./)
  assert.match(res.text, /### 1\. Orders and revenue by status\n\nSource: Demo store \(synthetic\)/)
  assert.ok(res.text.includes(`\`\`\`sql\n${REVENUE_SQL}\n\`\`\``))
  assert.match(res.text, /\| status \| orders \| revenue \|/)
  for (const row of evidence.rows) assert.ok(res.text.includes(`| ${row.map(String).join(" | ")} |`))

  // Runs are private: other members get the same 404 as a missing run.
  assert.equal((await alice.call(path)).status, 404)
  assert.equal((await owner.call(`${base()}/agent/runs/${randomUUID()}/export.md`)).status, 404)
  assert.equal((await outsider.call(path)).status, 404)
  assert.ok(consoleCapture.lines.every((line) => !line.includes(source.password)))
})
