// Mirrors backend/src/queries/schemas.ts: one read-query contract and one
// result format for every engine.

/** Bounds the backend enforces on every execution. */
export const QUERY_LIMITS = {
  defaultRows: 1_000,
  maxRows: 5_000,
  defaultTimeoutMs: 30_000,
  resultMegabytes: 5,
  snapshotRows: 1_000,
} as const

export type QueryLanguage = "sql" | "mongodb"
export type QueryOrigin = "console" | "agent" | "saved_query" | "dashboard" | "routine"
export type ExecutionStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "rejected"

export interface SqlQuery {
  language: "sql"
  sql: string
  /** Values bound to $1..$n by position (a saved query's parameters), never written into the SQL. */
  params?: (string | number | boolean | null)[]
}

/** Values may use relaxed Extended JSON, such as {"$date": "…"} or {"$oid": "…"}. */
export type MongoQuery = {
  language: "mongodb"
  database: string
  collection: string
} & (
  | {
      operation: "find"
      filter?: Record<string, unknown>
      projection?: Record<string, unknown>
      sort?: Record<string, unknown>
      skip?: number
    }
  | { operation: "aggregate"; pipeline: Record<string, unknown>[] }
)

export type ReadQuery = SqlQuery | MongoQuery

export interface RunQueryInput {
  /** Chosen here, so Cancel can name the run while it is in flight. */
  id: string
  query: ReadQuery
  maxRows?: number
  timeoutMs?: number
}

export type ColumnKind =
  | "integer"
  | "decimal"
  | "float"
  | "text"
  | "boolean"
  | "datetime"
  | "date"
  | "time"
  | "json"
  | "binary"
  | "id"
  | "unknown"

export interface ResultColumn {
  name: string
  /** The engine's own type name, e.g. "numeric" or "objectId"; "int | string" when mixed. */
  type: string
  kind: ColumnKind
}

/** A field that a MongoDB document does not have, as opposed to one holding null. */
export interface MissingCell {
  $missing: true
}

/**
 * int8, numeric, MongoDB Long, and Decimal128 arrive as exact strings;
 * datetimes as ISO 8601; json as JSON text; binaries as \x-prefixed hex.
 */
export type Cell = string | number | boolean | null | MissingCell

export interface QueryResult {
  columns: ResultColumn[]
  /** In column order, so duplicate column names survive. */
  rows: Cell[][]
  /** Rows the query returned; a stored snapshot may hold fewer. */
  rowCount: number
  truncated: boolean
  truncatedBy: "rows" | "bytes" | null
  durationMs: number
}

export interface ExecutionError {
  code: string
  message: string
  reason: string | null
  name: string | null
}

export interface ExecutionSummary {
  id: string
  connectionId: string
  userId: string | null
  origin: QueryOrigin
  /** The saved query this run belongs to, if any. */
  savedQueryId: string | null
  /** A saved query's parameter values as they resolved for this run, by name. */
  parameters: Record<string, string | null> | null
  language: QueryLanguage
  query: ReadQuery
  limits: { maxRows: number; timeoutMs: number }
  status: ExecutionStatus
  rowCount: number | null
  truncated: boolean
  truncatedBy: "rows" | "bytes" | null
  durationMs: number | null
  error: ExecutionError | null
  createdAt: string
  finishedAt: string | null
}

export interface ExecutionRecord extends ExecutionSummary {
  result: QueryResult | null
  /** The stored result keeps only the first rows (1,000 rows or 2 MB). */
  partialResult: boolean
}
