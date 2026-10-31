import type { WorkspaceRole } from "../../app/organization-role.ts"
import type { Cell, ColumnKind, QueryResult, ResultColumn } from "../queries/types.ts"
import { formatParameterValue } from "../saved-queries/parameters.ts"
import {
  DASHBOARD_LIMITS,
  type Dashboard,
  type NumberConfig,
  type PanelDefinition,
  type PanelKind,
} from "./types.ts"

export const PANEL_KIND_LABELS: Record<PanelKind, string> = {
  number: "Number",
  table: "Table",
  markdown: "Text (Markdown)",
  bar: "Bar chart",
  line: "Line chart",
  gauge: "Gauge",
  ticker: "Ticker",
  sankey: "Sankey diagram",
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

/** Kinds a number panel can show; mixed MongoDB fields are "unknown" and checked when shown. */
const NUMBER_KINDS = new Set<ColumnKind>(["integer", "decimal", "float", "unknown"])

export function holdsNumbers(column: ResultColumn): boolean {
  return NUMBER_KINDS.has(column.kind)
}

/** The index of the first column of each name; results may repeat a name. */
function firstByName(columns: ResultColumn[]): Map<string, number> {
  const indexes = new Map<string, number>()
  columns.forEach((column, index) => {
    if (!indexes.has(column.name)) indexes.set(column.name, index)
  })
  return indexes
}

/** A column a panel's config names: the config field, the column, and whether it must hold numbers. */
interface NamedColumn {
  field: string
  column: string
  numeric: boolean
}

const named = (field: string, column: string | null, numeric: boolean): NamedColumn[] =>
  column === null || column === "" ? [] : [{ field, column, numeric }]

/** The columns a panel's config names, in the order its result carries them. */
function namedColumns(panel: PanelDefinition): NamedColumn[] {
  switch (panel.kind) {
    case "number":
      return [
        ...named("valueColumn", panel.config.valueColumn, true),
        ...named("comparisonColumn", panel.config.comparisonColumn, true),
      ]
    case "table":
      return (panel.config.columns ?? []).flatMap((column) => named("columns", column, false))
    case "markdown":
      return []
    case "bar":
    case "line":
      return [
        ...named("xColumn", panel.config.xColumn, false),
        ...panel.config.yColumns.flatMap((column) => named("yColumns", column, true)),
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

/**
 * Mirrors the server: the first column a panel's config names that does not
 * fit a result's columns (it is not there, or one that carries values does
 * not hold numbers) and why, or null when the config fits.
 */
export function columnProblem(
  panel: PanelDefinition,
  columns: ResultColumn[],
): { field: string; column: string; message: string } | null {
  const indexes = firstByName(columns)
  for (const { field, column: name, numeric } of namedColumns(panel)) {
    const index = indexes.get(name)
    const column = index === undefined ? undefined : columns[index]
    if (!column) return { field, column: name, message: `The result has no column “${name}”.` }
    if (numeric && !holdsNumbers(column)) {
      return {
        field,
        column: name,
        message: `“${name}” holds ${column.kind} values; ${PANEL_NAMES[panel.kind]} needs a column of numbers.`,
      }
    }
  }
  return null
}

/** The leading rows of its result a panel shows, as the server cuts them. */
export function panelRows(kind: PanelKind): number {
  switch (kind) {
    case "number":
    case "gauge":
      return 1
    case "table":
    case "markdown":
      return DASHBOARD_LIMITS.tableRows
    case "ticker":
      return DASHBOARD_LIMITS.tickerRows
    case "bar":
    case "line":
    case "sankey":
      return DASHBOARD_LIMITS.chartRows
  }
}

/** The part of a result a panel shows, as the server cuts it: its columns and its leading rows. */
export function shownResult(panel: PanelDefinition, result: QueryResult): QueryResult {
  const byName = firstByName(result.columns)
  const indexes =
    panel.kind === "table" && panel.config.columns === null
      ? result.columns.map((_column, index) => index)
      : namedColumns(panel).flatMap(({ column }) => byName.get(column) ?? [])
  const maxRows = panelRows(panel.kind)
  return {
    ...result,
    columns: indexes.flatMap((index) => result.columns[index] ?? []),
    rows: result.rows.slice(0, maxRows).map((row) => indexes.map((index) => row[index] ?? null)),
  }
}

/** A number panel's value and comparison cells from the first row; undefined when there is none. */
export function numberCells(
  config: NumberConfig,
  result: QueryResult,
): { value: Cell; comparison: Cell | undefined } | undefined {
  const row = result.rows[0]
  if (!row) return undefined
  const byName = firstByName(result.columns)
  const cell = (name: string) => {
    const index = byName.get(name)
    return index === undefined ? undefined : row[index]
  }
  return {
    value: cell(config.valueColumn) ?? null,
    comparison: config.comparisonColumn === null ? undefined : cell(config.comparisonColumn),
  }
}

/** The panel's own title, else its saved query's name. */
export function panelTitle(title: string, savedQueryName: string | null): string {
  return title.trim() || savedQueryName || ""
}

/**
 * The parameter values a panel's result ran with ("since: 2026-07-31 00:00:00+05:30"), or null
 * without any. A panel shows its saved query's latest run, which a routine or a rerun with other
 * values may have made, so the values say what the result covers.
 */
export function runValues(parameters: Record<string, string | null> | null): string | null {
  const values = Object.entries(parameters ?? {}).map(
    ([name, value]) => `${name}: ${value === null ? "none" : formatParameterValue(value)}`,
  )
  return values.length > 0 ? values.join(" · ") : null
}

/** Mirrors the server: the creator or an owner or admin changes a dashboard and its panels. */
export function canEditDashboard(
  dashboard: Pick<Dashboard, "createdBy">,
  userId: string | undefined,
  role: WorkspaceRole | null,
): boolean {
  return role === "owner" || role === "admin" || (userId !== undefined && dashboard.createdBy?.id === userId)
}

/** The ids with the one at `index` moved one place earlier (-1) or later (1); null when it cannot move. */
export function movedIds(ids: string[], index: number, offset: -1 | 1): string[] | null {
  const target = index + offset
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return null
  const next = [...ids]
  ;[next[index], next[target]] = [next[target] as string, next[index] as string]
  return next
}
