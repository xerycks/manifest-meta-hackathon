import type { WorkspaceRole } from "../../app/organization-role.ts"
import type { Cell, ColumnKind, QueryResult, ResultColumn } from "../queries/types.ts"
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

function namedColumns(panel: PanelDefinition): string[] {
  if (panel.kind === "number") {
    const { valueColumn, comparisonColumn } = panel.config
    return comparisonColumn === null ? [valueColumn] : [valueColumn, comparisonColumn]
  }
  return panel.kind === "table" ? (panel.config.columns ?? []) : []
}

/**
 * Mirrors the server: the first column a panel's config names that does not
 * fit a result's columns (it is not there, or a number panel's column is not
 * numeric) and why, or null when the config fits.
 */
export function columnProblem(
  panel: PanelDefinition,
  columns: ResultColumn[],
): { column: string; message: string } | null {
  const indexes = firstByName(columns)
  for (const name of namedColumns(panel)) {
    const index = indexes.get(name)
    const column = index === undefined ? undefined : columns[index]
    if (!column) return { column: name, message: `The result has no column “${name}”.` }
    if (panel.kind === "number" && !holdsNumbers(column)) {
      return {
        column: name,
        message: `“${name}” holds ${column.kind} values; a number panel needs a column of numbers.`,
      }
    }
  }
  return null
}

/** The part of a result a panel shows, as the server cuts it: its columns, and the first row or 100 rows. */
export function shownResult(panel: PanelDefinition, result: QueryResult): QueryResult {
  const byName = firstByName(result.columns)
  const indexes =
    panel.kind === "table" && panel.config.columns === null
      ? result.columns.map((_column, index) => index)
      : namedColumns(panel).flatMap((name) => byName.get(name) ?? [])
  const maxRows = panel.kind === "number" ? 1 : DASHBOARD_LIMITS.tableRows
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
