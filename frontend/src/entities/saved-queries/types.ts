// Mirrors backend/src/saved-queries/schemas.ts; change both together.

import type { ConnectionEngine } from "../connections/types.ts"
import type { Author } from "../manifests/types.ts"
import type { ExecutionRecord, ExecutionSummary, QueryLanguage, ReadQuery } from "../queries/types.ts"

export type ParameterType = "date" | "datetime"

/** Relative dates without a count; days_ago:N and months_ago:N take one. */
export const RELATIVE_DATES = [
  "today",
  "yesterday",
  "start_of_week",
  "start_of_month",
  "start_of_quarter",
  "start_of_year",
] as const

export type RelativeDate = (typeof RELATIVE_DATES)[number]

/** Bounds the backend enforces. */
export const SAVED_QUERY_LIMITS = {
  nameChars: 200,
  descriptionChars: 20_000,
  parameters: 20,
  labelChars: 100,
  maxDaysAgo: 36_600,
  maxMonthsAgo: 1_200,
} as const

/** A fixed date ("2026-10-01") or datetime ("2026-10-01T09:30"), or a date relative to the run. */
export type ParameterValue = { kind: "absolute"; value: string } | { kind: "relative"; value: string }

export interface ParameterDefinition {
  /** Used in the query as {{name}} (SQL) or {"$param": "name"} (MongoDB). */
  name: string
  label: string
  type: ParameterType
  default: ParameterValue | null
  required: boolean
}

export type Visibility = "workspace" | "private"

export interface SavedQuerySource {
  id: string
  name: string
  engine: ConnectionEngine
}

export interface SavedQueryOrigin {
  runId: string
  executionId: string
}

export interface SavedQuery {
  id: string
  name: string
  /** Markdown. */
  description: string
  source: SavedQuerySource
  language: QueryLanguage
  query: ReadQuery
  parameters: ParameterDefinition[]
  visibility: Visibility
  /** The answer and query run it was saved from. */
  origin: SavedQueryOrigin | null
  version: number
  lastExecutionId: string | null
  lastRunAt: string | null
  createdBy: Author | null
  updatedBy: Author | null
  createdAt: string
  updatedAt: string
}

export interface SavedQuerySummary extends Omit<SavedQuery, "query" | "description"> {
  excerpt: string
}

export interface SavedQueryList {
  savedQueries: SavedQuerySummary[]
  nextOffset: number | null
}

/** A parameter as it resolved for a run, or for the defaults right now. */
export interface ResolvedParameter {
  name: string
  label: string
  type: ParameterType
  from: "run" | "default" | null
  input: ParameterValue | null
  /** "2026-10-01", or a datetime with the workspace offset; null without a value. */
  value: string | null
}

export interface SavedQueryWarning {
  code: "database_clock"
  message: string
}

export interface SavedQueryDetail extends SavedQuery {
  /** The workspace time zone relative dates resolve in. */
  timeZone: string
  defaults: ResolvedParameter[]
  warnings: SavedQueryWarning[]
  /** The latest succeeded run with its stored rows. */
  latestRun: ExecutionRecord | null
}

export interface SavedQueryRun {
  execution: ExecutionRecord
  parameters: ResolvedParameter[]
  timeZone: string
}

export interface SavedQueryRunPage {
  runs: ExecutionSummary[]
  nextOffset: number | null
}

export interface CreateSavedQueryInput {
  name: string
  description: string
  connectionId: string
  query: ReadQuery
  parameters: ParameterDefinition[]
  visibility: Visibility
  origin: SavedQueryOrigin | null
}

export interface UpdateSavedQueryInput {
  version: number
  name?: string
  description?: string
  query?: ReadQuery
  parameters?: ParameterDefinition[]
  visibility?: Visibility
}

/** Values for one run by parameter name; parameters left out take their default. */
export type RunValues = Record<string, string | null>
