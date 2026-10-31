import { parse, scan, type ScanToken } from "libpg-query"

import type { MongoQuery, ReadQuery, SqlParam } from "../queries/schemas.js"
import { syntaxError } from "../queries/sql-validator.js"
import { AppError } from "../shared/http/errors.js"
import { parameterError } from "./parameters.js"
import { PARAMETER_NAME, type ParameterDefinition, type SavedQueryWarning } from "./schemas.js"

// Saved queries name their parameters in the query: {{name}} in SQL, and
// {"$param": "name"} in MongoDB filter and pipeline values. Compiling finds
// them; binding produces the read query that runs. SQL placeholders become
// positional parameters ($1..$n, by order of first use) whose values are
// bound by the driver, never written into the SQL text. MongoDB placeholders
// become dates before the query is validated.

export interface BoundValue {
  /** The resolved text, e.g. "2026-10-01" or "2026-10-01T00:00:00+05:30"; null without a value. */
  value: string | null
  /** The instant it stands for. */
  instant: number | null
}

export interface CompiledQuery {
  /** Placeholder names in order of first use. */
  names: string[]
  /** What the query reads from the database clock (now(), current_date, $$NOW, …). */
  clock: string[]
  /** The read query with every placeholder replaced by its value. */
  bind(values: ReadonlyMap<string, BoundValue>): ReadQuery
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
/** Anything else in double braces, or a stray {{ or }}. */
const BRACES = /\{\{[^{}\n]{0,40}\}\}|\{\{|\}\}/g
/** Named tokens whose text is data, not SQL: strings and comments. */
const LITERAL_TOKENS = new Set(["SCONST", "C_COMMENT", "SQL_COMMENT"])
/**
 * Quoted identifiers and the strings the scanner leaves unnamed (U&'…', U&"…",
 * B'…', X'…'), recognized by how they start.
 */
const QUOTED_TOKEN = /^(?:[bx]|u&)?['"]/i
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/
/** Nesting deeper than this is refused before anything walks it (the validator's own limit). */
const MAX_DEPTH = 40

const isLiteral = (token: ScanToken) => LITERAL_TOKENS.has(token.tokenName) || QUOTED_TOKEN.test(token.text)

/** Maps the scanner's UTF-8 byte offsets to string indexes. */
function charIndexes(text: string): (byte: number) => number {
  if (Buffer.byteLength(text) === text.length) return (byte) => byte
  const indexes = new Map<number, number>()
  let byte = 0
  for (let index = 0; index < text.length; ) {
    indexes.set(byte, index)
    const code = text.codePointAt(index) ?? 0
    byte += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    index += code > 0xffff ? 2 : 1
  }
  indexes.set(byte, text.length)
  return (offset) => indexes.get(offset) ?? text.length
}

/** Strings, comments, and quoted identifiers, as [start, end) string ranges in order. */
async function literalRanges(sql: string): Promise<{ ranges: [number, number][]; positional: string[] }> {
  let tokens: ScanToken[]
  try {
    tokens = (await scan(sql)).tokens
  } catch {
    // The scanner's own error is not readable; the parser says what is wrong.
    let rejection = syntaxError(new Error("The SQL could not be read"))
    try {
      await parse(sql)
    } catch (error) {
      rejection = syntaxError(error)
    }
    throw AppError.queryRejected(rejection.message, {
      executionId: null,
      reason: rejection.reason,
      name: null,
    })
  }
  const index = charIndexes(sql)
  return {
    ranges: tokens.filter(isLiteral).map((token) => [index(token.start), index(token.end)]),
    positional: tokens.filter((token) => token.tokenName === "PARAM").map((token) => token.text),
  }
}

/** Whether `at` falls in one of the sorted, non-overlapping [start, end) ranges. */
function inside(ranges: [number, number][], at: number): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [start, end] = ranges[middle] ?? [0, 0]
    if (at < start) high = middle - 1
    else if (at >= end) low = middle + 1
    else return true
  }
  return false
}

async function compileSql(sql: string): Promise<CompiledQuery> {
  const { ranges, positional } = await literalRanges(sql)
  const names: string[] = []
  const spans: [number, number][] = []
  let rendered = ""
  let last = 0
  for (const match of sql.matchAll(PLACEHOLDER)) {
    const start = match.index
    const end = start + match[0].length
    if (inside(ranges, start)) continue
    const name = match[1] ?? ""
    if (!names.includes(name)) names.push(name)
    // Spaces keep $n from joining a neighbouring identifier or number.
    const before = IDENTIFIER_CHAR.test(sql.charAt(start - 1)) ? " " : ""
    const after = IDENTIFIER_CHAR.test(sql.charAt(end)) ? " " : ""
    rendered += `${sql.slice(last, start)}${before}$${names.indexOf(name) + 1}${after}`
    last = end
    spans.push([start, end])
  }
  rendered += sql.slice(last)

  const malformed = [...sql.matchAll(BRACES)]
    .filter((match) => !inside(ranges, match.index) && !inside(spans, match.index))
    .map((match) => match[0])
  if (malformed.length > 0 || positional.length > 0) {
    throw parameterError({ malformed: [...new Set([...malformed, ...positional])] })
  }
  const clock = await sqlClock(rendered)
  return {
    names,
    clock,
    bind(values) {
      if (names.length === 0) return { language: "sql", sql }
      const params: SqlParam[] = names.map((name) => values.get(name)?.value ?? null)
      return { language: "sql", sql: rendered, params }
    },
  }
}

// The database clock ----------------------------------------------------------

const CLOCK_VALUE_FUNCTIONS: Record<string, string> = {
  SVFOP_CURRENT_DATE: "current_date",
  SVFOP_CURRENT_TIME: "current_time",
  SVFOP_CURRENT_TIME_N: "current_time",
  SVFOP_CURRENT_TIMESTAMP: "current_timestamp",
  SVFOP_CURRENT_TIMESTAMP_N: "current_timestamp",
  SVFOP_LOCALTIME: "localtime",
  SVFOP_LOCALTIME_N: "localtime",
  SVFOP_LOCALTIMESTAMP: "localtimestamp",
  SVFOP_LOCALTIMESTAMP_N: "localtimestamp",
}
const CLOCK_FUNCTIONS = new Set([
  "now",
  "statement_timestamp",
  "transaction_timestamp",
  "clock_timestamp",
  "timeofday",
])
const CLOCK_WORDS = new Set(["now", "today", "tomorrow", "yesterday"])

type Node = Record<string, unknown>

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function clockUse(key: string, node: Node): string | null {
  if (key === "SQLValueFunction") return CLOCK_VALUE_FUNCTIONS[String(node.op)] ?? null
  if (key === "FuncCall" && Array.isArray(node.funcname)) {
    const last: unknown = node.funcname.at(-1)
    const name = isNode(last) && isNode(last.String) ? String(last.String.sval).toLowerCase() : ""
    return CLOCK_FUNCTIONS.has(name) ? `${name}()` : null
  }
  if (key === "TypeCast" && isNode(node.arg) && isNode(node.arg.A_Const) && isNode(node.arg.A_Const.sval)) {
    const word = String(node.arg.A_Const.sval.sval).trim().toLowerCase()
    return CLOCK_WORDS.has(word) ? `'${word}'` : null
  }
  return null
}

/** Clock functions and 'now'-style literals the SQL uses; empty if it cannot be parsed. */
async function sqlClock(sql: string): Promise<string[]> {
  const found = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isNode(value)) return
    for (const [key, child] of Object.entries(value)) {
      const use = isNode(child) ? clockUse(key, child) : null
      if (use) found.add(use)
      visit(child)
    }
  }
  try {
    visit(await parse(sql))
  } catch {
    // Unparsable SQL is reported by the validator; nesting too deep to walk is not worth a warning.
  }
  return [...found]
}

// MongoDB ----------------------------------------------------------------------

const MONGO_CLOCK = new Set(["$$NOW", "$$CLUSTER_TIME"])

/** A copy of a filter or pipeline value with each {"$param": name} replaced by `placeholder(name)`. */
function mapMongo(
  value: unknown,
  placeholder: (name: string) => unknown,
  onString: (text: string) => void,
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) {
    throw AppError.queryRejected(`The query is nested more than ${MAX_DEPTH} levels deep.`, {
      executionId: null,
      reason: "invalid_query",
      name: null,
    })
  }
  if (typeof value === "string") onString(value)
  if (Array.isArray(value)) return value.map((item) => mapMongo(item, placeholder, onString, depth + 1))
  if (!isNode(value)) return value
  if (Object.hasOwn(value, "$param")) {
    const name = value.$param
    if (Object.keys(value).length !== 1 || typeof name !== "string" || !PARAMETER_NAME.test(name)) {
      throw parameterError({ malformed: [JSON.stringify(value).slice(0, 60)] })
    }
    return placeholder(name)
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, mapMongo(child, placeholder, onString, depth + 1)]),
  )
}

function compileMongo(query: MongoQuery): CompiledQuery {
  const names: string[] = []
  const clock = new Set<string>()
  const walk = (placeholder: (name: string) => unknown) => {
    const { filter, pipeline } = query as { filter?: unknown; pipeline?: unknown }
    const onString = (text: string) => {
      if (MONGO_CLOCK.has(text)) clock.add(text)
    }
    return {
      ...(filter !== undefined ? { filter: mapMongo(filter, placeholder, onString) } : {}),
      ...(pipeline !== undefined ? { pipeline: mapMongo(pipeline, placeholder, onString) } : {}),
    }
  }
  walk((name) => {
    if (!names.includes(name)) names.push(name)
    return null
  })
  return {
    names,
    clock: [...clock],
    bind(values) {
      const parts = walk((name) => {
        const instant = values.get(name)?.instant ?? null
        return instant === null ? null : { $date: new Date(instant).toISOString() }
      })
      return { ...query, ...parts } as MongoQuery
    },
  }
}

/** Finds a saved query's placeholders; malformed ones throw a 422 that names them. */
export async function compileQuery(query: ReadQuery): Promise<CompiledQuery> {
  return query.language === "sql" ? compileSql(query.sql) : compileMongo(query)
}

/** Placeholders without a definition and definitions without a placeholder are both errors. */
export function checkPlaceholders(compiled: CompiledQuery, definitions: ParameterDefinition[]): void {
  const defined = new Set(definitions.map((definition) => definition.name))
  const unknown = compiled.names.filter((name) => !defined.has(name))
  const unused = definitions
    .map((definition) => definition.name)
    .filter((name) => !compiled.names.includes(name))
  if (unknown.length > 0 || unused.length > 0) throw parameterError({ unknown, unused })
}

/** Advice for queries whose rows depend on when and where they run. */
export function clockWarnings(compiled: CompiledQuery): SavedQueryWarning[] {
  if (compiled.clock.length === 0) return []
  return [
    {
      code: "database_clock",
      message: `This query reads the database clock (${compiled.clock.join(", ")}), so its rows depend on when it runs and on the source's time zone. A date parameter makes runs repeatable and resolves in the workspace time zone.`,
    },
  ]
}
