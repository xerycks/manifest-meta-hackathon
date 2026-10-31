import type { Pool } from "pg"

import { snapshotRows } from "./results.js"
import type {
  Cell,
  ExecutionError,
  ExecutionRecord,
  ExecutionStatus,
  ExecutionSummary,
  QueryLimits,
  QueryOrigin,
  QueryResult,
  ReadQuery,
  ResultColumn,
  TruncatedBy,
} from "./schemas.js"

/** Executions kept per workspace; older finished ones are pruned as new ones start. */
export const KEPT_EXECUTIONS = 200

/** What an execution is about, fixed when it starts. */
export interface ExecutionStart {
  id: string
  workspaceId: string
  connectionId: string
  userId: string | null
  origin: QueryOrigin
  query: ReadQuery
  limits: QueryLimits
}

export type ExecutionOutcome =
  | { status: "succeeded"; result: QueryResult }
  | { status: "failed" | "cancelled" | "timed_out"; error: ExecutionError; durationMs: number }

interface ExecutionRow {
  id: string
  connection_id: string
  user_id: string | null
  origin: QueryOrigin
  query: ReadQuery
  max_rows: number
  timeout_ms: number
  status: ExecutionStatus
  row_count: number | null
  truncated: boolean
  truncated_by: TruncatedBy | null
  duration_ms: number | null
  error: ExecutionError | null
  result?: { columns: ResultColumn[]; rows: Cell[][] } | null
  created_at: Date
  finished_at: Date | null
}

const SUMMARY_COLUMNS = `id, connection_id, user_id, origin, query, max_rows, timeout_ms, status,
  row_count, truncated, truncated_by, duration_ms, error, created_at, finished_at`
const RECORD_COLUMNS = `${SUMMARY_COLUMNS}, result`

function toSummary(row: ExecutionRow): ExecutionSummary {
  return {
    id: row.id,
    connectionId: row.connection_id,
    userId: row.user_id,
    origin: row.origin,
    language: row.query.language,
    query: row.query,
    limits: { maxRows: row.max_rows, timeoutMs: row.timeout_ms },
    status: row.status,
    rowCount: row.row_count,
    truncated: row.truncated,
    truncatedBy: row.truncated_by,
    durationMs: row.duration_ms,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  }
}

function toRecord(row: ExecutionRow): ExecutionRecord {
  const summary = toSummary(row)
  const stored = row.result ?? null
  const result: QueryResult | null = stored
    ? {
        columns: stored.columns,
        rows: stored.rows,
        rowCount: row.row_count ?? stored.rows.length,
        truncated: row.truncated,
        truncatedBy: row.truncated_by,
        durationMs: row.duration_ms ?? 0,
      }
    : null
  return {
    ...summary,
    result,
    partialResult: result !== null && result.rows.length < result.rowCount,
  }
}

function firstRecord(rows: ExecutionRow[]): ExecutionRecord | null {
  return rows[0] ? toRecord(rows[0]) : null
}

/** Execution records; every query is scoped by workspace_id. */
export class QueryExecutionsRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Records an execution that starts running, or one validation rejected.
   * Rejects with a unique violation (23505) when the id is already used in
   * the workspace. Old finished executions are pruned first.
   */
  async insert(
    start: ExecutionStart,
    initial: { status: "running" } | { status: "rejected"; error: ExecutionError },
  ): Promise<ExecutionRecord> {
    await this.pool.query(
      `DELETE FROM query_executions
        WHERE workspace_id = $1 AND status <> 'running'
          AND id NOT IN (
            SELECT id FROM query_executions WHERE workspace_id = $1
             ORDER BY created_at DESC LIMIT ${KEPT_EXECUTIONS - 1})`,
      [start.workspaceId],
    )
    const rejected = initial.status === "rejected"
    const { rows } = await this.pool.query<ExecutionRow>(
      `INSERT INTO query_executions
         (id, workspace_id, connection_id, user_id, origin, language, query, max_rows, timeout_ms,
          status, error, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::json, $8, $9, $10, $11::json,
               CASE WHEN $12 THEN now() END)
       RETURNING ${RECORD_COLUMNS}`,
      [
        start.id,
        start.workspaceId,
        start.connectionId,
        start.userId,
        start.origin,
        start.query.language,
        JSON.stringify(start.query),
        start.limits.maxRows,
        start.limits.timeoutMs,
        initial.status,
        rejected ? JSON.stringify(initial.error) : null,
        rejected,
      ],
    )
    const record = firstRecord(rows)
    if (!record) throw new Error("Execution insert returned no row")
    return record
  }

  /**
   * Records how a running execution ended, keeping a bounded snapshot of its
   * rows. Returns null if it had already ended.
   */
  async finish(start: ExecutionStart, outcome: ExecutionOutcome): Promise<ExecutionRecord | null> {
    const succeeded = outcome.status === "succeeded"
    const result = succeeded ? outcome.result : null
    const snapshot = result
      ? JSON.stringify({ columns: result.columns, rows: snapshotRows(result.rows) })
      : null
    const { rows } = await this.pool.query<ExecutionRow>(
      `UPDATE query_executions
          SET status = $3, row_count = $4, truncated = $5, truncated_by = $6, duration_ms = $7,
              error = $8::json, result = $9::json, finished_at = now()
        WHERE workspace_id = $1 AND id = $2 AND status = 'running'
        RETURNING ${RECORD_COLUMNS}`,
      [
        start.workspaceId,
        start.id,
        outcome.status,
        result?.rowCount ?? null,
        result?.truncated ?? false,
        result?.truncatedBy ?? null,
        succeeded ? outcome.result.durationMs : outcome.durationMs,
        succeeded ? null : JSON.stringify(outcome.error),
        snapshot,
      ],
    )
    return firstRecord(rows)
  }

  async get(workspaceId: string, connectionId: string, id: string): Promise<ExecutionRecord | null> {
    const { rows } = await this.pool.query<ExecutionRow>(
      `SELECT ${RECORD_COLUMNS} FROM query_executions
        WHERE workspace_id = $1 AND connection_id = $2 AND id = $3`,
      [workspaceId, connectionId, id],
    )
    return firstRecord(rows)
  }

  /** Recent executions on a source, newest first, without their rows. */
  async list(workspaceId: string, connectionId: string, limit: number): Promise<ExecutionSummary[]> {
    const { rows } = await this.pool.query<ExecutionRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM query_executions
        WHERE workspace_id = $1 AND connection_id = $2
        ORDER BY created_at DESC, id
        LIMIT $3`,
      [workspaceId, connectionId, limit],
    )
    return rows.map(toSummary)
  }

  /**
   * Startup maintenance across all workspaces: no query survives a restart,
   * so anything still running was interrupted.
   */
  async failInterrupted(): Promise<number> {
    const error: ExecutionError = {
      code: "QUERY_INTERRUPTED",
      message: "Interrupted by a restart of the backend. Run the query again.",
      reason: null,
      name: null,
    }
    const result = await this.pool.query(
      `UPDATE query_executions SET status = 'failed', error = $1::json, finished_at = now()
        WHERE status = 'running'`,
      [JSON.stringify(error)],
    )
    return result.rowCount ?? 0
  }
}
