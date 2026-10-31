import type { EvidenceItem } from "../../entities/agent/types.ts"
import type { ConnectionEngine } from "../../entities/connections/types.ts"
import { queryText } from "../../entities/queries/query-text.ts"
import type { ReadQuery } from "../../entities/queries/types.ts"
import { describeParameterValue, PARAMETER_TYPE_LABELS } from "../../entities/saved-queries/parameters.ts"
import {
  RELATIVE_DATES,
  SAVED_QUERY_LIMITS,
  type CreateSavedQueryInput,
  type ParameterDefinition,
  type ParameterType,
  type ParameterValue,
  type RelativeDate,
  type SavedQuery,
  type SavedQueryOrigin,
  type UpdateSavedQueryInput,
  type Visibility,
} from "../../entities/saved-queries/types.ts"
import { changedKeys, type DraftFields, type DraftState } from "../../shared/lib/draft.ts"

/**
 * What the editor holds, all as text so drafts, conflicts, and "did it change"
 * work like every other versioned editor: the query as people read it (SQL,
 * or MongoDB as JSON) and the parameters as JSON of their drafts.
 */
export type SavedQueryField = "name" | "description" | "query" | "parameters" | "visibility"

export type DefaultChoice = "none" | RelativeDate | "days_ago" | "months_ago" | "absolute"

/** One parameter as its form row edits it. */
export interface ParameterDraft {
  name: string
  label: string
  type: ParameterType
  defaultChoice: DefaultChoice
  /** How many days or months ago, for those choices. */
  count: string
  /** A fixed date, or date and time, for the "absolute" choice. */
  absolute: string
  required: boolean
}

export const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/
const SUGGESTED_NAMES = ["since", "until", "day"]

export const DEFAULT_CHOICES: { value: DefaultChoice; label: string }[] = [
  { value: "none", label: "No default" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "start_of_week", label: "Start of this week (Monday)" },
  { value: "start_of_month", label: "Start of this month" },
  { value: "start_of_quarter", label: "Start of this quarter" },
  { value: "start_of_year", label: "Start of this year" },
  { value: "days_ago", label: "Some days ago" },
  { value: "months_ago", label: "Some months ago" },
  { value: "absolute", label: "A fixed date" },
]

/** A new parameter row, named so it does not clash with the others. */
export function newParameter(existing: ParameterDraft[]): ParameterDraft {
  const taken = new Set(existing.map((draft) => draft.name.toLowerCase()))
  let name = SUGGESTED_NAMES.find((candidate) => !taken.has(candidate))
  for (let index = 2; !name; index += 1) if (!taken.has(`date_${index}`)) name = `date_${index}`
  return { name, label: "", type: "date", defaultChoice: "none", count: "7", absolute: "", required: true }
}

export function parameterDraft(definition: ParameterDefinition): ParameterDraft {
  const draft: ParameterDraft = {
    name: definition.name,
    label: definition.label === definition.name ? "" : definition.label,
    type: definition.type,
    defaultChoice: "none",
    count: "7",
    absolute: "",
    required: definition.required,
  }
  const value = definition.default
  if (!value) return draft
  if (value.kind === "absolute") return { ...draft, defaultChoice: "absolute", absolute: value.value }
  const counted = /^(days_ago|months_ago):(\d+)$/.exec(value.value)
  if (counted) return { ...draft, defaultChoice: counted[1] as DefaultChoice, count: counted[2] ?? "7" }
  return (RELATIVE_DATES as readonly string[]).includes(value.value)
    ? { ...draft, defaultChoice: value.value as RelativeDate }
    : draft
}

function defaultValue(draft: ParameterDraft): { value: ParameterValue | null } | { error: string } {
  switch (draft.defaultChoice) {
    case "none":
      return { value: null }
    case "absolute": {
      const text = draft.absolute.trim()
      const pattern = draft.type === "date" ? DATE : DATETIME
      if (!pattern.test(text)) {
        return {
          error: draft.type === "date" ? "Choose the default date." : "Choose the default date and time.",
        }
      }
      return { value: { kind: "absolute", value: text } }
    }
    case "days_ago":
    case "months_ago": {
      const days = draft.defaultChoice === "days_ago"
      const count = Number(draft.count.trim())
      const max = days ? SAVED_QUERY_LIMITS.maxDaysAgo : SAVED_QUERY_LIMITS.maxMonthsAgo
      if (!draft.count.trim() || !Number.isInteger(count) || count < 0 || count > max) {
        const unit = days ? "days" : "months"
        return { error: `Enter a whole number of ${unit} from 0 to ${max.toLocaleString("en-US")}.` }
      }
      return { value: { kind: "relative", value: `${draft.defaultChoice}:${count}` } }
    }
    default:
      return { value: { kind: "relative", value: draft.defaultChoice } }
  }
}

/** The definitions to save, or a problem per row (by index). */
export function parameterDefinitions(
  drafts: ParameterDraft[],
): { definitions: ParameterDefinition[] } | { errors: Record<number, string> } {
  const errors: Record<number, string> = {}
  const definitions: ParameterDefinition[] = []
  const seen = new Set<string>()
  drafts.forEach((draft, index) => {
    const name = draft.name.trim()
    const value = defaultValue(draft)
    if (!PARAMETER_NAME.test(name)) {
      errors[index] = "Name it with letters, digits, and underscores, starting with a letter or underscore."
    } else if (seen.has(name.toLowerCase())) {
      errors[index] = `Another parameter is already named ${name}.`
    } else if (draft.label.trim().length > SAVED_QUERY_LIMITS.labelChars) {
      errors[index] = `The label can be at most ${SAVED_QUERY_LIMITS.labelChars} characters.`
    } else if ("error" in value) {
      errors[index] = value.error
    } else {
      definitions.push({
        name,
        label: draft.label.trim() || name,
        type: draft.type,
        default: value.value,
        required: draft.required,
      })
    }
    seen.add(name.toLowerCase())
  })
  return Object.keys(errors).length > 0 ? { errors } : { definitions }
}

export function parametersText(drafts: ParameterDraft[]): string {
  return JSON.stringify(drafts)
}

export function parseParameterDrafts(text: string): ParameterDraft[] {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as ParameterDraft[]) : []
  } catch {
    return []
  }
}

/** "since (Date, Start of this month)": a parameter list as one line, e.g. for a conflict. */
export function parametersSummary(text: string): string {
  const parsed = parameterDefinitions(parseParameterDrafts(text))
  if (!("definitions" in parsed)) return text
  const described = parsed.definitions.map((definition) => {
    const type = PARAMETER_TYPE_LABELS[definition.type]
    return `${definition.name} (${type}, ${describeParameterValue(definition.default)})`
  })
  return described.join(", ") || "No parameters"
}

/** The query the editor's text stands for: SQL as written, MongoDB as a JSON object. */
export function queryFromText(
  text: string,
  engine: ConnectionEngine,
): { query: ReadQuery } | { error: string } {
  if (engine === "postgres") {
    return text.trim() ? { query: { language: "sql", sql: text } } : { error: "Enter a SELECT statement." }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : "check the brackets and quotes"
    return { error: `The query is not valid JSON: ${detail}` }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      error: 'The query must be a JSON object with database, collection, operation ("find" or "aggregate"), and a filter or pipeline.',
    }
  }
  return { query: { ...(parsed as object), language: "mongodb" } as ReadQuery }
}

export function savedQueryFields(
  savedQuery: Pick<SavedQuery, "name" | "description" | "query" | "parameters" | "visibility">,
): DraftFields<SavedQueryField> {
  return {
    name: savedQuery.name,
    description: savedQuery.description,
    query: queryText(savedQuery.query),
    parameters: parametersText(savedQuery.parameters.map(parameterDraft)),
    visibility: savedQuery.visibility,
  }
}

export const EMPTY_FIELDS: DraftFields<SavedQueryField> = {
  name: "",
  description: "",
  query: "",
  parameters: "[]",
  visibility: "workspace",
}

/** What "Save as query" starts with. */
export interface SavePrefill {
  connectionId: string
  fields: DraftFields<SavedQueryField>
  origin: SavedQueryOrigin | null
}

/** From an answer's evidence: named after what it supports, with its query and where it came from. */
export function prefillFromEvidence(item: EvidenceItem, runId: string): SavePrefill {
  return {
    connectionId: item.connectionId,
    fields: {
      ...EMPTY_FIELDS,
      name: item.label.trim().slice(0, SAVED_QUERY_LIMITS.nameChars),
      query: queryText(item.query),
    },
    origin: { runId, executionId: item.executionId },
  }
}

/** From the query console: its query (if it has one yet), to be named. */
export function prefillFromQuery(query: ReadQuery | null, connectionId: string): SavePrefill {
  return { connectionId, fields: { ...EMPTY_FIELDS, query: query ? queryText(query) : "" }, origin: null }
}

export type FormErrors = Partial<Record<"name" | "query", string>> & { parameters?: Record<number, string> }

interface Built {
  name: string
  description: string
  query: ReadQuery
  parameters: ParameterDefinition[]
  visibility: Visibility
}

function build(
  fields: DraftFields<SavedQueryField>,
  engine: ConnectionEngine,
): { built: Built } | { errors: FormErrors } {
  const errors: FormErrors = {}
  const name = fields.name.trim()
  if (!name) errors.name = "Give the saved query a name."
  else if (name.length > SAVED_QUERY_LIMITS.nameChars) {
    errors.name = `A name can be at most ${SAVED_QUERY_LIMITS.nameChars} characters.`
  }
  const query = queryFromText(fields.query, engine)
  if ("error" in query) errors.query = query.error
  const parameters = parameterDefinitions(parseParameterDrafts(fields.parameters))
  if ("errors" in parameters) errors.parameters = parameters.errors
  if ("error" in query || "errors" in parameters || errors.name) return { errors }
  return {
    built: {
      name,
      description: fields.description,
      query: query.query,
      parameters: parameters.definitions,
      visibility: fields.visibility === "private" ? "private" : "workspace",
    },
  }
}

export function createInput(
  fields: DraftFields<SavedQueryField>,
  prefill: Pick<SavePrefill, "connectionId" | "origin">,
  engine: ConnectionEngine,
): { input: CreateSavedQueryInput } | { errors: FormErrors } {
  const result = build(fields, engine)
  if ("errors" in result) return result
  return { input: { ...result.built, connectionId: prefill.connectionId, origin: prefill.origin } }
}

/** Only the fields the user changed. */
export function updatePatch(
  state: DraftState<SavedQueryField>,
  engine: ConnectionEngine,
): { patch: UpdateSavedQueryInput } | { errors: FormErrors } {
  const result = build(state.draft, engine)
  if ("errors" in result) return result
  const patch: UpdateSavedQueryInput = { version: state.version }
  for (const key of changedKeys(state.base, state.draft)) {
    if (key === "name") patch.name = result.built.name
    if (key === "description") patch.description = result.built.description
    if (key === "query") patch.query = result.built.query
    if (key === "parameters") patch.parameters = result.built.parameters
    if (key === "visibility") patch.visibility = result.built.visibility
  }
  return { patch }
}
