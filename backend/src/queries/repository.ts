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

/**
 * Executions kept per workspace; older finished ones are pruned as new ones
 * start. Pinned executions (cited by an answer) are kept on top of these.
 */
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
  /** The saved query being run, with its parameter values as they resolved. */
  savedQueryId?: string
  parameters?: Record<string, string | null>
}

export type ExecutionOutcome =
  | { status: "succeeded"; result: QueryResult }
  | { status: "failed" | "cancelled" | "timed_out"; error: ExecutionError; durationMs: number }

interface ExecutionRow {
  id: string
  connection_id: string
  user_id: string | null
  origin: QueryOrigin
  saved_query_id: string | null
  parameters: Record<string, string | null> | null
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

const SUMMARY_COLUMNS = `id, connection_id, user_id, origin, saved_query_id, parameters, query,
  max_rows, timeout_ms, status, row_count, truncated, truncated_by, duration_ms, error, created_at,
  finished_at`
const RECORD_COLUMNS = `${SUMMARY_COLUMNS}, result`

function toSummary(row: ExecutionRow): ExecutionSummary {
  return {
    id: row.id,
    connectionId: row.connection_id,
    userId: row.user_id,
    origin: row.origin,
    savedQueryId: row.saved_query_id,
    parameters: row.parameters,
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

/** A succeeded run's stored columns and leading rows, without its query (e.g. for dashboard panels). */
export interface ExecutionPreview {
  id: string
  connectionId: string
  parameters: Record<string, string | null> | null
  createdAt: string
  finishedAt: string | null
  /** Its stored result, holding only the leading rows asked for. */
  result: QueryResult
}

interface PreviewRow {
  id: string
  connection_id: string
  parameters: Record<string, string | null> | null
  row_count: number | null
  truncated: boolean
  truncated_by: TruncatedBy | null
  duration_ms: number | null
  created_at: Date
  finished_at: Date | null
  columns: ResultColumn[]
  leading: Cell[][]
  stored_rows: number
}

/** A saved query's latest run, and when its latest result ran. */
export interface LatestRun {
  lastSuccessAt: string | null
  latest: {
    status: ExecutionStatus
    error: ExecutionError | null
    createdAt: string
    finishedAt: string | null
  } | null
}

interface LatestRunRow {
  saved_query_id: string
  last_success_at: Date | null
  status: ExecutionStatus | null
  error: ExecutionError | null
  created_at: Date | null
  finished_at: Date | null
}

/** Execution records; every query is scoped by workspace_id. */
export class QueryExecutionsRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Records an execution that starts running, or one validation rejected.
   * Rejects with a unique violation (23505) when the id is already used in
   * the workspace. Old finished executions that are not pinned are pruned first.
   */
  async insert(
    start: ExecutionStart,
    initial: { status: "running" } | { status: "rejected"; error: ExecutionError },
  ): Promise<ExecutionRecord> {
    await this.pool.query(
      `DELETE FROM query_executions
        WHERE workspace_id = $1 AND status <> 'running' AND NOT pinned
          AND id NOT IN (
            SELECT id FROM query_executions WHERE workspace_id = $1 AND NOT pinned
             ORDER BY created_at DESC LIMIT ${KEPT_EXECUTIONS - 1})`,
      [start.workspaceId],
    )
    const rejected = initial.status === "rejected"
    const { rows } = await this.pool.query<ExecutionRow>(
      `INSERT INTO query_executions
         (id, workspace_id, connection_id, user_id, origin, language, query, max_rows, timeout_ms,
          status, error, finished_at, saved_query_id, parameters)
       VALUES ($1, $2, $3, $4, $5, $6, $7::json, $8, $9, $10, $11::json,
               CASE WHEN $12 THEN now() END, $13, $14::jsonb)
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
        start.savedQueryId ?? null,
        start.parameters ? JSON.stringify(start.parameters) : null,
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

  /** The executions among `ids` that succeeded, with their stored results. */
  async succeeded(workspaceId: string, ids: string[]): Promise<ExecutionRecord[]> {
    const { rows } = await this.pool.query<ExecutionRow>(
      `SELECT ${RECORD_COLUMNS} FROM query_executions
        WHERE workspace_id = $1 AND id = ANY ($2::uuid[]) AND status = 'succeeded'`,
      [workspaceId, ids],
    )
    return rows.map(toRecord)
  }

  /**
   * The succeeded executions among `ids` with their stored columns and at most
   * `maxRows` leading rows, cut in the database so large snapshots stay there.
   */
  async previews(workspaceId: string, ids: string[], maxRows: number): Promise<ExecutionPreview[]> {
    if (ids.length === 0) return []
    const { rows } = await this.pool.query<PreviewRow>(
      `SELECT id, connection_id, parameters, row_count, truncated, truncated_by, duration_ms, created_at,
              finished_at, result -> 'columns' AS columns,
              json_array_length(result -> 'rows') AS stored_rows,
              (SELECT coalesce(json_agg(r.value ORDER BY r.n), '[]'::json)
                 FROM json_array_elements(result -> 'rows') WITH ORDINALITY AS r (value, n)
                WHERE r.n <= $3) AS leading
         FROM query_executions
        WHERE workspace_id = $1 AND id = ANY ($2::uuid[]) AND status = 'succeeded' AND result IS NOT NULL`,
      [workspaceId, ids, maxRows],
    )
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      parameters: row.parameters,
      createdAt: row.created_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      result: {
        columns: row.columns,
        rows: row.leading,
        rowCount: row.row_count ?? row.stored_rows,
        truncated: row.truncated,
        truncatedBy: row.truncated_by,
        durationMs: row.duration_ms ?? 0,
      },
    }))
  }

  /**
   * For each of the saved queries, its latest run (any status) and when its
   * latest result (the run it keeps pinned) ran: what a dashboard refresh reports.
   */
  async latestForSavedQueries(workspaceId: string, savedQueryIds: string[]): Promise<Map<string, LatestRun>> {
    if (savedQueryIds.length === 0) return new Map()
    const { rows } = await this.pool.query<LatestRunRow>(
      `SELECT s.id AS saved_query_id, ok.created_at AS last_success_at,
              l.status, l.error, l.created_at, l.finished_at
         FROM saved_queries s
         LEFT JOIN query_executions ok ON ok.workspace_id = s.workspace_id AND ok.id = s.last_execution_id
         LEFT JOIN LATERAL (
           SELECT e.status, e.error, e.created_at, e.finished_at FROM query_executions e
            WHERE e.workspace_id = s.workspace_id AND e.saved_query_id = s.id
            ORDER BY e.created_at DESC, e.id DESC
            LIMIT 1) l ON true
        WHERE s.workspace_id = $1 AND s.id = ANY ($2::uuid[])`,
      [workspaceId, savedQueryIds],
    )
    return new Map(
      rows.map((row) => [
        row.saved_query_id,
        {
          lastSuccessAt: row.last_success_at?.toISOString() ?? null,
          latest: row.status
            ? {
                status: row.status,
                error: row.error,
                createdAt: (row.created_at as Date).toISOString(),
                finishedAt: row.finished_at?.toISOString() ?? null,
              }
            : null,
        },
      ]),
    )
  }

  /**
   * Keeps succeeded executions out of history pruning, e.g. because an answer
   * cites them. Returns the ids that are now pinned.
   */
  async pin(workspaceId: string, ids: string[]): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE query_executions SET pinned = true
        WHERE workspace_id = $1 AND id = ANY ($2::uuid[]) AND status = 'succeeded'
        RETURNING id`,
      [workspaceId, ids],
    )
    return rows.map((row) => row.id)
  }

  /**
   * A saved query's runs, newest first, without their rows; one more than
   * `limit` is read so the caller knows whether another page exists.
   */
  async listForSavedQuery(
    workspaceId: string,
    savedQueryId: string,
    page: { limit: number; offset: number },
  ): Promise<ExecutionSummary[]> {
    const { rows } = await this.pool.query<ExecutionRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM query_executions
        WHERE workspace_id = $1 AND saved_query_id = $2
        ORDER BY created_at DESC, id
        LIMIT $3 OFFSET $4`,
      [workspaceId, savedQueryId, page.limit + 1, page.offset],
    )
    return rows.map(toSummary)
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
