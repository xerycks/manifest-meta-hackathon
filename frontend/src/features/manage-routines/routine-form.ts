import {
  ROUTINE_LIMITS,
  type CreateRoutineInput,
  type RoutineDetail,
  type RoutineKind,
  type RoutineValue,
  type RoutineValues,
  type UpdateRoutineInput,
} from "../../entities/routines/types.ts"
import {
  RELATIVE_DATES,
  SAVED_QUERY_LIMITS,
  type ParameterDefinition,
  type RelativeDate,
} from "../../entities/saved-queries/types.ts"
import {
  cronToPreset,
  DEFAULT_PRESET,
  presetProblem,
  presetToCron,
  type SchedulePreset,
} from "./schedule.ts"

/** How a routine sets one parameter for its runs. */
export type OverrideChoice = "default" | "none" | RelativeDate | "days_ago" | "months_ago" | "absolute"

export interface OverrideDraft {
  choice: OverrideChoice
  /** How many days or months ago, for those choices. */
  count: string
  /** A fixed date, or date and time, for "absolute". */
  absolute: string
}

export const OVERRIDE_CHOICES: { value: Exclude<OverrideChoice, "default" | "none">; label: string }[] = [
  { value: "today", label: "Today (the day it runs)" },
  { value: "yesterday", label: "Yesterday" },
  { value: "start_of_week", label: "Start of the week (Monday)" },
  { value: "start_of_month", label: "Start of the month" },
  { value: "start_of_quarter", label: "Start of the quarter" },
  { value: "start_of_year", label: "Start of the year" },
  { value: "days_ago", label: "Some days before" },
  { value: "months_ago", label: "Some months before" },
  { value: "absolute", label: "A fixed date" },
]

/** Everything the routine form edits. */
export interface RoutineDraft {
  name: string
  description: string
  kind: RoutineKind
  savedQueryId: string
  /** By parameter name; parameters left out take the saved query's default. */
  overrides: Record<string, OverrideDraft>
  question: string
  connectionIds: string[]
  schedule: SchedulePreset
  timeZone: string
  enabled: boolean
}

export type RoutineErrors = Partial<
  Record<"name" | "savedQueryId" | "question" | "schedule" | "timeZone", string>
> & { parameters?: Record<string, string> }

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/
const COUNTED = /^(days_ago|months_ago):(\d+)$/
const DEFAULT_OVERRIDE: OverrideDraft = { choice: "default", count: "7", absolute: "" }

export function newRoutineDraft(options: { savedQueryId?: string; timeZone: string }): RoutineDraft {
  return {
    name: "",
    description: "",
    kind: "saved_query",
    savedQueryId: options.savedQueryId ?? "",
    overrides: {},
    question: "",
    connectionIds: [],
    schedule: DEFAULT_PRESET,
    timeZone: options.timeZone,
    enabled: true,
  }
}

function isRelative(text: string): boolean {
  return (RELATIVE_DATES as readonly string[]).includes(text) || COUNTED.test(text)
}

/** The form row for a stored value: a relative date, a fixed date, none, or the saved query's default. */
export function overrideDraft(value: RoutineValue | undefined): OverrideDraft {
  if (value === undefined) return DEFAULT_OVERRIDE
  if (value === null) return { ...DEFAULT_OVERRIDE, choice: "none" }
  const kind = typeof value === "string" ? (isRelative(value.trim()) ? "relative" : "absolute") : value.kind
  const text = (typeof value === "string" ? value : value.value).trim()
  if (kind === "absolute") return { ...DEFAULT_OVERRIDE, choice: "absolute", absolute: text }
  const counted = COUNTED.exec(text)
  if (counted) return { ...DEFAULT_OVERRIDE, choice: counted[1] as OverrideChoice, count: counted[2] ?? "7" }
  return (RELATIVE_DATES as readonly string[]).includes(text)
    ? { ...DEFAULT_OVERRIDE, choice: text as RelativeDate }
    : DEFAULT_OVERRIDE
}

export function draftFromRoutine(routine: RoutineDetail): RoutineDraft {
  return {
    name: routine.name,
    description: routine.description,
    kind: routine.kind,
    savedQueryId: routine.savedQuery && routine.savedQuery.state !== "removed" ? routine.savedQuery.id : "",
    overrides: Object.fromEntries(
      Object.entries(routine.parameters).map(([name, value]) => [name, overrideDraft(value)]),
    ),
    question: routine.question ?? "",
    connectionIds: routine.connectionIds,
    schedule: cronToPreset(routine.cron),
    timeZone: routine.timeZone,
    enabled: routine.enabled,
  }
}

/**
 * The value a row sends (undefined: the saved query's default), or what to
 * fix. Without its definition (a saved query the editor cannot open) the
 * row is sent as it was stored.
 */
function overrideValue(
  draft: OverrideDraft,
  definition: ParameterDefinition | null,
): { value: RoutineValue | undefined } | { error: string } {
  switch (draft.choice) {
    case "default":
      return !definition || definition.default || !definition.required
        ? { value: undefined }
        : { error: "This parameter has no default, so choose a value for the routine's runs." }
    case "none":
      return definition?.required ? { error: "This parameter needs a value." } : { value: null }
    case "absolute": {
      const text = draft.absolute.trim()
      const date = definition?.type === "date"
      if (!(date ? DATE : DATETIME).test(text)) {
        return { error: date ? "Choose a date." : "Choose a date and time." }
      }
      return { value: { kind: "absolute", value: text } }
    }
    case "days_ago":
    case "months_ago": {
      const days = draft.choice === "days_ago"
      const count = Number(draft.count.trim())
      const max = days ? SAVED_QUERY_LIMITS.maxDaysAgo : SAVED_QUERY_LIMITS.maxMonthsAgo
      if (!draft.count.trim() || !Number.isInteger(count) || count < 0 || count > max) {
        const unit = days ? "days" : "months"
        return { error: `Enter a whole number of ${unit} from 0 to ${max.toLocaleString("en-US")}.` }
      }
      return { value: { kind: "relative", value: `${draft.choice}:${count}` } }
    }
    default:
      return { value: { kind: "relative", value: draft.choice } }
  }
}

/** Whether Intl knows the time zone, as the server checks it. */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name })
    return true
  } catch {
    return false
  }
}

/**
 * The routine to save, or a problem per field. `definitions` are the chosen
 * saved query's parameters, or null when the editor cannot open it (the
 * server checks them regardless).
 */
export function routineInput(
  draft: RoutineDraft,
  definitions: ParameterDefinition[] | null,
): { input: CreateRoutineInput } | { errors: RoutineErrors } {
  const errors: RoutineErrors = {}
  const name = draft.name.trim()
  if (!name) errors.name = "Give the routine a name."
  else if (name.length > ROUTINE_LIMITS.nameChars) {
    errors.name = `A name can be at most ${ROUTINE_LIMITS.nameChars} characters.`
  }
  const scheduleProblem = presetProblem(draft.schedule)
  if (scheduleProblem) errors.schedule = scheduleProblem
  const timeZone = draft.timeZone.trim()
  if (!isTimeZone(timeZone)) errors.timeZone = "Choose a time zone from the list, such as Europe/Berlin."
  const settings = {
    name,
    description: draft.description,
    cron: presetToCron(draft.schedule),
    timeZone,
    enabled: draft.enabled,
  }

  if (draft.kind === "question") {
    const question = draft.question.trim()
    if (!question) errors.question = "Write the question to ask."
    else if (question.length > ROUTINE_LIMITS.questionChars) {
      const max = ROUTINE_LIMITS.questionChars.toLocaleString("en-US")
      errors.question = `A question can be at most ${max} characters.`
    }
    if (Object.keys(errors).length > 0) return { errors }
    return { input: { ...settings, kind: "question", question, connectionIds: draft.connectionIds } }
  }

  if (!draft.savedQueryId) errors.savedQueryId = "Choose a saved query."
  const parameters: RoutineValues = {}
  const parameterErrors: Record<string, string> = {}
  const rows = definitions
    ? definitions.map((definition) => ({ name: definition.name, definition }))
    : Object.keys(draft.overrides).map((name) => ({ name, definition: null }))
  for (const { name, definition } of rows) {
    const result = overrideValue(draft.overrides[name] ?? DEFAULT_OVERRIDE, definition)
    if ("error" in result) parameterErrors[name] = result.error
    else if (result.value !== undefined) parameters[name] = result.value
  }
  if (Object.keys(parameterErrors).length > 0) errors.parameters = parameterErrors
  if (Object.keys(errors).length > 0) return { errors }
  return { input: { ...settings, kind: "saved_query", savedQueryId: draft.savedQueryId, parameters } }
}

/** A value as the server reads it: text is a relative date when it reads as one, else a fixed one. */
function canonical(value: RoutineValue | undefined): string {
  if (value === undefined) return ""
  if (value === null) return "null"
  if (typeof value !== "string") return `${value.kind}:${value.value.trim()}`
  const text = value.trim()
  return `${isRelative(text) ? "relative" : "absolute"}:${text}`
}

function sameValues(a: RoutineValues, b: RoutineValues): boolean {
  const names = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...names].every((name) => canonical(a[name]) === canonical(b[name]))
}

const sameIds = (a: string[], b: string[]) => [...a].sort().join(",") === [...b].sort().join(",")

/** Only what changed from the routine as it was opened; a new kind sends its whole target. */
export function routinePatch(
  version: number,
  routine: RoutineDetail,
  input: CreateRoutineInput,
): UpdateRoutineInput {
  const patch: UpdateRoutineInput = { version }
  if (input.name !== routine.name) patch.name = input.name
  if (input.description !== routine.description) patch.description = input.description
  if (input.cron !== routine.cron) patch.cron = input.cron
  if (input.timeZone !== routine.timeZone) patch.timeZone = input.timeZone
  if (input.enabled !== routine.enabled) patch.enabled = input.enabled
  const kindChanged = input.kind !== routine.kind
  if (kindChanged) patch.kind = input.kind
  if (input.kind === "saved_query") {
    const storedId = routine.savedQuery && routine.savedQuery.state !== "removed" ? routine.savedQuery.id : ""
    if (kindChanged || input.savedQueryId !== storedId) patch.savedQueryId = input.savedQueryId
    if (kindChanged || !sameValues(input.parameters, routine.parameters)) patch.parameters = input.parameters
  } else {
    if (kindChanged || input.question !== routine.question) patch.question = input.question
    if (kindChanged || !sameIds(input.connectionIds, routine.connectionIds)) {
      patch.connectionIds = input.connectionIds
    }
  }
  return patch
}

/** True when the patch changes nothing but names its version. */
export function isEmptyPatch(patch: UpdateRoutineInput): boolean {
  return Object.keys(patch).every((key) => key === "version")
}
