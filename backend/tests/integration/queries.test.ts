import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import test, { after, before } from "node:test"

import type { Pool } from "pg"

import { loadEnv } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import { KEPT_EXECUTIONS, QueryExecutionsRepository } from "../../src/queries/repository.js"
import { QueryRunner } from "../../src/queries/runner.js"
import type { ExecutionRecord, ExecutionSummary } from "../../src/queries/schemas.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { buildDemoSource } from "../../src/storage/demo-source-builder.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"
import { captureConsole } from "./support/console.js"
import { signIn, TestClient, type TestResponse } from "./support/http.js"
import { manifestClient, waitFor } from "./support/manifests.js"
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
  error: {
    code: string
    message: string
    details?: { executionId?: string; reason?: string; name?: string; retryAfterSeconds?: number }
  }
}

let storage: Pool
let sourcePool: Pool
let sources: SourceAdapters
let refreshes: RefreshRunner
let queries: QueryRunner
let running: RunningApp
let consoleCapture: ReturnType<typeof captureConsole>
let owner: TestClient
let member: TestClient
let outsider: TestClient
let acme: Workspace
let globex: Workspace
let source: { config: { host: string; port: number; database: string; username: string; sslMode: string }; password: string }
let connection: Connection

const queriesPath = (workspace = acme, connectionId = connection.id) =>
  `/api/v1/workspaces/${workspace.id}/connections/${connectionId}/queries`

function run(
  client: TestClient,
  sql: string,
  options: { id?: string; maxRows?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TestResponse<Ok<ExecutionRecord> & Failure>> {
  const { id = randomUUID(), signal, ...limits } = options
  return client.call(queriesPath(), {
    method: "POST",
    json: { id, query: { language: "sql", sql }, ...limits },
    ...(signal ? { signal } : {}),
  })
}

async function succeeded(sql: string, options: { maxRows?: number } = {}): Promise<ExecutionRecord> {
  const res = await run(owner, sql, options)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.result.status, "succeeded", JSON.stringify(res.body.result.error))
  return res.body.result
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

/**
 * Waits until this app has `count` sessions sleeping in pg_sleep on the source.
 * (pg_stat_activity shows the cursor's FETCH, not the query text.)
 */
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

const noBusySessions = () => waitFor(busySourceSessions, (count) => count === 0, "no busy source sessions")

before(async () => {
  if (skip) return
  storage = createPool(TEST_DATABASE_URL as string)
  await resetStorage(storage)
  sourcePool = createPool(TEST_SOURCE_DATABASE_URL as string)
  await buildDemoSource(sourcePool)
  await sourcePool.query("DROP SEQUENCE IF EXISTS shop.manifest_it_seq")
  await sourcePool.query("CREATE SEQUENCE shop.manifest_it_seq")
  source = sourceSettings(TEST_SOURCE_DATABASE_URL as string)

  consoleCapture = captureConsole()
  sources = createSourceAdapters()
  refreshes = new RefreshRunner()
  queries = new QueryRunner()
  const env = loadEnv({
    NODE_ENV: "test",
    ALLOW_DEV_LOGIN: "true",
    SESSION_SECRET,
    CONNECTION_ENCRYPTION_KEY: KEY,
  })
  running = await startApp(createApp(env, { pool: storage, sources, refreshes, queries }))

  owner = (await signIn(running.baseUrl, "owner@example.com", "Owner")).client
  const created = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
  })
  assert.equal(created.status, 201, created.text)
  acme = created.body.result
  const other = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Globex", slug: "globex" },
  })
  globex = other.body.result
  const memberSession = await signIn(running.baseUrl, "member@example.com", "Member")
  member = memberSession.client
  await new WorkspacesRepository(storage).addMember(acme.id, memberSession.context.user.id, "member")
  outsider = (await signIn(running.baseUrl, "outsider@example.com", "Outsider")).client

  const saved = await owner.call<Ok<Connection>>(`/api/v1/workspaces/${acme.id}/connections`, {
    method: "POST",
    json: {
      name: "Demo store (synthetic)",
      engine: "postgres",
      config: source.config,
      password: source.password,
      schemas: ["shop", "support"],
    },
  })
  assert.equal(saved.status, 201, saved.text)
  connection = saved.body.result
  // Unqualified table names resolve against the published manifest.
  const reads = manifestClient(owner, `/api/v1/workspaces/${acme.id}/connections/${connection.id}/manifest`)
  const first = await reads.latestRefresh()
  assert.ok(first)
  assert.equal((await reads.finished(first.id)).status, "succeeded")
})

after(async () => {
  if (skip) return
  consoleCapture.restore()
  await running.close()
  await queries.shutdown()
  await refreshes.shutdown()
  await closeSourceAdapters(sources)
  await storage.end()
  await sourcePool.query("DROP SEQUENCE IF EXISTS shop.manifest_it_seq")
  await sourcePool.end()
})

test("a bounded select returns typed columns, exact numbers, duplicate names, and a stored snapshot", { skip }, async () => {
  const record = await succeeded(
    `SELECT o.id, c.id, o.total, o.ordered_at, NULL::text AS nothing
       FROM orders o JOIN shop.customers c ON c.id = o.customer_id
      ORDER BY o.id`,
    { maxRows: 5 },
  )
  assert.equal(record.origin, "console")
  assert.equal(record.language, "sql")
  assert.deepEqual(record.limits, { maxRows: 5, timeoutMs: 30_000 })
  const result = record.result
  assert.ok(result)
  assert.deepEqual(
    result.columns.map((column) => [column.name, column.kind]),
    [["id", "integer"], ["id", "integer"], ["total", "decimal"], ["ordered_at", "datetime"], ["nothing", "text"]],
  )
  assert.equal(result.columns[2]?.type, "numeric")
  assert.equal(result.rowCount, 5)
  assert.equal(result.rows.length, 5)
  assert.equal(result.truncated, true)
  assert.equal(result.truncatedBy, "rows")
  assert.equal(record.rowCount, 5)

  const expected = await sourcePool.query<{ id: number; customer_id: number; total: string }>(
    "SELECT id, customer_id, total::text AS total FROM shop.orders ORDER BY id LIMIT 5",
  )
  assert.deepEqual(
    result.rows.map((row) => row.slice(0, 3)),
    expected.rows.map((row) => [row.id, row.customer_id, row.total]),
  )
  assert.match(String(result.rows[0]?.[3]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  assert.equal(result.rows[0]?.[4], null)

  const stored = await owner.call<Ok<ExecutionRecord>>(`${queriesPath()}/${record.id}`)
  assert.equal(stored.status, 200, stored.text)
  assert.deepEqual(stored.body.result.result?.rows, result.rows)
  assert.equal(stored.body.result.partialResult, false)
})

test("joins and aggregates match the source, with bigint counts kept as exact strings", { skip }, async () => {
  const record = await succeeded(`
    SELECT c.segment, count(*) AS orders, sum(o.total) AS revenue, 9007199254740993::int8 AS big
      FROM shop.orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status <> 'cancelled'
     GROUP BY c.segment ORDER BY c.segment`)
  const expected = await sourcePool.query<{ segment: string; orders: string; revenue: string }>(`
    SELECT c.segment, count(*)::text AS orders, sum(o.total)::text AS revenue
      FROM shop.orders o JOIN shop.customers c ON c.id = o.customer_id
     WHERE o.status <> 'cancelled'
     GROUP BY c.segment ORDER BY c.segment`)
  assert.deepEqual(
    record.result?.rows,
    expected.rows.map((row) => [row.segment, row.orders, row.revenue, "9007199254740993"]),
  )
  assert.equal(record.result?.truncated, false)
  assert.equal(record.result?.truncatedBy, null)
  assert.deepEqual(
    record.result?.columns.map((column) => column.type),
    ["text", "bigint", "numeric", "bigint"],
  )

  const cte = await succeeded(`
    WITH ranked AS (
      SELECT customer_id, total, rank() OVER (PARTITION BY customer_id ORDER BY total DESC) AS r
        FROM shop.orders)
    SELECT count(*)::int AS top_orders FROM ranked WHERE r = 1`)
  assert.equal(typeof cte.result?.rows[0]?.[0], "number")
})

test("a result over 5 MB stops at the byte limit and its stored snapshot stays within 2 MB", { skip }, async () => {
  const record = await succeeded("SELECT n, repeat('x', 100000) AS filler FROM generate_series(1, 100) AS g(n)")
  const result = record.result
  assert.ok(result)
  assert.equal(result.truncated, true)
  assert.equal(result.truncatedBy, "bytes")
  assert.ok(result.rowCount > 40 && result.rowCount < 60, String(result.rowCount))
  const stored = (await owner.call<Ok<ExecutionRecord>>(`${queriesPath()}/${record.id}`)).body.result
  assert.equal(stored.rowCount, result.rowCount)
  assert.equal(stored.partialResult, true)
  assert.ok((stored.result?.rows.length ?? 0) <= 21)
  assert.equal(stored.result?.truncatedBy, "bytes")
})

test("rows too large to read are stopped before they are buffered, and the source session ends", { skip }, async () => {
  const res = await run(owner, "SELECT 1 AS n, repeat('x', 20000000) AS huge")
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.result.status, "failed")
  assert.equal(res.body.result.error?.code, "QUERY_FAILED")
  assert.match(res.body.result.error?.message ?? "", /too large to read/)
  await noBusySessions()
  // PostgreSQL quotes the value in this error, raised while DECLARE plans the query.
  const quoted = await run(owner, "SELECT repeat('x', 20000000)::int AS n")
  assert.equal(quoted.body.result.status, "failed")
  assert.match(quoted.body.result.error?.message ?? "", /too large to read/)
  await noBusySessions()
  // Rows of 1 MB still read in small batches and stop at the byte limit.
  const wide = await succeeded("SELECT n, repeat('y', 1000000) AS filler FROM generate_series(1, 20) AS g(n)")
  assert.equal(wide.result?.truncatedBy, "bytes")
  assert.ok((wide.result?.rowCount ?? 0) >= 4, String(wide.result?.rowCount))
})

test("string literals are read as the validator parsed them, even if the source defaults otherwise", { skip }, async () => {
  const database = new URL(TEST_SOURCE_DATABASE_URL as string).pathname.slice(1).replaceAll('"', '""')
  await sourcePool.query(`ALTER DATABASE "${database}" SET standard_conforming_strings = off`)
  try {
    // New sessions pick up the database default.
    await sources.postgres.evict(connection.id)
    // With nonstandard strings this would read pg_catalog.pg_class, which validation never saw.
    const record = await succeeded(String.raw`SELECT 'a\' , ' AS x FROM pg_catalog.pg_class --'`)
    assert.deepEqual(record.result?.rows, [["a\\", " AS x FROM pg_catalog.pg_class --"]])
  } finally {
    await sourcePool.query(`ALTER DATABASE "${database}" RESET standard_conforming_strings`)
    await sources.postgres.evict(connection.id)
  }
})

test("disallowed SQL is rejected with 422, a reason, and the offending name, and is recorded", { skip }, async () => {
  const cases: [string, string, string | null][] = [
    ["DELETE FROM shop.orders", "statement_not_allowed", "DELETE"],
    ["SELECT 1; DELETE FROM shop.orders", "multiple_statements", null],
    ["SELECT 1 /* ; */ ; DROP TABLE shop.orders", "multiple_statements", null],
    ["WITH gone AS (DELETE FROM shop.orders RETURNING *) SELECT count(*) FROM gone", "statement_not_allowed", "DELETE"],
    ["SELECT * INTO shop.orders_copy FROM shop.orders", "statement_not_allowed", "SELECT INTO"],
    ["SELECT * FROM shop.orders FOR UPDATE", "statement_not_allowed", "FOR UPDATE"],
    ["EXPLAIN SELECT 1", "statement_not_allowed", "EXPLAIN"],
    ["SELECT set_config('search_path', 'public', false)", "function_not_allowed", "set_config"],
    ["SELECT pg_advisory_lock(42)", "function_not_allowed", "pg_advisory_lock"],
    ["SELECT * FROM pg_stat_activity", "relation_not_allowed", "pg_stat_activity"],
    ["SELECT * FROM information_schema.tables", "relation_not_allowed", "information_schema.tables"],
    ["SELECT * FROM public.anything", "relation_not_allowed", "public.anything"],
    ["SELECT * FROM not_in_manifest", "relation_not_allowed", "not_in_manifest"],
    ["SELEC 1", "syntax_error", null],
  ]
  const ordersBefore = (await sourcePool.query("SELECT count(*) FROM shop.orders")).rows[0]
  for (const [sql, reason, name] of cases) {
    const res = await run(owner, sql)
    assert.equal(res.status, 422, `${sql}: ${res.text}`)
    assert.equal(res.body.error.code, "QUERY_REJECTED")
    assert.equal(res.body.error.details?.reason, reason, sql)
    assert.equal(res.body.error.details?.name ?? null, name, sql)
    const recorded = await owner.call<Ok<ExecutionRecord>>(
      `${queriesPath()}/${res.body.error.details?.executionId}`,
    )
    assert.equal(recorded.body.result.status, "rejected")
    assert.equal(recorded.body.result.error?.reason, reason)
  }
  const mongo = await owner.call<Failure>(queriesPath(), {
    method: "POST",
    json: {
      id: randomUUID(),
      query: { language: "mongodb", database: "shop", collection: "orders", operation: "find" },
    },
  })
  assert.equal(mongo.status, 422)
  assert.equal(mongo.body.error.details?.reason, "language_not_supported")
  // Shape errors are request validation failures, not recorded executions.
  const malformed = await owner.call<Failure>(queriesPath(), {
    method: "POST",
    json: { id: "not-a-uuid", query: { language: "sql", sql: "SELECT 1" } },
  })
  assert.equal(malformed.status, 422)
  assert.equal(malformed.body.error.code, "VALIDATION_FAILED")
  const tooMany = await owner.call<Failure>(queriesPath(), {
    method: "POST",
    json: { id: randomUUID(), query: { language: "sql", sql: "SELECT 1" }, maxRows: 5001 },
  })
  assert.equal(tooMany.status, 422)
  assert.deepEqual((await sourcePool.query("SELECT count(*) FROM shop.orders")).rows[0], ordersBefore)
})

test("writes that slip past validation still fail inside the read-only transaction", { skip }, async () => {
  const res = await run(owner, "SELECT nextval('shop.manifest_it_seq')")
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.result.status, "failed")
  assert.equal(res.body.result.error?.code, "QUERY_FAILED")
  assert.match(res.body.result.error?.message ?? "", /read-only transaction/)
  const failing = await run(owner, "SELECT missing_column FROM shop.orders")
  assert.equal(failing.body.result.status, "failed")
  assert.match(failing.body.result.error?.message ?? "", /^Column "missing_column" does not exist/)
  await noBusySessions()
})

test("a query past its time limit is timed out and leaves no work on the source", { skip }, async () => {
  const started = performance.now()
  const res = await run(owner, "SELECT pg_sleep(5)", { timeoutMs: 1_000 })
  assert.equal(res.status, 200, res.text)
  const record = res.body.result
  assert.equal(record.status, "timed_out")
  assert.equal(record.error?.code, "QUERY_TIMEOUT")
  assert.match(record.error?.message ?? "", /longer than 1 second/)
  assert.ok(performance.now() - started < 3_500, "stopped near the limit")
  assert.ok((record.durationMs ?? 0) >= 900)
  await noBusySessions()
})

test("cancelling a running query stops it on the source; so does closing the request", { skip }, async () => {
  const id = randomUUID()
  const pending = run(owner, "SELECT pg_sleep(20)", { id })
  await sleepingOnSource()
  const cancelled = await owner.call<Ok<ExecutionRecord>>(`${queriesPath()}/${id}/cancel`, { method: "POST" })
  assert.equal(cancelled.status, 200, cancelled.text)
  assert.equal(cancelled.body.result.status, "cancelled")
  assert.equal(cancelled.body.result.error?.code, "QUERY_CANCELLED")
  const answered = await pending
  assert.equal(answered.status, 200)
  assert.equal(answered.body.result.status, "cancelled")
  await noBusySessions()

  const again = await owner.call<Failure>(`${queriesPath()}/${id}/cancel`, { method: "POST" })
  assert.equal(again.status, 409)

  // A browser leaving the page closes the request, which cancels the query.
  const leave = new AbortController()
  const closedId = randomUUID()
  const closed = run(owner, "SELECT pg_sleep(20)", { id: closedId, signal: leave.signal })
  await sleepingOnSource()
  leave.abort()
  await assert.rejects(closed)
  const record = await waitFor(
    async () => (await owner.call<Ok<ExecutionRecord>>(`${queriesPath()}/${closedId}`)).body.result,
    (execution) => execution.status !== "running",
    "the abandoned query to end",
  )
  assert.equal(record.status, "cancelled")
  await noBusySessions()
})

test("a third concurrent query on one source fails fast with 429 QUERY_BUSY", { skip }, async () => {
  const first = randomUUID()
  const second = randomUUID()
  const slow = [
    run(owner, "SELECT pg_sleep(10)", { id: first }),
    run(owner, "SELECT pg_sleep(10)", { id: second }),
  ]
  await sleepingOnSource(2)
  const thirdId = randomUUID()
  const third = await run(owner, "SELECT 1", { id: thirdId })
  assert.equal(third.status, 429, third.text)
  assert.equal(third.body.error.code, "QUERY_BUSY")
  assert.equal(third.headers.get("retry-after"), "5")
  assert.equal(third.body.error.details?.retryAfterSeconds, 5)
  // Not started, so not recorded: the same id can be retried.
  assert.equal((await owner.call(`${queriesPath()}/${thirdId}`)).status, 404)

  for (const id of [first, second]) {
    const res = await owner.call<Ok<ExecutionRecord>>(`${queriesPath()}/${id}/cancel`, { method: "POST" })
    assert.equal(res.body.result.status, "cancelled")
  }
  await Promise.all(slow)
  assert.equal((await run(owner, "SELECT 1", { id: thirdId })).status, 200)
  await noBusySessions()
})

test("members read executions but cannot run, list, or cancel others' queries; others get 404", { skip }, async () => {
  const record = await succeeded("SELECT 1 AS one")
  const member403 = await run(member, "SELECT 1")
  assert.equal(member403.status, 403)
  assert.equal((await member.call(queriesPath())).status, 403)
  const read = await member.call<Ok<ExecutionRecord>>(`${queriesPath()}/${record.id}`)
  assert.equal(read.status, 200, read.text)
  assert.deepEqual(read.body.result.result?.rows, [[1]])

  const id = randomUUID()
  const pending = run(owner, "SELECT pg_sleep(10)", { id })
  await sleepingOnSource()
  assert.equal((await member.call(`${queriesPath()}/${id}/cancel`, { method: "POST" })).status, 403)
  assert.equal(
    (await member.call(`${queriesPath()}/${id}/cancel`, { method: "POST", csrf: false })).status,
    403,
  )
  assert.equal((await owner.call(`${queriesPath()}/${id}/cancel`, { method: "POST" })).status, 200)
  assert.equal((await pending).body.result.status, "cancelled")

  assert.equal((await outsider.call(`${queriesPath()}/${record.id}`)).status, 404)
  assert.equal((await run(outsider, "SELECT 1")).status, 404)
  // Another workspace of the same owner cannot reach this execution or source.
  assert.equal((await owner.call(`${queriesPath(globex)}/${record.id}`)).status, 404)
  assert.equal((await owner.call(queriesPath(globex))).status, 404)

  const duplicate = await run(owner, "SELECT 2", { id: record.id })
  assert.equal(duplicate.status, 409)
  const withoutCsrf = await owner.call(queriesPath(), {
    method: "POST",
    csrf: false,
    json: { id: randomUUID(), query: { language: "sql", sql: "SELECT 1" } },
  })
  assert.equal(withoutCsrf.status, 403)
})

test("history lists recent executions newest first, without rows", { skip }, async () => {
  const latest = await succeeded("SELECT 'latest' AS marker")
  const res = await owner.call<Ok<ExecutionSummary[]>>(`${queriesPath()}?limit=3`)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.result.length, 3)
  assert.equal(res.body.result[0]?.id, latest.id)
  assert.ok(res.body.result.every((entry) => !("result" in entry)))
  assert.ok(res.body.result.some((entry) => entry.status === "cancelled"))
  assert.equal((await owner.call(`${queriesPath()}?limit=500`)).status, 422)
})

test("a restart marks executions left running as failed", { skip }, async () => {
  const repository = new QueryExecutionsRepository(storage)
  const id = randomUUID()
  await repository.insert(
    {
      id,
      workspaceId: acme.id,
      connectionId: connection.id,
      userId: null,
      origin: "console",
      query: { language: "sql", sql: "SELECT 1" },
      limits: { maxRows: 10, timeoutMs: 1_000 },
    },
    { status: "running" },
  )
  assert.ok((await repository.failInterrupted()) >= 1)
  const record = await repository.get(acme.id, connection.id, id)
  assert.equal(record?.status, "failed")
  assert.equal(record?.error?.code, "QUERY_INTERRUPTED")
})

test("history is pruned to the newest executions per workspace", { skip }, async () => {
  const repository = new QueryExecutionsRepository(storage)
  const start = (id: string) => ({
    id,
    workspaceId: acme.id,
    connectionId: connection.id,
    userId: null,
    origin: "console" as const,
    query: { language: "sql" as const, sql: "SELECT 1" },
    limits: { maxRows: 10, timeoutMs: 1_000 },
  })
  const error = { code: "QUERY_REJECTED", message: "Refused for the test.", reason: null, name: null }
  let newest = ""
  for (let index = 0; index < KEPT_EXECUTIONS + 5; index += 1) {
    newest = randomUUID()
    await repository.insert(start(newest), { status: "rejected", error })
  }
  const { rows } = await storage.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM query_executions WHERE workspace_id = $1",
    [acme.id],
  )
  assert.equal(rows[0]?.count, KEPT_EXECUTIONS)
  assert.ok(await repository.get(acme.id, connection.id, newest))
})

test("shutting down aborts running queries, records them, and leaves no work on the source", { skip }, async () => {
  const pending = run(owner, "SELECT pg_sleep(10)")
  await sleepingOnSource()
  await queries.shutdown()
  const res = await pending
  assert.equal(res.body.result.status, "failed")
  assert.equal(res.body.result.error?.code, "QUERY_INTERRUPTED")
  await noBusySessions()
})

test("passwords never appear in responses or console output", { skip }, () => {
  const responses = [...owner.responses, ...member.responses, ...outsider.responses]
  assert.ok(responses.length > 30)
  for (const text of [...responses, ...consoleCapture.lines]) {
    assert.ok(!text.includes(source.password), "the source password leaked")
    assert.ok(!/sealed_?secret/i.test(text), "the sealed secret leaked")
  }
})
