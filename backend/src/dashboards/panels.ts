import { snapshotRows } from "../queries/results.js"
import type { ColumnKind, QueryResult, ResultColumn } from "../queries/schemas.js"
import { DASHBOARD_LIMITS, type PanelDefinition, type PanelKind } from "./schemas.js"

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

interface NamedColumn {
  field: string
  column: string
  /** The column must hold numbers. */
  numeric: boolean
}

const named = (field: string, column: string | null, numeric: boolean): NamedColumn[] =>
  column === null ? [] : [{ field: `config.${field}`, column, numeric }]

/** The columns a panel's config names, with the field each one is in. */
function namedColumns(panel: PanelDefinition): NamedColumn[] {
  switch (panel.kind) {
    case "number":
      return [
        ...named("valueColumn", panel.config.valueColumn, true),
        ...named("comparisonColumn", panel.config.comparisonColumn, true),
      ]
    case "table":
      return (panel.config.columns ?? []).flatMap((column, index) => named(`columns.${index}`, column, false))
    case "markdown":
      return []
    case "bar":
    case "line":
      return [
        ...named("xColumn", panel.config.xColumn, false),
        ...panel.config.yColumns.flatMap((column, index) => named(`yColumns.${index}`, column, true)),
      ]
    case "gauge":
      return named("valueColumn", panel.config.valueColumn, true)
    case "ticker":
      return [
        ...named("labelColumn", panel.config.labelColumn, false),
        ...named("valueColumn", panel.config.valueColumn, true),
        ...named("deltaColumn", panel.config.deltaColumn, true),
      ]
    case "sankey":
      return [
        ...named("sourceColumn", panel.config.sourceColumn, false),
        ...named("targetColumn", panel.config.targetColumn, false),
        ...named("valueColumn", panel.config.valueColumn, true),
      ]
  }
}

/** How a message names each kind of panel. */
const PANEL_NAMES: Record<PanelKind, string> = {
  number: "a number panel",
  table: "a table",
  markdown: "a Markdown panel",
  bar: "a bar chart",
  line: "a line chart",
  gauge: "a gauge",
  ticker: "a ticker",
  sankey: "a Sankey diagram",
}

/** The leading rows of its result a panel shows, and their bound as JSON. */
export function panelRows(kind: PanelKind): { rows: number; bytes: number } {
  switch (kind) {
    case "number":
    case "gauge":
      return { rows: 1, bytes: DASHBOARD_LIMITS.panelBytes }
    case "table":
    case "markdown":
      return { rows: DASHBOARD_LIMITS.tableRows, bytes: DASHBOARD_LIMITS.panelBytes }
    case "ticker":
      return { rows: DASHBOARD_LIMITS.tickerRows, bytes: DASHBOARD_LIMITS.panelBytes }
    case "bar":
    case "line":
    case "sankey":
      return { rows: DASHBOARD_LIMITS.chartRows, bytes: DASHBOARD_LIMITS.chartBytes }
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
 * must exist, and those that carry values must hold numbers.
 */
export function columnProblem(panel: PanelDefinition, columns: ResultColumn[]): ColumnProblem | null {
  const indexes = firstByName(columns)
  for (const { field, column, numeric } of namedColumns(panel)) {
    const index = indexes.get(column)
    const found = index === undefined ? undefined : columns[index]
    if (!found) {
      return {
        field,
        column,
        message: `The latest result has no column “${column}”. Its columns are: ${columnList(columns)}.`,
      }
    }
    if (numeric && !NUMBER_KINDS.has(found.kind)) {
      return {
        field,
        column,
        message: `“${column}” holds ${found.kind} values; ${PANEL_NAMES[panel.kind]} needs a column of numbers.`,
      }
    }
  }
  return null
}

/**
 * What a panel shows of a stored result: only the columns it names (columns
 * it names that the result no longer has are left out), and only the leading
 * rows it shows, within its row and byte bounds.
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
  const { rows: maxRows, bytes } = panelRows(panel.kind)
  const rows = snapshotRows(
    result.rows.slice(0, maxRows).map((row) => indexes.map((index) => row[index] ?? null)),
    maxRows,
    bytes,
  )
  return {
    result: { ...result, columns: indexes.flatMap((index) => result.columns[index] ?? []), rows },
    partialResult: rows.length < result.rowCount,
  }
}
