import { snapshotRows } from "../queries/results.js"
import type { ColumnKind, QueryResult, ResultColumn } from "../queries/schemas.js"
import { DASHBOARD_LIMITS, type PanelDefinition } from "./schemas.js"

/** Kinds a number panel can show; mixed MongoDB fields are "unknown" and checked when shown. */
const NUMBER_KINDS = new Set<ColumnKind>(["integer", "decimal", "float", "unknown"])

/** Column names listed in a message before the rest are elided. */
const LISTED_COLUMNS = 20

export interface ColumnProblem {
  /** The config field naming the column, e.g. "config.valueColumn" or "config.columns.2". */
  field: string
  column: string
  message: string
}

/** The columns a panel's config names, with the field each one is in. */
function namedColumns(panel: PanelDefinition): { field: string; column: string }[] {
  switch (panel.kind) {
    case "number": {
      const { valueColumn, comparisonColumn } = panel.config
      const named = [{ field: "config.valueColumn", column: valueColumn }]
      return comparisonColumn === null
        ? named
        : [...named, { field: "config.comparisonColumn", column: comparisonColumn }]
    }
    case "table":
      return (panel.config.columns ?? []).map((column, index) => ({
        field: `config.columns.${index}`,
        column,
      }))
    case "markdown":
      return []
  }
}

function columnList(columns: ResultColumn[]): string {
  const names = columns.slice(0, LISTED_COLUMNS).map((column) => column.name)
  if (names.length === 0) return "none"
  return `${names.join(", ")}${columns.length > LISTED_COLUMNS ? ", …" : ""}`
}

/** The first column of each name; results may repeat a name (SELECT a.id, b.id). */
function firstByName(columns: ResultColumn[]): Map<string, number> {
  const indexes = new Map<string, number>()
  columns.forEach((column, index) => {
    if (!indexes.has(column.name)) indexes.set(column.name, index)
  })
  return indexes
}

/**
 * Checks the columns a panel's config names against a result's columns: each
 * must exist, and a number panel's columns must hold numbers.
 */
export function columnProblem(panel: PanelDefinition, columns: ResultColumn[]): ColumnProblem | null {
  const indexes = firstByName(columns)
  for (const { field, column } of namedColumns(panel)) {
    const index = indexes.get(column)
    const found = index === undefined ? undefined : columns[index]
    if (!found) {
      return {
        field,
        column,
        message: `The latest result has no column “${column}”. Its columns are: ${columnList(columns)}.`,
      }
    }
    if (panel.kind === "number" && !NUMBER_KINDS.has(found.kind)) {
      return {
        field,
        column,
        message: `“${column}” holds ${found.kind} values; a number panel needs a column of numbers.`,
      }
    }
  }
  return null
}

/**
 * What a panel shows of a stored result: only the columns it names (columns
 * it names that the result no longer has are left out), and only the rows it
 * shows: the first for a number, the leading rows within the row and byte
 * bounds for a table.
 */
export function panelResult(
  panel: PanelDefinition,
  result: QueryResult,
): { result: QueryResult; partialResult: boolean } {
  const byName = firstByName(result.columns)
  const indexes =
    panel.kind === "table" && panel.config.columns === null
      ? result.columns.map((_column, index) => index)
      : namedColumns(panel).flatMap(({ column }) => byName.get(column) ?? [])
  const maxRows = panel.kind === "number" ? 1 : DASHBOARD_LIMITS.tableRows
  const rows = snapshotRows(
    result.rows.slice(0, maxRows).map((row) => indexes.map((index) => row[index] ?? null)),
    maxRows,
    DASHBOARD_LIMITS.panelBytes,
  )
  return {
    result: { ...result, columns: indexes.flatMap((index) => result.columns[index] ?? []), rows },
    partialResult: rows.length < result.rowCount,
  }
}
