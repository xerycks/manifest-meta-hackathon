import type { ConnectionEngine } from "../../entities/connections/types.ts"
import { QUERY_LIMITS, type MongoQuery, type ReadQuery } from "../../entities/queries/types.ts"

export type MongoOperation = "find" | "aggregate"

/** What the console edits. JSON fields stay text until the query runs, so nothing typed is lost. */
export interface QueryDraft {
  sql: string
  database: string
  collection: string
  operation: MongoOperation
  filter: string
  projection: string
  sort: string
  skip: string
  pipeline: string
  maxRows: string
}

export type QueryDraftErrors = Partial<Record<keyof QueryDraft, string>>

export function emptyQueryDraft(databases: string[]): QueryDraft {
  return {
    sql: "",
    database: databases[0] ?? "",
    collection: "",
    operation: "find",
    filter: "{}",
    projection: "",
    sort: "",
    skip: "",
    pipeline: '[\n  { "$match": {} }\n]',
    maxRows: String(QUERY_LIMITS.defaultRows),
  }
}

type Parsed<T> = { value: T } | { error: string }

function parseJson(text: string, label: string): Parsed<unknown> {
  try {
    return { value: JSON.parse(text) as unknown }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "check the brackets and quotes"
    return { error: `${label} is not valid JSON: ${detail}` }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A JSON object editor; blank means "not set". */
export function parseJsonObject(text: string, label: string): Parsed<Record<string, unknown> | undefined> {
  if (!text.trim()) return { value: undefined }
  const parsed = parseJson(text, label)
  if ("error" in parsed) return parsed
  if (!isObject(parsed.value)) return { error: `${label} must be a JSON object, like {"status": "paid"}.` }
  return { value: parsed.value }
}

/** The aggregation pipeline editor: an array of stage objects. */
export function parsePipeline(text: string): Parsed<Record<string, unknown>[]> {
  const parsed = parseJson(text.trim() || "[]", "The pipeline")
  if ("error" in parsed) return parsed
  const stages = parsed.value
  if (!Array.isArray(stages) || !stages.every(isObject)) {
    return { error: 'The pipeline must be a JSON array of stages, like [{"$match": {}}].' }
  }
  return { value: stages }
}

function parseMaxRows(text: string): Parsed<number> {
  const value = Number(text.trim())
  if (!Number.isInteger(value) || value < 1 || value > QUERY_LIMITS.maxRows) {
    return { error: `Enter a whole number from 1 to ${QUERY_LIMITS.maxRows.toLocaleString("en-US")}.` }
  }
  return { value }
}

/** The request for a draft, or what to fix first. */
export function buildQuery(
  draft: QueryDraft,
  engine: ConnectionEngine,
): { query: ReadQuery; maxRows: number } | { errors: QueryDraftErrors } {
  const errors: QueryDraftErrors = {}
  const maxRows = parseMaxRows(draft.maxRows)
  if ("error" in maxRows) errors.maxRows = maxRows.error

  if (engine === "postgres") {
    if (!draft.sql.trim()) errors.sql = "Enter a SELECT statement."
    if (Object.keys(errors).length > 0 || "error" in maxRows) return { errors }
    return { query: { language: "sql", sql: draft.sql }, maxRows: maxRows.value }
  }

  if (!draft.database) errors.database = "Choose a database."
  if (!draft.collection.trim()) errors.collection = "Enter a collection."
  const base = { language: "mongodb", database: draft.database, collection: draft.collection.trim() } as const
  let query: MongoQuery | null = null
  if (draft.operation === "aggregate") {
    const pipeline = parsePipeline(draft.pipeline)
    if ("error" in pipeline) errors.pipeline = pipeline.error
    else query = { ...base, operation: "aggregate", pipeline: pipeline.value }
  } else {
    const filter = parseJsonObject(draft.filter, "The filter")
    const projection = parseJsonObject(draft.projection, "The projection")
    const sort = parseJsonObject(draft.sort, "The sort")
    const skip = draft.skip.trim() ? Number(draft.skip.trim()) : undefined
    if ("error" in filter) errors.filter = filter.error
    if ("error" in projection) errors.projection = projection.error
    if ("error" in sort) errors.sort = sort.error
    if (skip !== undefined && (!Number.isInteger(skip) || skip < 0)) {
      errors.skip = "Enter a whole number of documents to skip, or leave it blank."
    }
    if (!("error" in filter) && !("error" in projection) && !("error" in sort)) {
      query = {
        ...base,
        operation: "find",
        ...(filter.value ? { filter: filter.value } : {}),
        ...(projection.value ? { projection: projection.value } : {}),
        ...(sort.value ? { sort: sort.value } : {}),
        ...(skip !== undefined ? { skip } : {}),
      }
    }
  }
  if (Object.keys(errors).length > 0 || !query || "error" in maxRows) return { errors }
  return { query, maxRows: maxRows.value }
}

const pretty = (value: unknown) => (value === undefined ? "" : JSON.stringify(value, null, 2))

/** Puts an earlier run's query back in the editor, keeping fields it does not use. */
export function draftFromQuery(query: ReadQuery, maxRows: number, current: QueryDraft): QueryDraft {
  const base = { ...current, maxRows: String(maxRows) }
  if (query.language === "sql") return { ...base, sql: query.sql }
  const target = { ...base, database: query.database, collection: query.collection }
  if (query.operation === "aggregate") {
    return { ...target, operation: "aggregate", pipeline: pretty(query.pipeline) }
  }
  return {
    ...target,
    operation: "find",
    filter: pretty(query.filter) || "{}",
    projection: pretty(query.projection),
    sort: pretty(query.sort),
    skip: query.skip === undefined ? "" : String(query.skip),
  }
}

/** A one-line reminder of a query for a list of runs. */
export function queryPreview(query: ReadQuery, max = 90): string {
  const text =
    query.language === "sql"
      ? query.sql.replace(/\s+/g, " ").trim()
      : query.operation === "aggregate"
        ? `${query.collection}.aggregate(${JSON.stringify(query.pipeline)})`
        : `${query.collection}.find(${JSON.stringify(query.filter ?? {})})`
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
