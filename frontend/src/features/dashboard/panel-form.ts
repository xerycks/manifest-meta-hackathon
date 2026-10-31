import { columnProblem, holdsNumbers } from "../../entities/dashboards/panel-config.ts"
import {
  DASHBOARD_LIMITS,
  type Dashboard,
  type DashboardPanel,
  type NumberFormat,
  type PanelDefinition,
  type PanelInput,
  type PanelKind,
  type UpdatePanelInput,
} from "../../entities/dashboards/types.ts"
import type { ResultColumn } from "../../entities/queries/types.ts"
import type { SavedQuery } from "../../entities/saved-queries/types.ts"

/** Every setting the panel dialog edits, whatever the kind, so switching kinds keeps what was typed. */
export interface PanelDraft {
  kind: PanelKind
  title: string
  savedQueryId: string
  valueColumn: string
  /** "" for no comparison. */
  comparisonColumn: string
  format: NumberFormat
  /** "" keeps the value exactly as stored; else "0" to "10". */
  decimals: string
  currency: string
  /** The columns a table shows, in order; null shows them all. */
  columns: string[] | null
  body: string
}

export type PanelField =
  "savedQueryId" | "title" | "valueColumn" | "comparisonColumn" | "currency" | "columns" | "body"

export type PanelErrors = Partial<Record<PanelField, string>>

const CURRENCY = /^[A-Z]{3}$/

export function newPanelDraft(savedQueryId = ""): PanelDraft {
  return {
    kind: "table",
    title: "",
    savedQueryId,
    valueColumn: "",
    comparisonColumn: "",
    format: "number",
    decimals: "",
    currency: "USD",
    columns: null,
    body: "",
  }
}

export function draftFromPanel(panel: DashboardPanel): PanelDraft {
  const draft = { ...newPanelDraft(panel.savedQueryId ?? ""), kind: panel.kind, title: panel.title }
  switch (panel.kind) {
    case "number": {
      const { valueColumn, comparisonColumn, format, decimals, currency } = panel.config
      return {
        ...draft,
        valueColumn,
        comparisonColumn: comparisonColumn ?? "",
        format,
        decimals: decimals === null ? "" : String(decimals),
        currency: currency ?? "USD",
      }
    }
    case "table":
      return { ...draft, columns: panel.config.columns }
    case "markdown":
      return { ...draft, body: panel.config.body }
  }
}

/** The first column of numbers, to start a number panel from. */
export function firstNumberColumn(columns: ResultColumn[]): string {
  return columns.find((column) => holdsNumbers(column))?.name ?? ""
}

/** The panel the draft describes, as far as it goes (for the preview). */
export function draftDefinition(draft: PanelDraft): PanelDefinition {
  switch (draft.kind) {
    case "number":
      return {
        kind: "number",
        config: {
          valueColumn: draft.valueColumn,
          comparisonColumn: draft.comparisonColumn || null,
          format: draft.format,
          decimals: draft.decimals === "" ? null : Number(draft.decimals),
          currency: draft.format === "currency" ? draft.currency.trim().toUpperCase() : null,
        },
      }
    case "table":
      return { kind: "table", config: { columns: draft.columns } }
    case "markdown":
      return { kind: "markdown", config: { body: draft.body } }
  }
}

/**
 * The panel to save, or a problem per field, mirroring the server's checks:
 * columns are checked against the saved query's latest result when it has one.
 */
export function panelInput(
  draft: PanelDraft,
  columns: ResultColumn[] | null,
): { input: PanelInput } | { errors: PanelErrors } {
  const errors: PanelErrors = {}
  const title = draft.title.trim()
  if (title.length > DASHBOARD_LIMITS.titleChars) {
    errors.title = `A title can be at most ${DASHBOARD_LIMITS.titleChars} characters.`
  }
  const definition = draftDefinition(draft)
  if (definition.kind === "markdown") {
    if (!draft.body.trim()) errors.body = "Write the panel's text."
    else if (draft.body.length > DASHBOARD_LIMITS.markdownChars) {
      errors.body = `The text can be at most ${DASHBOARD_LIMITS.markdownChars.toLocaleString("en-US")} characters.`
    }
    return Object.keys(errors).length > 0 ? { errors } : { input: { ...definition, title } }
  }

  if (!draft.savedQueryId) errors.savedQueryId = "Choose a saved query."
  if (definition.kind === "number") {
    const { valueColumn, comparisonColumn, format, currency } = definition.config
    if (!valueColumn) errors.valueColumn = "Choose the column with the value."
    if (comparisonColumn !== null && comparisonColumn === valueColumn) {
      errors.comparisonColumn = "Compare the value with a different column."
    }
    if (format === "currency" && !CURRENCY.test(currency ?? "")) {
      errors.currency = "Enter a three-letter currency code, such as USD or EUR."
    }
  } else if (definition.config.columns?.length === 0) {
    errors.columns = "Choose at least one column, or show them all."
  }
  const problem = columns && !errors.valueColumn ? columnProblem(definition, columns) : null
  if (problem) {
    const field: PanelField =
      definition.kind === "table"
        ? "columns"
        : problem.column === definition.config.valueColumn
          ? "valueColumn"
          : "comparisonColumn"
    errors[field] ??= problem.message
  }
  if (Object.keys(errors).length > 0) return { errors }
  return { input: { ...definition, title, savedQueryId: draft.savedQueryId } }
}

/** The whole definition, so a changed kind arrives with its own config; the server merges nothing stale. */
export function panelPatch(panel: Pick<DashboardPanel, "version">, input: PanelInput): UpdatePanelInput {
  return { version: panel.version, ...input }
}

/** Mirrors the server: a private saved query only goes on a private dashboard. */
export function privateQueryProblem(
  draft: Pick<PanelDraft, "kind">,
  savedQuery: Pick<SavedQuery, "name" | "visibility"> | undefined,
  dashboard: Pick<Dashboard, "visibility"> | undefined,
): string | null {
  if (
    draft.kind === "markdown" ||
    savedQuery?.visibility !== "private" ||
    dashboard?.visibility !== "workspace"
  ) {
    return null
  }
  return `“${savedQuery.name}” is visible only to you, so it can only be shown on a private dashboard. Make it visible to everyone first, or use a private dashboard.`
}
