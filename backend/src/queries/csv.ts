import type { Cell, QueryResult } from "./schemas.js"

// RFC 4180 CSV of a stored result: a UTF-8 byte order mark (so spreadsheet
// programs read UTF-8), CRLF line ends, and fields quoted when they hold a
// quote, comma, CR, or LF. Values are the result's own text: exact numeric
// strings, ISO dates, and empty fields for NULL and for missing MongoDB fields.

const BOM = "\uFEFF"
const CRLF = "\r\n"
/** Text a spreadsheet would run as a formula (or a DDE call) when it starts a cell. */
const FORMULA_START = /^[=+\-@\t\r]/
/** A plain number, which a spreadsheet reads as a number however it starts. */
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const NEEDS_QUOTES = /[",\r\n]/

/** A cell's text: numbers and booleans as written, NULL and missing as empty. */
export function cellText(cell: Cell): string {
  if (cell === null || typeof cell === "object") return ""
  return String(cell)
}

/**
 * One CSV field. Text starting with = + - @, a tab, or CR is prefixed with an
 * apostrophe so spreadsheets show it instead of running it as a formula;
 * plain numbers such as -12.50 stay as they are.
 */
export function csvField(text: string): string {
  const safe = FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** The header row (column names in order) and every row of the result. */
export function resultCsv(result: Pick<QueryResult, "columns" | "rows">): string {
  const lines = [result.columns.map((column) => csvField(column.name)).join(",")]
  for (const row of result.rows) {
    lines.push(result.columns.map((_, index) => csvField(cellText(row[index] ?? null))).join(","))
  }
  return `${BOM}${lines.join(CRLF)}${CRLF}`
}
