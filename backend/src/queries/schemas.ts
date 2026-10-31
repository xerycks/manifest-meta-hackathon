import { z } from "zod"

/** Bounds on every execution, whatever started it. */
export const QUERY_LIMITS = {
  defaultRows: 1_000,
  maxRows: 5_000,
  defaultTimeoutMs: 30_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60_000,
  /** Rows returned by one execution, serialized as JSON. */
  resultBytes: 5 * 1024 * 1024,
  /** What an execution record keeps of the result, for evidence and reopening. */
  snapshotRows: 1_000,
  snapshotBytes: 2 * 1024 * 1024,
  sqlChars: 100_000,
  /** SQL as stored (JSON-escaped UTF-8); keeps every record within its column's bound. */
  sqlJsonBytes: 200_000,
  /** A MongoDB query's JSON, filter and pipeline included. */
  mongoQueryBytes: 100_000,
  pipelineStages: 100,
} as const

export type QueryLanguage = "sql" | "mongodb"
/** Who ran the query: the developer console now; analysis features later. */
export type QueryOrigin = "console" | "agent" | "saved_query" | "dashboard" | "routine"
export type ExecutionStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "rejected"

const document = z.record(z.string(), z.unknown())

export const sqlQuerySchema = z.strictObject({
  language: z.literal("sql"),
  sql: z
    .string()
    .max(QUERY_LIMITS.sqlChars, `SQL can be at most ${QUERY_LIMITS.sqlChars} characters`)
    .refine(
      (sql) => Buffer.byteLength(JSON.stringify(sql)) <= QUERY_LIMITS.sqlJsonBytes,
      "The SQL is too large to record (at most 200 KB)",
    ),
})

/**
 * A MongoDB read. Values may use relaxed Extended JSON, such as
 * {"$date": "2026-01-01T00:00:00Z"}, {"$oid": "…"}, or {"$numberLong": "…"}.
 */
export const mongoQuerySchema = z
  .strictObject({
    language: z.literal("mongodb"),
    database: z.string().trim().min(1, "Choose a database").max(64),
    collection: z.string().trim().min(1, "Choose a collection").max(255),
    operation: z.enum(["find", "aggregate"]),
    filter: document.optional(),
    projection: document.optional(),
    sort: document.optional(),
    skip: z.number().int().min(0).max(1_000_000_000).optional(),
    pipeline: z.array(document).max(QUERY_LIMITS.pipelineStages).optional(),
  })
  .superRefine((query, ctx) => {
    const misplaced =
      query.operation === "find"
        ? query.pipeline !== undefined
          ? ["pipeline"]
          : []
        : (["filter", "projection", "sort", "skip"] as const).filter((key) => query[key] !== undefined)
    for (const key of misplaced) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message:
          key === "pipeline"
            ? "A pipeline is only used with aggregate"
            : `${key} is only used with find; use pipeline stages with aggregate`,
      })
    }
    if (Buffer.byteLength(JSON.stringify(query)) > QUERY_LIMITS.mongoQueryBytes) {
      ctx.addIssue({ code: "custom", message: "The query is too large (at most 100 KB of JSON)" })
    }
  })

export const readQuerySchema = z.discriminatedUnion("language", [sqlQuerySchema, mongoQuerySchema])

export type SqlQuery = z.infer<typeof sqlQuerySchema>
export type MongoQuery = z.infer<typeof mongoQuerySchema>
/** The one read-query contract for both engines. */
export type ReadQuery = z.infer<typeof readQuerySchema>

export interface QueryLimits {
  /** Rows returned at most; one more is read to know whether the result was cut. */
  maxRows: number
  timeoutMs: number
}

export function resolveLimits(limits: Partial<QueryLimits> = {}): QueryLimits {
  return {
    maxRows: limits.maxRows ?? QUERY_LIMITS.defaultRows,
    timeoutMs: limits.timeoutMs ?? QUERY_LIMITS.defaultTimeoutMs,
  }
}

export const runQuerySchema = z.strictObject({
  id: z.uuid(),
  query: readQuerySchema,
  maxRows: z.number().int().min(1).max(QUERY_LIMITS.maxRows).optional(),
  timeoutMs: z.number().int().min(QUERY_LIMITS.minTimeoutMs).max(QUERY_LIMITS.maxTimeoutMs).optional(),
})

export type RunQueryInput = z.infer<typeof runQuerySchema>

export const queryParamsSchema = z.object({ workspaceId: z.uuid(), connectionId: z.uuid() })
export const executionParamsSchema = queryParamsSchema.extend({ executionId: z.uuid() })

export const historyQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type HistoryQuery = z.infer<typeof historyQuerySchema>

// Results ---------------------------------------------------------------------
//
// Both engines return the same shape. Rows are arrays in column order, so
// duplicate names (SELECT a.id, b.id) survive. Cell values:
//   integer   number for int2/int4/Int32; string for int8 and MongoDB Long
//   decimal   string (numeric, Decimal128), never rounded through a float
//   float     number; NaN and ±Infinity as the strings "NaN", "Infinity", "-Infinity"
//   boolean   true or false
//   datetime  ISO 8601 string, e.g. "2026-10-31T09:30:00.123456Z" ("…" with an
//             offset, or none for timestamp without time zone)
//   date/time the engine's ISO text, e.g. "2026-10-31", "09:30:00"
//   json      JSON text: PostgreSQL json/jsonb, or a MongoDB document or array
//             as Extended JSON that keeps exact numbers ({"$numberLong": "…"})
//   binary    hex with a \x prefix, e.g. \x0a1b
//   id        string: a uuid, or an ObjectId's 24 hex digits
//   text      string, also for anything else (arrays, enums, intervals, …)
// null is SQL NULL or a MongoDB null; {"$missing": true} marks a field a
// MongoDB document does not have. Columns of MongoDB results are the
// documents' top-level fields in order of first appearance (_id first).

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
  /** The engine's own type name, e.g. "numeric(12,2)" or "objectId"; "int | string" when mixed. */
  type: string
  kind: ColumnKind
}

/** A field that a MongoDB document does not have, as opposed to one holding null. */
export interface MissingCell {
  $missing: true
}

export type Cell = string | number | boolean | null | MissingCell

export const MISSING: MissingCell = { $missing: true }

export type TruncatedBy = "rows" | "bytes"

export interface QueryResult {
  columns: ResultColumn[]
  rows: Cell[][]
  /** Rows the query returned (at most maxRows); a stored snapshot may hold fewer. */
  rowCount: number
  /** More rows existed, or the next one would have passed the byte limit. */
  truncated: boolean
  truncatedBy: TruncatedBy | null
  durationMs: number
}

// Execution records --------------------------------------------------------------

export type RejectionReason =
  | "syntax_error"
  | "multiple_statements"
  | "statement_not_allowed"
  | "relation_not_allowed"
  | "schema_not_allowed"
  | "function_not_allowed"
  | "language_not_supported"
  | "database_not_allowed"
  | "collection_not_allowed"
  | "invalid_query"
  | "stage_not_allowed"
  | "operator_not_allowed"
  | "cross_database"

/** Why validation refused a query, and the name it refused (a table, function, stage, …). */
export interface Rejection {
  reason: RejectionReason
  message: string
  name: string | null
}

/** A safe, user-facing error written by Manifest; never a raw driver error. */
export interface ExecutionError {
  /** QUERY_REJECTED, QUERY_FAILED, QUERY_TIMEOUT, QUERY_CANCELLED, QUERY_INTERRUPTED, SOURCE_CONNECTION_FAILED, … */
  code: string
  message: string
  /** A rejection reason or a source failure reason. */
  reason: string | null
  /** The offending name of a rejection. */
  name: string | null
}

export interface ExecutionSummary {
  id: string
  connectionId: string
  userId: string | null
  origin: QueryOrigin
  language: QueryLanguage
  query: ReadQuery
  limits: QueryLimits
  status: ExecutionStatus
  rowCount: number | null
  truncated: boolean
  truncatedBy: TruncatedBy | null
  durationMs: number | null
  error: ExecutionError | null
  createdAt: string
  finishedAt: string | null
}

export interface ExecutionRecord extends ExecutionSummary {
  /** Succeeded runs only. The run's response carries every row; a stored record its snapshot. */
  result: QueryResult | null
  /** The result holds fewer rows than the query returned (stored snapshots keep 1,000 rows or 2 MB). */
  partialResult: boolean
}
