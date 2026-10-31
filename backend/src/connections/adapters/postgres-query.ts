import type { ClientBase, CustomTypesConfig, FieldDef, QueryArrayConfig, QueryConfig } from "pg"

import {
  postgresColumns,
  type PostgresColumn,
  type PostgresTypeInfo,
} from "../../queries/postgres-values.js"
import { ResultCollector } from "../../queries/results.js"
import type { QueryResult, SqlQuery } from "../../queries/schemas.js"
import { SourceQueryError, type QueryRunRequest } from "./types.js"

const CURSOR = "manifest_query"
const FETCH_BATCH = 500
/** One row first; later batches are sized from the bytes rows took so far, to stay near this. */
const TARGET_BATCH_BYTES = 1024 * 1024
/**
 * One step of the user's query (DECLARE or a FETCH) may bring at most this
 * much from the source. A larger response (a huge value, or an error message
 * quoting one) closes the connection instead of being read into memory.
 */
const MAX_FETCH_BYTES = 8 * 1024 * 1024
/** Waiting for a locked table (e.g. during a migration) ends sooner than the query's own timeout. */
const MAX_LOCK_TIMEOUT_MS = 10_000
/** The server ends the session if it sits idle inside the transaction, e.g. if this process stalls. */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000
/** pg's own per-call read timeout stays behind the server timeout and the executor's deadline. */
const READ_TIMEOUT_GRACE_MS = 5_000

// DateStyle and bytea_output only change how values are written, so the
// encoders can rely on ISO dates and hex binaries. pg_catalog goes last in
// search_path so selected schemas win for unqualified names.
// standard_conforming_strings matches the validator's parser: with it off,
// a backslash before a quote would end string literals in different places.
const SESSION_SQL = `
  SELECT set_config('statement_timeout', $1, true),
         set_config('lock_timeout', $2, true),
         set_config('idle_in_transaction_session_timeout', $3, true),
         set_config('search_path', $4, true),
         set_config('standard_conforming_strings', 'on', true),
         set_config('DateStyle', 'ISO', true),
         set_config('bytea_output', 'hex', true)`

const TYPES_SQL = `
  SELECT t.oid, pg_catalog.format_type(t.oid, NULL) AS name, t.typcategory AS category,
         CASE WHEN t.typtype = 'd' THEN t.typbasetype END AS base
    FROM pg_catalog.pg_type t
   WHERE t.oid = ANY ($1::oid[])`

/** Every value arrives as PostgreSQL's text output; postgres-values.ts encodes it. */
const TEXT_VALUES: CustomTypesConfig = { getTypeParser: () => (value: string) => value }

/** Options pg supports that its type definitions leave out. */
interface CallOptions {
  query_timeout: number
  queryMode?: "extended"
}

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`

interface SourceSocket {
  on(event: "data", listener: (chunk: Buffer) => void): unknown
  off(event: "data", listener: (chunk: Buffer) => void): unknown
  destroy(): void
}

/**
 * Runs `call` and counts the bytes it reads from the source. Past
 * MAX_FETCH_BYTES the connection is closed, so the rest is never buffered;
 * the server ends the session once it cannot send.
 */
async function readBounded<T>(client: ClientBase, call: () => Promise<T>): Promise<{ value: T; bytes: number }> {
  const socket = (client as unknown as { connection?: { stream?: SourceSocket } }).connection?.stream
  if (!socket) throw new Error("The PostgreSQL client has no socket to bound")
  let bytes = 0
  let exceeded = false
  const count = (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > MAX_FETCH_BYTES && !exceeded) {
      exceeded = true
      socket.destroy()
    }
  }
  socket.on("data", count)
  try {
    return { value: await call(), bytes }
  } catch (error) {
    if (!exceeded) throw error
    throw new SourceQueryError(
      `The source sent more than ${MAX_FETCH_BYTES / 1024 / 1024} MB at once (for example a single very large value), too large to read. Select fewer or smaller columns.`,
    )
  } finally {
    socket.off("data", count)
  }
}

async function typeInfo(client: ClientBase, fields: FieldDef[], call: CallOptions) {
  const oids = [...new Set(fields.map((field) => field.dataTypeID))]
  const types = new Map<number, PostgresTypeInfo>()
  if (oids.length === 0) return types
  const { rows } = await client.query<PostgresTypeInfo>({
    text: TYPES_SQL,
    values: [oids],
    ...call,
  } as QueryConfig)
  for (const row of rows) types.set(row.oid, row)
  return types
}

/**
 * Runs one validated SELECT inside a READ ONLY transaction with the
 * request's timeouts and the selected schemas as search_path, reads at most
 * maxRows + 1 rows through a cursor, and rolls back. The caller owns the
 * client and its cancellation.
 */
export async function readQueryRows(
  client: ClientBase,
  query: SqlQuery,
  request: QueryRunRequest,
): Promise<QueryResult> {
  const { maxRows, timeoutMs } = request.limits
  const { signal } = request
  const started = performance.now()
  const call: CallOptions = { query_timeout: timeoutMs + READ_TIMEOUT_GRACE_MS }

  await client.query("BEGIN READ ONLY")
  await client.query({
    text: SESSION_SQL,
    values: [
      String(timeoutMs),
      String(Math.min(timeoutMs, MAX_LOCK_TIMEOUT_MS)),
      String(IDLE_IN_TRANSACTION_TIMEOUT_MS),
      [...request.schemas.map(quoteIdentifier), "pg_catalog"].join(", "),
    ],
    ...call,
  } as QueryConfig)
  signal.throwIfAborted()
  // The extended protocol refuses a second statement, and DECLARE accepts only a query.
  await readBounded(client, () =>
    client.query({
      text: `DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${query.sql}`,
      queryMode: "extended",
      ...call,
    } as QueryConfig),
  )

  const collector = new ResultCollector(maxRows)
  let columns: PostgresColumn[] | null = null
  let bytesRead = 0
  let rowsRead = 0
  while (!collector.full) {
    signal.throwIfAborted()
    const sized =
      rowsRead === 0 ? 1 : Math.floor(TARGET_BATCH_BYTES / Math.max(1, bytesRead / rowsRead))
    const batch = Math.min(FETCH_BATCH, maxRows + 1 - collector.rows.length, Math.max(1, sized))
    const { value, bytes } = await readBounded(client, () =>
      client.query<unknown[]>({
        text: `FETCH FORWARD ${batch} FROM ${CURSOR}`,
        rowMode: "array",
        types: TEXT_VALUES,
        ...call,
      } as QueryArrayConfig),
    )
    const { rows, fields } = value
    bytesRead += bytes
    rowsRead += rows.length
    columns ??= postgresColumns(fields, await typeInfo(client, fields, call))
    const encoders = columns
    for (const row of rows) {
      const cells = row.map((value, index) => encoders[index]?.encode(value as string | null) ?? null)
      if (!collector.add(cells)) break
    }
    if (rows.length < batch) break
  }
  await client.query("ROLLBACK")

  return {
    columns: (columns ?? []).map((entry) => entry.column),
    rows: collector.rows,
    rowCount: collector.rows.length,
    truncated: collector.full,
    truncatedBy: collector.truncatedBy,
    durationMs: Math.round(performance.now() - started),
  }
}
