import { z } from "zod"

import type { Author } from "../auth/repository.js"
import type { Engine } from "../connections/schemas.js"
import {
  readQuerySchema,
  type ExecutionRecord,
  type ExecutionSummary,
  type QueryLanguage,
  type ReadQuery,
} from "../queries/schemas.js"

export const SAVED_QUERY_LIMITS = {
  nameChars: 200,
  descriptionChars: 20_000,
  parameters: 20,
  labelChars: 100,
  perWorkspace: 1_000,
  /** Saved queries one page of the list returns, by default and at most. */
  page: 50,
  pageMax: 100,
  /** Runs one page of a saved query's history returns, by default and at most. */
  runsPage: 20,
  runsPageMax: 100,
  maxDaysAgo: 36_600,
  maxMonthsAgo: 1_200,
} as const

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

const RELATIVE_PATTERN = new RegExp(`^(?:${RELATIVE_DATES.join("|")}|(days_ago|months_ago):(\\d{1,5}))$`)

/** A relative date, or null when the text is not one (or its count is out of range). */
export function parseRelativeDate(
  text: string,
): { kind: (typeof RELATIVE_DATES)[number] } | { kind: "days_ago" | "months_ago"; count: number } | null {
  const match = RELATIVE_PATTERN.exec(text)
  if (!match) return null
  const [, unit, digits] = match
  if (!unit) return { kind: text as (typeof RELATIVE_DATES)[number] }
  const count = Number(digits)
  const max = unit === "days_ago" ? SAVED_QUERY_LIMITS.maxDaysAgo : SAVED_QUERY_LIMITS.maxMonthsAgo
  return count <= max ? { kind: unit as "days_ago" | "months_ago", count } : null
}

/** Names usable as {{name}} or {"$param": "name"}: letters, digits, and underscores, not starting with a digit. */
export const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

const parameterNameSchema = z
  .string()
  .regex(
    PARAMETER_NAME,
    "Parameter names use letters, digits, and underscores, and do not start with a digit",
  )

/** A parameter's value: a fixed date or datetime, or a date relative to when the query runs. */
export const parameterValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("absolute"), value: z.string().trim().min(1, "Enter a date").max(40) }),
  z.strictObject({
    kind: z.literal("relative"),
    value: z.string().refine((value) => parseRelativeDate(value) !== null, {
      message: `Use one of ${RELATIVE_DATES.join(", ")}, days_ago:N (up to ${SAVED_QUERY_LIMITS.maxDaysAgo}), or months_ago:N (up to ${SAVED_QUERY_LIMITS.maxMonthsAgo})`,
    }),
  }),
])

export type ParameterValue = z.infer<typeof parameterValueSchema>

export const parameterDefinitionSchema = z
  .strictObject({
    name: parameterNameSchema,
    label: z.string().trim().max(SAVED_QUERY_LIMITS.labelChars).default(""),
    type: z.enum(["date", "datetime"]),
    default: parameterValueSchema.nullable().default(null),
    required: z.boolean().default(true),
  })
  .transform((definition) => ({ ...definition, label: definition.label || definition.name }))

export type ParameterDefinition = z.infer<typeof parameterDefinitionSchema>

const parametersSchema = z
  .array(parameterDefinitionSchema)
  .max(
    SAVED_QUERY_LIMITS.parameters,
    `A saved query can have at most ${SAVED_QUERY_LIMITS.parameters} parameters`,
  )
  .superRefine((definitions, context) => {
    const seen = new Set<string>()
    definitions.forEach((definition, index) => {
      const key = definition.name.toLowerCase()
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `Two parameters are named ${definition.name}; give each its own name`,
        })
      }
      seen.add(key)
    })
  })

// Stored as text, which cannot hold NUL characters.
const noNul = (text: string) => !text.includes("\u0000")

const nameSchema = z
  .string()
  .trim()
  .min(1, "Give the saved query a name")
  .max(SAVED_QUERY_LIMITS.nameChars, `A name can be at most ${SAVED_QUERY_LIMITS.nameChars} characters`)
  .refine(noNul, "A name cannot contain NUL characters")
const descriptionSchema = z
  .string()
  .max(
    SAVED_QUERY_LIMITS.descriptionChars,
    `The description can be at most ${SAVED_QUERY_LIMITS.descriptionChars.toLocaleString("en-US")} characters`,
  )
  .refine(noNul, "The description cannot contain NUL characters")
  .transform((value) => value.trimEnd())
const visibilitySchema = z.enum(["workspace", "private"])

export type Visibility = z.infer<typeof visibilitySchema>

/** A saved query names its SQL parameters as {{name}}; positional values are bound only when it runs. */
const savedReadQuerySchema = readQuerySchema.refine(
  (query) => query.language !== "sql" || query.params === undefined,
  { path: ["params"], message: "Write parameters as {{name}} in the SQL; their values are bound when it runs" },
)

/** The answer and the execution a saved query was made from. */
export const originSchema = z.strictObject({ runId: z.uuid(), executionId: z.uuid() })

export type SavedQueryOrigin = z.infer<typeof originSchema>

export const createSavedQuerySchema = z.strictObject({
  name: nameSchema,
  description: descriptionSchema.default(""),
  connectionId: z.uuid("Choose a source"),
  query: savedReadQuerySchema,
  parameters: parametersSchema.default([]),
  visibility: visibilitySchema.default("workspace"),
  origin: originSchema.nullable().default(null),
})

export type CreateSavedQueryInput = z.infer<typeof createSavedQuerySchema>

export const updateSavedQuerySchema = z
  .strictObject({
    version: z.number().int().min(1).max(2_147_483_647),
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    query: savedReadQuerySchema.optional(),
    parameters: parametersSchema.optional(),
    visibility: visibilitySchema.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.description !== undefined ||
      input.query !== undefined ||
      input.parameters !== undefined ||
      input.visibility !== undefined,
    "Change at least one field",
  )

export type UpdateSavedQueryInput = z.infer<typeof updateSavedQuerySchema>

/** Values by parameter name: a date or datetime, a relative date, or null for none. */
export const runValuesSchema = z
  .record(z.string().max(63), z.union([z.string().trim().max(40), parameterValueSchema, z.null()]))
  .refine((values) => Object.keys(values).length <= 50, "Send at most 50 parameter values")

/** Values for one run; parameters left out take their default. */
export const runSavedQuerySchema = z.strictObject({ parameters: runValuesSchema.default({}) })

export type RunSavedQueryInput = z.infer<typeof runSavedQuerySchema>

export const workspaceParamsSchema = z.object({ workspaceId: z.uuid() })
export const savedQueryParamsSchema = workspaceParamsSchema.extend({ savedQueryId: z.uuid() })

export const listSavedQueriesSchema = z.strictObject({
  search: z
    .string()
    .trim()
    .max(100, "Search for at most 100 characters")
    .optional()
    .transform((value) => value || undefined),
  connectionId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(SAVED_QUERY_LIMITS.pageMax).default(SAVED_QUERY_LIMITS.page),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})

export type ListSavedQueriesQuery = z.infer<typeof listSavedQueriesSchema>

export const listRunsSchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SAVED_QUERY_LIMITS.runsPageMax)
    .default(SAVED_QUERY_LIMITS.runsPage),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})

export type ListRunsQuery = z.infer<typeof listRunsSchema>

// Responses --------------------------------------------------------------------

export interface SavedQuerySource {
  id: string
  name: string
  engine: Engine
}

export interface SavedQuery {
  id: string
  name: string
  /** Markdown. */
  description: string
  source: SavedQuerySource
  language: QueryLanguage
  /** With {{name}} (SQL) or {"$param": "name"} (MongoDB) placeholders. */
  query: ReadQuery
  parameters: ParameterDefinition[]
  visibility: Visibility
  origin: SavedQueryOrigin | null
  /** Increases with every edit; a save names the version it started from. */
  version: number
  lastExecutionId: string | null
  lastRunAt: string | null
  createdBy: Author | null
  updatedBy: Author | null
  createdAt: string
  updatedAt: string
}

export interface SavedQuerySummary extends Omit<SavedQuery, "query" | "description"> {
  /** The start of the description as plain text. */
  excerpt: string
}

export interface SavedQueryList {
  savedQueries: SavedQuerySummary[]
  /** The offset of the next page, or null on the last one. */
  nextOffset: number | null
}

/** A parameter as it resolved for a run, or for the defaults right now. */
export interface ResolvedParameter {
  name: string
  label: string
  type: ParameterType
  /** Where the value came from: the run's values, the default, or nowhere. */
  from: "run" | "default" | null
  /** What was asked for, before resolving. */
  input: ParameterValue | null
  /** A date ("2026-10-01"), a datetime with the workspace's offset, or null without a value. */
  value: string | null
}

/** Advice that does not stop a query from being saved or run. */
export interface SavedQueryWarning {
  code: "database_clock"
  message: string
}

export interface SavedQueryDetail extends SavedQuery {
  /** The workspace time zone relative dates resolve in. */
  timeZone: string
  /** The defaults as they resolve right now. */
  defaults: ResolvedParameter[]
  warnings: SavedQueryWarning[]
  /** The latest succeeded run with its stored result snapshot, if it is still kept. */
  latestRun: ExecutionRecord | null
}

export interface SavedQueryRun {
  /** The run with every row it returned (rejected runs answer 422 instead). */
  execution: ExecutionRecord
  parameters: ResolvedParameter[]
  timeZone: string
}

export interface SavedQueryRunPage {
  runs: ExecutionSummary[]
  nextOffset: number | null
}
