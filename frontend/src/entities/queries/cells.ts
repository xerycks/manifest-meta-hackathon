import {
  QUERY_LIMITS,
  type Cell,
  type ColumnKind,
  type MissingCell,
  type QueryResult,
  type ResultColumn,
} from "./types.ts"

/** Longer text is cut in the table; the full value stays available as its title. */
const MAX_CELL_CHARS = 200

const NUMERIC_KINDS = new Set<ColumnKind>(["integer", "decimal", "float"])

export function isNumericColumn(column: ResultColumn): boolean {
  return NUMERIC_KINDS.has(column.kind)
}

export function isMissing(cell: Cell): cell is MissingCell {
  return typeof cell === "object" && cell !== null && cell.$missing === true
}

export interface CellDisplay {
  text: string
  /** NULL and missing are labelled, never shown as blank. */
  tone: "value" | "null" | "missing"
  align: "left" | "right"
  /** The full value when `text` is shortened or reformatted. */
  title?: string
}

/** "2026-10-31T09:30:00.123456Z" as "2026-10-31 09:30:00.123456 UTC", keeping every digit. */
export function formatDateTime(value: string): string {
  const match = /^(\d{4,}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2}(?::\d{2})?)?$/.exec(value)
  if (!match) return value
  const [, date, time, zone] = match
  return `${date} ${time}${zone === "Z" ? " UTC" : zone ? ` ${zone}` : ""}`
}

function shorten(text: string): Pick<CellDisplay, "text" | "title"> {
  return text.length > MAX_CELL_CHARS
    ? { text: `${text.slice(0, MAX_CELL_CHARS)}…`, title: text }
    : { text }
}

/** How one cell reads in a result table: exact numbers right-aligned, NULL and missing labelled. */
export function displayCell(cell: Cell, column: ResultColumn): CellDisplay {
  if (cell === null) return { text: "NULL", tone: "null", align: "left", title: "SQL NULL or a null value" }
  if (isMissing(cell)) {
    return { text: "missing", tone: "missing", align: "left", title: "This document has no such field" }
  }
  const numeric = isNumericColumn(column) || typeof cell === "number"
  const align = numeric ? "right" : "left"
  if (typeof cell === "number" || typeof cell === "boolean") return { text: String(cell), tone: "value", align }
  if (column.kind === "datetime") {
    const text = formatDateTime(cell)
    return text === cell ? { text, tone: "value", align } : { text, tone: "value", align, title: cell }
  }
  if (column.kind === "binary" && cell.startsWith("\\x")) {
    const bytes = Math.floor((cell.length - 2) / 2)
    const label = `${bytes.toLocaleString("en-US")} byte${bytes === 1 ? "" : "s"}`
    return cell.length > 34
      ? { text: `${cell.slice(0, 34)}… (${label})`, tone: "value", align, title: cell }
      : { text: cell, tone: "value", align, title: label }
  }
  return { ...shorten(cell), tone: "value", align }
}

const count = (value: number, one: string, many: string) =>
  `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`

/** "3 rows in 12 ms", or for a stored snapshot "first 1,000 of 4,800 rows". */
export function describeResult(result: QueryResult, partial = false): string {
  const total = count(result.rowCount, "row", "rows")
  const rows = partial
    ? `First ${result.rows.length.toLocaleString("en-US")} of ${total} (stored result)`
    : total
  return `${rows} · ${result.durationMs.toLocaleString("en-US")} ms`
}

/** Why a result stops where it does, or null when it holds everything the query returned. */
export function truncationNotice(result: QueryResult): string | null {
  if (!result.truncated) return null
  if (result.truncatedBy === "bytes") {
    return `The result reached the ${QUERY_LIMITS.resultMegabytes} MB limit after ${count(result.rowCount, "row", "rows")}. Select fewer columns or narrow the query to see the rest.`
  }
  return `More rows matched. Only the first ${count(result.rowCount, "row", "rows")} (the row limit) are shown; raise the limit or narrow the query.`
}
