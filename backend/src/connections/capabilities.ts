import type { Engine } from "./schemas.js"

/** Read operations analysis tools may run against a source. Nothing writes. */
export type AnalysisOperation = "sql_select" | "find" | "aggregate"

/**
 * What analysis can ask of a source, so later tools route a question to the
 * right query language and stay within what controlled execution allows.
 */
export interface SourceCapabilities {
  queryLanguage: "sql" | "mongodb"
  operations: AnalysisOperation[]
  readOnly: true
  /** SQL joins; MongoDB $lookup between collections of the same source. */
  joins: boolean
  aggregates: boolean
  /** MongoDB only: aggregation stages analysis may use; any other stage is refused. */
  allowedStages: string[] | null
  /** Named so tools can explain a refusal; refused whether listed here or not. */
  forbiddenStages: string[] | null
  /** Operators refused anywhere in a filter, projection, or pipeline. */
  forbiddenOperators: string[]
  summary: string
}

/** Stages that only read and reshape documents of the source. */
export const MONGO_ALLOWED_STAGES = [
  "$match",
  "$project",
  "$addFields",
  "$set",
  "$unset",
  "$group",
  "$sort",
  "$limit",
  "$skip",
  "$count",
  "$unwind",
  "$lookup",
  "$graphLookup",
  "$unionWith",
  "$facet",
  "$bucket",
  "$bucketAuto",
  "$sortByCount",
  "$replaceRoot",
  "$replaceWith",
  "$sample",
  "$setWindowFields",
  "$densify",
  "$fill",
  "$redact",
  "$geoNear",
] as const

/** Stages that write, or read server state rather than the selected data. */
export const MONGO_FORBIDDEN_STAGES = [
  "$out",
  "$merge",
  "$currentOp",
  "$listSessions",
  "$listLocalSessions",
  "$planCacheStats",
  "$collStats",
  "$indexStats",
  "$changeStream",
  "$documents",
] as const

/** Server-side JavaScript. */
export const MONGO_FORBIDDEN_OPERATORS = ["$where", "$function", "$accumulator"] as const

const CAPABILITIES: Record<Engine, SourceCapabilities> = {
  postgres: {
    queryLanguage: "sql",
    operations: ["sql_select"],
    readOnly: true,
    joins: true,
    aggregates: true,
    allowedStages: null,
    forbiddenStages: null,
    forbiddenOperators: [],
    summary:
      "Read-only PostgreSQL SQL: one SELECT statement (WITH allowed) with joins, aggregates, and window functions over the selected schemas.",
  },
  mongodb: {
    queryLanguage: "mongodb",
    operations: ["find", "aggregate"],
    readOnly: true,
    joins: true,
    aggregates: true,
    allowedStages: [...MONGO_ALLOWED_STAGES],
    forbiddenStages: [...MONGO_FORBIDDEN_STAGES],
    forbiddenOperators: [...MONGO_FORBIDDEN_OPERATORS],
    summary:
      "Read-only MongoDB find and aggregate over the selected databases, with an allowlist of pipeline stages (no $out, $merge, $where, $function, or $accumulator). No SQL.",
  },
}

export function capabilitiesFor(engine: Engine): SourceCapabilities {
  return CAPABILITIES[engine]
}
