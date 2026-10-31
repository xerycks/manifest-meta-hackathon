import { columnProblem, holdsNumbers } from "../../entities/dashboards/panel-config.ts"
import {
  DASHBOARD_LIMITS,
  type Dashboard,
  type DashboardPanel,
  type NumberFormat,
  type PanelDefinition,
  type PanelInput,
  type PanelKind,
  type SeriesSort,
  type ThresholdStatus,
  type UpdatePanelInput,
  type ValueFormat,
  type XFormat,
} from "../../entities/dashboards/types.ts"
import type { ResultColumn } from "../../entities/queries/types.ts"
import type { SavedQuery } from "../../entities/saved-queries/types.ts"

/** Every setting the panel dialog edits, whatever the kind, so switching kinds keeps what was typed. */
export interface PanelDraft {
  kind: PanelKind
  title: string
  savedQueryId: string
  /** The value of a number, gauge, ticker item, or Sankey flow. */
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
  xColumn: string
  yColumns: string[]
  stacked: boolean
  sort: SeriesSort
  xFormat: XFormat
  /** A gauge's scale and thresholds, as typed. */
  min: string
  max: string
  thresholds: { value: string; status: ThresholdStatus }[]
  labelColumn: string
  /** "" for no change column. */
  deltaColumn: string
  sourceColumn: string
  targetColumn: string
}

export type PanelField =
  | "savedQueryId"
  | "title"
  | "valueColumn"
  | "comparisonColumn"
  | "currency"
  | "columns"
  | "body"
  | "xColumn"
  | "yColumns"
  | "sort"
  | "min"
  | "max"
  | "thresholds"
  | "labelColumn"
  | "deltaColumn"
  | "sourceColumn"
  | "targetColumn"

export type PanelErrors = Partial<Record<PanelField, string>>

/** Every decimal-places choice the server accepts, "0" to "10". */
export const DECIMAL_CHOICES = Array.from({ length: DASHBOARD_LIMITS.maxDecimals + 1 }, (_value, index) =>
  String(index),
)

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
    xColumn: "",
    yColumns: [],
    stacked: false,
    sort: "none",
    xFormat: "auto",
    min: "0",
    max: "100",
    thresholds: [],
    labelColumn: "",
    deltaColumn: "",
    sourceColumn: "",
    targetColumn: "",
  }
}

function formatDraft(config: ValueFormat): Pick<PanelDraft, "format" | "decimals" | "currency"> {
  return {
    format: config.format,
    decimals: config.decimals === null ? "" : String(config.decimals),
    currency: config.currency ?? "USD",
  }
}

export function draftFromPanel(panel: DashboardPanel): PanelDraft {
  const draft = { ...newPanelDraft(panel.savedQueryId ?? ""), kind: panel.kind, title: panel.title }
  switch (panel.kind) {
    case "number": {
      const { valueColumn, comparisonColumn } = panel.config
      return { ...draft, ...formatDraft(panel.config), valueColumn, comparisonColumn: comparisonColumn ?? "" }
    }
    case "table":
      return { ...draft, columns: panel.config.columns }
    case "markdown":
      return { ...draft, body: panel.config.body }
    case "bar":
    case "line": {
      const { xColumn, yColumns, stacked, sort, xFormat } = panel.config
      return { ...draft, ...formatDraft(panel.config), xColumn, yColumns, stacked, sort, xFormat }
    }
    case "gauge": {
      const { valueColumn, min, max, thresholds } = panel.config
      return {
        ...draft,
        ...formatDraft(panel.config),
        valueColumn,
        min: String(min),
        max: String(max),
        thresholds: thresholds.map((threshold) => ({
          value: String(threshold.value),
          status: threshold.status,
        })),
      }
    }
    case "ticker": {
      const { labelColumn, valueColumn, deltaColumn } = panel.config
      return {
        ...draft,
        ...formatDraft(panel.config),
        labelColumn,
        valueColumn,
        deltaColumn: deltaColumn ?? "",
      }
    }
    case "sankey": {
      const { sourceColumn, targetColumn, valueColumn } = panel.config
      return { ...draft, sourceColumn, targetColumn, valueColumn }
    }
  }
}

/**
 * Columns to start a new kind from, chosen from the latest result's columns
 * for the settings the draft has not filled yet: a date or text column for x
 * and labels, numbers for values.
 */
export function suggestedColumns(
  kind: PanelKind,
  draft: PanelDraft,
  columns: ResultColumn[],
): Partial<PanelDraft> {
  const names = [...new Set(columns.map((column) => column.name))]
  const numbers = names.filter((name) =>
    holdsNumbers(columns.find((column) => column.name === name) as ResultColumn),
  )
  const labels = names.filter((name) => !numbers.includes(name))
  const dated = columns.find((column) => column.kind === "date" || column.kind === "datetime")?.name
  const value = draft.valueColumn || numbers[0] || ""
  switch (kind) {
    case "number":
    case "gauge":
      return { valueColumn: value }
    case "bar":
    case "line": {
      const xColumn = draft.xColumn || (kind === "line" ? dated : undefined) || labels[0] || names[0] || ""
      const yColumns =
        draft.yColumns.length > 0 ? draft.yColumns : numbers.filter((name) => name !== xColumn).slice(0, 1)
      return { xColumn, yColumns }
    }
    case "ticker":
      return { labelColumn: draft.labelColumn || labels[0] || "", valueColumn: value }
    case "sankey":
      return {
        sourceColumn: draft.sourceColumn || labels[0] || "",
        targetColumn: draft.targetColumn || labels[1] || "",
        valueColumn: value,
      }
    default:
      return {}
  }
}

const decimalsOf = (draft: PanelDraft) => (draft.decimals === "" ? null : Number(draft.decimals))
const currencyOf = (draft: PanelDraft) =>
  draft.format === "currency" ? draft.currency.trim().toUpperCase() : null
/** A typed number, or NaN when it is not one. */
const numberOf = (text: string) => (text.trim() === "" ? Number.NaN : Number(text))

function valueFormat(draft: PanelDraft): ValueFormat {
  return { format: draft.format, decimals: decimalsOf(draft), currency: currencyOf(draft) }
}

/** The panel the draft describes, as far as it goes (for the preview). */
export function draftDefinition(draft: PanelDraft): PanelDefinition {
  switch (draft.kind) {
    case "number":
      return {
        kind: "number",
        config: {
          ...valueFormat(draft),
          valueColumn: draft.valueColumn,
          comparisonColumn: draft.comparisonColumn || null,
        },
      }
    case "table":
      return { kind: "table", config: { columns: draft.columns } }
    case "markdown":
      return { kind: "markdown", config: { body: draft.body } }
    case "bar":
    case "line":
      return {
        kind: draft.kind,
        config: {
          ...valueFormat(draft),
          xColumn: draft.xColumn,
          yColumns: draft.yColumns,
          stacked: draft.stacked,
          // A line keeps result order or follows x.
          sort: draft.kind === "line" && draft.sort !== "x" ? "none" : draft.sort,
          xFormat: draft.xFormat,
        },
      }
    case "gauge":
      return {
        kind: "gauge",
        config: {
          ...valueFormat(draft),
          valueColumn: draft.valueColumn,
          min: numberOf(draft.min),
          max: numberOf(draft.max),
          thresholds: draft.thresholds.map((threshold) => ({
            value: numberOf(threshold.value),
            status: threshold.status,
          })),
        },
      }
    case "ticker":
      return {
        kind: "ticker",
        config: {
          ...valueFormat(draft),
          labelColumn: draft.labelColumn,
          valueColumn: draft.valueColumn,
          deltaColumn: draft.deltaColumn || null,
        },
      }
    case "sankey":
      return {
        kind: "sankey",
        config: {
          sourceColumn: draft.sourceColumn,
          targetColumn: draft.targetColumn,
          valueColumn: draft.valueColumn,
        },
      }
  }
}

const usable = (value: number) => Number.isFinite(value) && Math.abs(value) <= DASHBOARD_LIMITS.gaugeBound

/** Problems with a definition's own settings, before its columns are checked against a result. */
function configErrors(definition: PanelDefinition): PanelErrors {
  const errors: PanelErrors = {}
  const needs = (field: PanelField, value: string | null, message: string) => {
    if (!value) errors[field] = message
  }
  const distinct = (field: PanelField, value: string | null, others: (string | null)[], message: string) => {
    if (value && others.includes(value)) errors[field] ??= message
  }
  if ("format" in definition.config && definition.config.format === "currency") {
    if (!CURRENCY.test(definition.config.currency ?? "")) {
      errors.currency = "Enter a three-letter currency code, such as USD or EUR."
    }
  }
  switch (definition.kind) {
    case "number": {
      const { valueColumn, comparisonColumn } = definition.config
      needs("valueColumn", valueColumn, "Choose the column with the value.")
      distinct(
        "comparisonColumn",
        comparisonColumn,
        [valueColumn],
        "Compare the value with a different column.",
      )
      break
    }
    case "table":
      if (definition.config.columns?.length === 0)
        errors.columns = "Choose at least one column, or show them all."
      break
    case "markdown":
      break
    case "bar":
    case "line": {
      const { xColumn, yColumns } = definition.config
      needs("xColumn", xColumn, "Choose the column for the x axis.")
      if (yColumns.length === 0) errors.yColumns = "Choose at least one column of values."
      else if (yColumns.length > DASHBOARD_LIMITS.seriesColumns) {
        errors.yColumns = `Choose at most ${DASHBOARD_LIMITS.seriesColumns} columns of values.`
      } else if (xColumn && yColumns.includes(xColumn))
        errors.yColumns = "Plot columns other than the x column."
      break
    }
    case "gauge": {
      const { valueColumn, min, max, thresholds } = definition.config
      needs("valueColumn", valueColumn, "Choose the column with the value.")
      if (!usable(min)) errors.min = "Enter the lowest value of the scale."
      if (!usable(max)) errors.max = "Enter the highest value of the scale."
      else if (usable(min) && max <= min) errors.max = "The maximum must be above the minimum."
      thresholds.forEach((threshold, index) => {
        const previous = thresholds[index - 1]
        if (!usable(threshold.value) || threshold.value < min || threshold.value > max) {
          errors.thresholds ??= "Each threshold must be a number between the minimum and the maximum."
        } else if (previous && threshold.value <= previous.value) {
          errors.thresholds ??= "List thresholds from the lowest to the highest, each once."
        }
      })
      break
    }
    case "ticker": {
      const { labelColumn, valueColumn, deltaColumn } = definition.config
      needs("labelColumn", labelColumn, "Choose the column with the labels.")
      needs("valueColumn", valueColumn, "Choose the column with the values.")
      distinct("valueColumn", valueColumn, [labelColumn], "Use a different column for the labels.")
      distinct(
        "deltaColumn",
        deltaColumn,
        [labelColumn, valueColumn],
        "Use a different column for the change.",
      )
      break
    }
    case "sankey": {
      const { sourceColumn, targetColumn, valueColumn } = definition.config
      needs("sourceColumn", sourceColumn, "Choose the column the flows come from.")
      needs("targetColumn", targetColumn, "Choose the column the flows go to.")
      needs("valueColumn", valueColumn, "Choose the column with the flow values.")
      distinct("targetColumn", targetColumn, [sourceColumn], "Use a different column for the targets.")
      distinct(
        "valueColumn",
        valueColumn,
        [sourceColumn, targetColumn],
        "Use a different column for the values.",
      )
      break
    }
  }
  return errors
}

/** Problems with the draft's settings for its kind, before any column check: none means it can be previewed. */
export function settingsErrors(draft: PanelDraft): PanelErrors {
  return configErrors(draftDefinition(draft))
}

/**
 * The panel to save, or a problem per field, mirroring the server's checks:
 * columns are checked against the saved query's latest result when it has one.
 */
export function panelInput(
  draft: PanelDraft,
  columns: ResultColumn[] | null,
): { input: PanelInput } | { errors: PanelErrors } {
  const definition = draftDefinition(draft)
  const errors: PanelErrors = configErrors(definition)
  const title = draft.title.trim()
  if (title.length > DASHBOARD_LIMITS.titleChars) {
    errors.title = `A title can be at most ${DASHBOARD_LIMITS.titleChars} characters.`
  }
  if (definition.kind === "markdown") {
    if (!draft.body.trim()) errors.body = "Write the panel's text."
    else if (draft.body.length > DASHBOARD_LIMITS.markdownChars) {
      errors.body = `The text can be at most ${DASHBOARD_LIMITS.markdownChars.toLocaleString("en-US")} characters.`
    }
    return Object.keys(errors).length > 0 ? { errors } : { input: { ...definition, title } }
  }

  if (!draft.savedQueryId) errors.savedQueryId = "Choose a saved query."
  const problem = columns ? columnProblem(definition, columns) : null
  if (problem) errors[problem.field as PanelField] ??= problem.message
  if (Object.keys(errors).length > 0) return { errors }
  return { input: { ...definition, title, savedQueryId: draft.savedQueryId } }
}

/** The whole definition, so a changed kind arrives with its own config; the server merges nothing stale. */
export function panelPatch(panel: Pick<DashboardPanel, "version">, input: PanelInput): UpdatePanelInput {
  return { version: panel.version, ...input }
}

/** What Duplicate adds: the same definition, titled as a copy. */
export function duplicateInput(panel: DashboardPanel): PanelInput | null {
  const title = panel.title ? `${panel.title} (copy)`.slice(0, DASHBOARD_LIMITS.titleChars) : ""
  if (panel.kind === "markdown") return { kind: "markdown", title, config: panel.config }
  if (!panel.savedQueryId) return null
  const { kind, config } = panel as Exclude<PanelDefinition, { kind: "markdown" }>
  return { kind, config, title, savedQueryId: panel.savedQueryId } as PanelInput
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
