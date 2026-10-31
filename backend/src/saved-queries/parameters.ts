import { AppError } from "../shared/http/errors.js"
import {
  addDays,
  addMonths,
  formatDate,
  formatInstant,
  instantOf,
  isValidDate,
  startOfDay,
  startOfWeek,
  wallTimeAt,
  type CalendarDate,
} from "./dates.js"
import {
  parseRelativeDate,
  type ParameterDefinition,
  type ParameterType,
  type ParameterValue,
  type ResolvedParameter,
} from "./schemas.js"

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/i

/** A value a parameter cannot take; the message says what to write instead. */
export class ParameterValueError extends Error {}

/** The calendar date a relative value names at `now` in the time zone. */
export function relativeDate(value: string, timeZone: string, now: number): CalendarDate {
  const relative = parseRelativeDate(value)
  if (!relative) throw new ParameterValueError(`${value} is not a relative date.`)
  const { year, month, day } = wallTimeAt(now, timeZone)
  const today = { year, month, day }
  switch (relative.kind) {
    case "today":
      return today
    case "yesterday":
      return addDays(today, -1)
    case "start_of_week":
      return startOfWeek(today)
    case "start_of_month":
      return { year, month, day: 1 }
    case "start_of_quarter":
      return { year, month: Math.floor((month - 1) / 3) * 3 + 1, day: 1 }
    case "start_of_year":
      return { year, month: 1, day: 1 }
    case "days_ago":
      return addDays(today, -relative.count)
    case "months_ago":
      return addMonths(today, -relative.count)
  }
}

function calendarDate(year: string, month: string, day: string, text: string): CalendarDate {
  const date = { year: Number(year), month: Number(month), day: Number(day) }
  if (!isValidDate(date)) {
    throw new ParameterValueError(`${text} is not a date between the years 1000 and 9999.`)
  }
  return date
}

/** The instant a datetime names: its own offset if it has one, else wall-clock time in the zone. */
function datetimeInstant(text: string, timeZone: string): number {
  const match = DATETIME.exec(text)
  if (!match) {
    throw new ParameterValueError(
      `${text} is not a date or datetime. Use a date like 2026-10-01 or a time like 2026-10-01T09:30.`,
    )
  }
  const [, year = "", month = "", day = "", hour = "", minute = "", second = "0", fraction = "", zone] = match
  const date = calendarDate(year, month, day, text)
  const time = {
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(fraction.padEnd(3, "0")),
  }
  if (time.hour > 23 || time.minute > 59 || time.second > 59) {
    throw new ParameterValueError(`${text} is not a time of day.`)
  }
  const wall = { ...date, ...time }
  if (!zone) return instantOf(wall, timeZone)
  const utc = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    time.hour,
    time.minute,
    time.second,
    time.millisecond,
  )
  if (zone.toUpperCase() === "Z") return utc
  const sign = zone.startsWith("-") ? -1 : 1
  const offsetHours = Number(zone.slice(1, 3))
  const offsetMinutes = Number(zone.slice(4, 6))
  if (offsetHours > 18 || offsetMinutes > 59) {
    throw new ParameterValueError(`${text} has an impossible offset.`)
  }
  return utc - sign * (offsetHours * 60 + offsetMinutes) * 60_000
}

export interface ResolvedValue {
  /** "2026-10-01" for dates; for datetimes ISO 8601 with the zone's offset, e.g. 2026-10-01T00:00:00+05:30. */
  value: string
  /** The instant it stands for; a date's first instant in the zone. */
  instant: number
}

/** What a value means for a parameter of `type`, resolved in the time zone at `now`. */
export function resolveValue(
  input: ParameterValue,
  type: ParameterType,
  timeZone: string,
  now: number,
): ResolvedValue {
  const text = input.value.trim()
  let date: CalendarDate | null = null
  if (input.kind === "relative") {
    date = relativeDate(text, timeZone, now)
  } else {
    const match = DATE.exec(text)
    if (match) date = calendarDate(match[1] ?? "", match[2] ?? "", match[3] ?? "", text)
    else if (type === "date") {
      throw new ParameterValueError(`${text} is not a date. Use a date like 2026-10-01.`)
    }
  }
  if (date) {
    const instant = startOfDay(date, timeZone)
    return { value: type === "date" ? formatDate(date) : formatInstant(instant, timeZone), instant }
  }
  const instant = datetimeInstant(text, timeZone)
  return { value: formatInstant(instant, timeZone), instant }
}

/** Text sent for a run: a relative date when it reads as one, else a fixed date or datetime. */
export function valueFromText(text: string): ParameterValue {
  const trimmed = text.trim()
  return parseRelativeDate(trimmed) ? { kind: "relative", value: trimmed } : { kind: "absolute", value: trimmed }
}

/** Why parameters do not fit, by kind; each lists parameter names (or placeholders). */
export interface ParameterProblems {
  /** Placeholders or run values without a parameter definition. */
  unknown?: string[]
  /** Definitions the query does not use. */
  unused?: string[]
  /** Required parameters without a value or default. */
  missing?: string[]
  invalid?: { name: string; message: string }[]
  /** Placeholder-like text that is not a valid placeholder. */
  malformed?: string[]
}

const list = (names: string[]) => names.join(", ")

/** One 422 that names every problem. */
export function parameterError(problems: ParameterProblems): AppError {
  const sentences: string[] = []
  const { unknown = [], unused = [], missing = [], invalid = [], malformed = [] } = problems
  if (malformed.length > 0) {
    sentences.push(
      `Write parameters as {{name}} in SQL or {"$param": "name"} in MongoDB; these are not placeholders: ${list(malformed)}.`,
    )
  }
  if (unknown.length > 0) sentences.push(`No parameter is defined for ${list(unknown)}.`)
  if (unused.length > 0) sentences.push(`The query does not use ${list(unused)}; use or remove it.`)
  if (missing.length > 0) sentences.push(`${list(missing)} need${missing.length === 1 ? "s" : ""} a value.`)
  for (const problem of invalid) sentences.push(`${problem.name}: ${problem.message}`)
  const details = Object.fromEntries(
    Object.entries({ unknown, unused, missing, invalid, malformed }).filter(([, names]) => names.length > 0),
  )
  return AppError.invalidParameters(sentences.join(" "), details)
}

export type RunValues = Record<string, string | ParameterValue | null>

export interface Resolution {
  parameters: ResolvedParameter[]
  /** Each parameter's instant (null without a value), for engines that bind dates. */
  instants: Map<string, number | null>
}

/**
 * Resolves each parameter from the run's values, else its default. Unknown
 * names, invalid values, and (with `requireValues`) required parameters left
 * without a value throw one INVALID_PARAMETERS error naming them all.
 */
export function resolveParameters(
  definitions: ParameterDefinition[],
  values: RunValues,
  context: { timeZone: string; now: number; requireValues: boolean },
): Resolution {
  const known = new Set(definitions.map((definition) => definition.name))
  const unknown = Object.keys(values).filter((name) => !known.has(name))
  const missing: string[] = []
  const invalid: { name: string; message: string }[] = []
  const parameters: ResolvedParameter[] = []
  const instants = new Map<string, number | null>()

  for (const definition of definitions) {
    const sent = Object.hasOwn(values, definition.name) ? values[definition.name] : undefined
    const input =
      sent === undefined ? definition.default : typeof sent === "string" ? valueFromText(sent) : sent
    const from = sent !== undefined ? "run" : definition.default ? "default" : null
    let resolved: ResolvedValue | null = null
    if (input) {
      try {
        resolved = resolveValue(input, definition.type, context.timeZone, context.now)
      } catch (error) {
        if (!(error instanceof ParameterValueError)) throw error
        invalid.push({ name: definition.name, message: error.message })
      }
    } else if (definition.required) {
      missing.push(definition.name)
    }
    parameters.push({
      name: definition.name,
      label: definition.label,
      type: definition.type,
      from,
      input,
      value: resolved?.value ?? null,
    })
    instants.set(definition.name, resolved?.instant ?? null)
  }

  const problems = { unknown, invalid, missing: context.requireValues ? missing : [] }
  if (problems.unknown.length > 0 || problems.invalid.length > 0 || problems.missing.length > 0) {
    throw parameterError(problems)
  }
  return { parameters, instants }
}

/** The values a run resolved to, by name, as its execution record keeps them. */
export function resolvedValues(parameters: ResolvedParameter[]): Record<string, string | null> {
  return Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.value]))
}
