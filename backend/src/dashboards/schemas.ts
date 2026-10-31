import { z } from "zod"

import type { Author } from "../auth/repository.js"
import type { Engine } from "../connections/schemas.js"
import type { QueryResult } from "../queries/schemas.js"
import { GRID } from "./layout.js"

export const DASHBOARD_LIMITS = {
  nameChars: 200,
  descriptionChars: 5_000,
  perWorkspace: 200,
  panelsPerDashboard: 30,
  titleChars: 200,
  markdownChars: 4_000,
  columnChars: 300,
  tableColumns: 50,
  maxDecimals: 10,
  /** Rows of its latest result a table panel carries in the dashboard response. */
  tableRows: 100,
  /** Those rows as JSON, per panel, so a dashboard response stays a few megabytes at most. */
  panelBytes: 128 * 1024,
  /** Columns of values a bar or line chart plots. */
  seriesColumns: 5,
  /** Rows a bar, line, or Sankey chart carries (a stored result keeps at most 1,000). */
  chartRows: 1_000,
  /** Those rows as JSON, per chart panel. */
  chartBytes: 256 * 1024,
  /** Items a ticker shows. */
  tickerRows: 50,
  gaugeThresholds: 4,
  /** The largest magnitude a gauge's bounds and thresholds may have. */
  gaugeBound: 1e15,
} as const

export const PANEL_KINDS = [
  "number",
  "table",
  "markdown",
  "bar",
  "line",
  "gauge",
  "ticker",
  "sankey",
] as const

export type PanelKind = (typeof PANEL_KINDS)[number]

/** Kinds that draw a chart from a saved query's result. */
export const CHART_KINDS = [
  "bar",
  "line",
  "gauge",
  "ticker",
  "sankey",
] as const satisfies readonly PanelKind[]

export const NUMBER_FORMATS = ["number", "currency", "percent"] as const

export type NumberFormat = (typeof NUMBER_FORMATS)[number]

// Stored as text or jsonb, which cannot hold NUL characters.
const noNul = (text: string) => !text.includes("\u0000")
// jsonb also refuses unpaired UTF-16 surrogates, which JSON can still carry as \ud800.
const jsonSafe = (text: string) => !/[\u0000\p{Cs}]/u.test(text)

const columnSchema = z
  .string()
  .min(1, "Choose a column")
  .max(DASHBOARD_LIMITS.columnChars)
  .refine(jsonSafe, "A column name cannot contain NUL or unpaired surrogate characters")

const CURRENCIES = new Set(Intl.supportedValuesOf("currency"))

const decimalsSchema = z.number().int().min(0).max(DASHBOARD_LIMITS.maxDecimals).nullable().default(null)
const currencySchema = z
  .string()
  .refine((code) => CURRENCIES.has(code), "Use a three-letter ISO 4217 currency code, such as USD or EUR")
  .nullable()
  .default(null)

/**
 * How values are written: a percent value is a ratio (0.25 shows as 25%),
 * decimals null keeps a value exactly as stored, and a currency is needed
 * (and kept) only for currency values.
 */
const valueFormatShape = {
  format: z.enum(NUMBER_FORMATS).default("number"),
  decimals: decimalsSchema,
  currency: currencySchema,
}

interface ValueFormat {
  format: NumberFormat
  currency: string | null
}

function checkCurrency(config: ValueFormat, context: z.RefinementCtx): void {
  if (config.format === "currency" && config.currency === null) {
    context.addIssue({ code: "custom", path: ["currency"], message: "Choose the currency" })
  }
}

const keepCurrency = <T extends ValueFormat>(config: T): T => ({
  ...config,
  currency: config.format === "currency" ? config.currency : null,
})

/** Adds an issue at `path` when `column` repeats one of `others`. */
function distinctColumn(
  context: z.RefinementCtx,
  path: string,
  column: string | null,
  others: (string | null)[],
  message: string,
): void {
  if (column !== null && others.includes(column)) context.addIssue({ code: "custom", path: [path], message })
}

/**
 * A number panel shows one value from the first row of the result, with an
 * optional comparison column whose difference it shows next to it.
 */
export const numberConfigSchema = z
  .strictObject({
    valueColumn: columnSchema,
    comparisonColumn: columnSchema.nullable().default(null),
    ...valueFormatShape,
  })
  .superRefine((config, context) => {
    checkCurrency(config, context)
    distinctColumn(
      context,
      "comparisonColumn",
      config.comparisonColumn,
      [config.valueColumn],
      "Compare the value with a different column",
    )
  })
  .transform(keepCurrency)

export type NumberConfig = z.infer<typeof numberConfigSchema>

/** A table panel shows the result's columns, or the chosen ones in the chosen order. */
export const tableConfigSchema = z.strictObject({
  columns: z
    .array(columnSchema)
    .min(1, "Choose at least one column, or show them all")
    .max(DASHBOARD_LIMITS.tableColumns, `Choose at most ${DASHBOARD_LIMITS.tableColumns} columns`)
    .refine((columns) => new Set(columns).size === columns.length, "Choose each column once")
    .nullable()
    .default(null),
})

export type TableConfig = z.infer<typeof tableConfigSchema>

export const markdownConfigSchema = z.strictObject({
  body: z
    .string()
    .max(
      DASHBOARD_LIMITS.markdownChars,
      `The text can be at most ${DASHBOARD_LIMITS.markdownChars.toLocaleString("en-US")} characters`,
    )
    .refine(jsonSafe, "The text cannot contain NUL or unpaired surrogate characters")
    .refine((body) => body.trim() !== "", "Write the panel's text"),
})

export type MarkdownConfig = z.infer<typeof markdownConfigSchema>

/** Result order, by the x column, or by the row's total value. */
export const SERIES_SORTS = ["none", "x", "value_desc", "value_asc"] as const

export type SeriesSort = (typeof SERIES_SORTS)[number]

/** How the x axis writes its values; auto follows the column's kind. */
export const X_FORMATS = ["auto", "text", "date", "month", "datetime"] as const

export type XFormat = (typeof X_FORMATS)[number]

const seriesShape = {
  /** Categories (bar) or positions along the axis (line), one per row. */
  xColumn: columnSchema,
  /** One series per column, plotted against one value axis. */
  yColumns: z
    .array(columnSchema)
    .min(1, "Choose at least one column of values")
    .max(DASHBOARD_LIMITS.seriesColumns, `Choose at most ${DASHBOARD_LIMITS.seriesColumns} columns of values`)
    .refine((columns) => new Set(columns).size === columns.length, "Choose each column once"),
  stacked: z.boolean().default(false),
  sort: z.enum(SERIES_SORTS).default("none"),
  xFormat: z.enum(X_FORMATS).default("auto"),
  ...valueFormatShape,
}

function checkSeries(
  config: { xColumn: string; yColumns: string[] } & ValueFormat,
  context: z.RefinementCtx,
): void {
  checkCurrency(config, context)
  if (config.yColumns.includes(config.xColumn)) {
    context.addIssue({ code: "custom", path: ["yColumns"], message: "Plot columns other than the x column" })
  }
}

/** A bar chart: one bar per row (stacked or side by side per series); value sorts use the row's total. */
export const barConfigSchema = z.strictObject(seriesShape).superRefine(checkSeries).transform(keepCurrency)

export type BarConfig = z.infer<typeof barConfigSchema>

/** A line chart: one line per series along the x column; stacked lines show running totals as areas. */
export const lineConfigSchema = z
  .strictObject(seriesShape)
  .superRefine((config, context) => {
    checkSeries(config, context)
    if (config.sort !== "none" && config.sort !== "x") {
      context.addIssue({
        code: "custom",
        path: ["sort"],
        message: "Keep a line in result order or order it by the x column",
      })
    }
  })
  .transform(keepCurrency)

export type LineConfig = z.infer<typeof lineConfigSchema>

export const THRESHOLD_STATUSES = ["good", "warning", "critical"] as const

export type ThresholdStatus = (typeof THRESHOLD_STATUSES)[number]

const boundSchema = z
  .number()
  .min(-DASHBOARD_LIMITS.gaugeBound, "Use a smaller number")
  .max(DASHBOARD_LIMITS.gaugeBound, "Use a smaller number")

/**
 * A gauge shows one value from the first row on a scale from min to max. A
 * threshold marks where a status starts: the value shows the status of the
 * highest threshold it reaches.
 */
export const gaugeConfigSchema = z
  .strictObject({
    valueColumn: columnSchema,
    min: boundSchema.default(0),
    max: boundSchema,
    thresholds: z
      .array(z.strictObject({ value: boundSchema, status: z.enum(THRESHOLD_STATUSES) }))
      .max(
        DASHBOARD_LIMITS.gaugeThresholds,
        `A gauge can have at most ${DASHBOARD_LIMITS.gaugeThresholds} thresholds`,
      )
      .default([]),
    ...valueFormatShape,
  })
  .superRefine((config, context) => {
    checkCurrency(config, context)
    if (config.max <= config.min) {
      context.addIssue({ code: "custom", path: ["max"], message: "The maximum must be above the minimum" })
    }
    config.thresholds.forEach((threshold, index) => {
      const previous = config.thresholds[index - 1]
      if (threshold.value < config.min || threshold.value > config.max) {
        context.addIssue({
          code: "custom",
          path: ["thresholds", index, "value"],
          message: "A threshold must lie between the minimum and the maximum",
        })
      } else if (previous && threshold.value <= previous.value) {
        context.addIssue({
          code: "custom",
          path: ["thresholds", index, "value"],
          message: "List thresholds from the lowest to the highest, each once",
        })
      }
    })
  })
  .transform(keepCurrency)

export type GaugeConfig = z.infer<typeof gaugeConfigSchema>

/** A ticker: a compact row of label and value items, one per row, with an optional change beside each. */
export const tickerConfigSchema = z
  .strictObject({
    labelColumn: columnSchema,
    valueColumn: columnSchema,
    deltaColumn: columnSchema.nullable().default(null),
    ...valueFormatShape,
  })
  .superRefine((config, context) => {
    checkCurrency(config, context)
    distinctColumn(
      context,
      "valueColumn",
      config.valueColumn,
      [config.labelColumn],
      "Use a different column for the labels",
    )
    distinctColumn(
      context,
      "deltaColumn",
      config.deltaColumn,
      [config.labelColumn, config.valueColumn],
      "Use a different column for the change",
    )
  })
  .transform(keepCurrency)

export type TickerConfig = z.infer<typeof tickerConfigSchema>

/** A Sankey diagram: flows from source to target, as wide as the sum of their values. */
export const sankeyConfigSchema = z
  .strictObject({
    sourceColumn: columnSchema,
    targetColumn: columnSchema,
    valueColumn: columnSchema,
  })
  .superRefine((config, context) => {
    distinctColumn(
      context,
      "targetColumn",
      config.targetColumn,
      [config.sourceColumn],
      "Use a different column for the targets",
    )
    distinctColumn(
      context,
      "valueColumn",
      config.valueColumn,
      [config.sourceColumn, config.targetColumn],
      "Use a different column for the values",
    )
  })

export type SankeyConfig = z.infer<typeof sankeyConfigSchema>

const titleSchema = z
  .string()
  .trim()
  .max(DASHBOARD_LIMITS.titleChars, `A title can be at most ${DASHBOARD_LIMITS.titleChars} characters`)
  .refine(noNul, "A title cannot contain NUL characters")
  .default("")
const savedQueryIdSchema = z.uuid("Choose a saved query")

/**
 * A panel's definition, by kind. Kinds that show a query result name a saved
 * query; an empty title shows the saved query's name instead.
 */
export const panelInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("number"),
    title: titleSchema,
    savedQueryId: savedQueryIdSchema,
    config: numberConfigSchema,
  }),
  z.strictObject({
    kind: z.literal("table"),
    title: titleSchema,
    savedQueryId: savedQueryIdSchema,
    config: tableConfigSchema.default({ columns: null }),
  }),
  z.strictObject({
    kind: z.literal("markdown"),
    title: titleSchema,
    config: markdownConfigSchema,
  }),
  z.strictObject({
    kind: z.literal("bar"),
    title: titleSchema,
    savedQueryId: savedQueryIdSchema,
    config: barConfigSchema,
  }),
  z.strictObject({
    kind: z.literal("line"),
    title: titleSchema,
    savedQueryId: savedQueryIdSchema,
    config: lineConfigSchema,
  }),
  z.strictObject({
    kind: z.literal("gauge"),
    title: titleSchema,
    savedQueryId: savedQueryIdSchema,
    config: gaugeConfigSchema,
  }),
  z.strictObject({
    kind: z.literal("ticker"),
    title: titleSchema,
    savedQueryId: savedQueryIdSchema,
    config: tickerConfigSchema,
  }),
  z.strictObject({
    kind: z.literal("sankey"),
    title: titleSchema,
    savedQueryId: savedQueryIdSchema,
    config: sankeyConfigSchema,
  }),
])

export type PanelInput = z.infer<typeof panelInputSchema>
export type PanelConfig = PanelInput["config"]

/** A panel's kind with its config, kept together so each kind's config type follows from its kind. */
export type PanelDefinition =
  | { kind: "number"; config: NumberConfig }
  | { kind: "table"; config: TableConfig }
  | { kind: "markdown"; config: MarkdownConfig }
  | { kind: "bar"; config: BarConfig }
  | { kind: "line"; config: LineConfig }
  | { kind: "gauge"; config: GaugeConfig }
  | { kind: "ticker"; config: TickerConfig }
  | { kind: "sankey"; config: SankeyConfig }

/** Changes to a panel; the result is checked again as a whole definition of its (new) kind. */
export const updatePanelSchema = z
  .strictObject({
    version: z.number().int().min(1).max(2_147_483_647),
    title: z.string().max(1_000).optional(),
    kind: z.enum(PANEL_KINDS).optional(),
    savedQueryId: z.uuid("Choose a saved query").optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.kind !== undefined ||
      input.savedQueryId !== undefined ||
      input.config !== undefined,
    "Change at least one field",
  )

export type UpdatePanelInput = z.infer<typeof updatePanelSchema>

/** A panel's box on the dashboard grid: column, row, width in columns, height in rows. */
export interface PanelBox {
  x: number
  y: number
  w: number
  h: number
}

const gridInt = (min: number, max: number) => z.number().int().min(min).max(max)

/** Every panel's box at once; the boxes must fit the grid and the panels' kinds, and not overlap. */
export const saveLayoutSchema = z.strictObject({
  /** The dashboard's layoutVersion this layout is based on. */
  version: z.number().int().min(1).max(2_147_483_647),
  boxes: z
    .array(
      z.strictObject({
        panelId: z.uuid(),
        x: gridInt(0, GRID.columns - 1),
        y: gridInt(0, GRID.maxRow),
        w: gridInt(1, GRID.columns),
        h: gridInt(1, GRID.maxHeight),
      }),
    )
    .max(DASHBOARD_LIMITS.panelsPerDashboard)
    .refine(
      (boxes) => new Set(boxes.map((box) => box.panelId)).size === boxes.length,
      "List each panel once",
    ),
})

export type SaveLayoutInput = z.infer<typeof saveLayoutSchema>

/** Refreshes every panel, or only the listed ones. */
export const refreshSchema = z.strictObject({
  panelIds: z
    .array(z.uuid())
    .min(1)
    .max(DASHBOARD_LIMITS.panelsPerDashboard)
    .refine((ids) => new Set(ids).size === ids.length, "List each panel once")
    .optional(),
})

export type RefreshInput = z.infer<typeof refreshSchema>

const nameSchema = z
  .string()
  .trim()
  .min(1, "Give the dashboard a name")
  .max(DASHBOARD_LIMITS.nameChars, `A name can be at most ${DASHBOARD_LIMITS.nameChars} characters`)
  .refine(noNul, "A name cannot contain NUL characters")
const descriptionSchema = z
  .string()
  .max(
    DASHBOARD_LIMITS.descriptionChars,
    `The description can be at most ${DASHBOARD_LIMITS.descriptionChars.toLocaleString("en-US")} characters`,
  )
  .refine(noNul, "The description cannot contain NUL characters")
  .transform((value) => value.trimEnd())
const visibilitySchema = z.enum(["workspace", "private"])

export type Visibility = z.infer<typeof visibilitySchema>

export const createDashboardSchema = z.strictObject({
  name: nameSchema,
  description: descriptionSchema.default(""),
  visibility: visibilitySchema.default("workspace"),
})

export type CreateDashboardInput = z.infer<typeof createDashboardSchema>

export const updateDashboardSchema = z
  .strictObject({
    version: z.number().int().min(1).max(2_147_483_647),
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    visibility: visibilitySchema.optional(),
  })
  .refine(
    (input) => input.name !== undefined || input.description !== undefined || input.visibility !== undefined,
    "Change at least one field",
  )

export type UpdateDashboardInput = z.infer<typeof updateDashboardSchema>

export const workspaceParamsSchema = z.object({ workspaceId: z.uuid() })
export const dashboardParamsSchema = workspaceParamsSchema.extend({ dashboardId: z.uuid() })
export const panelParamsSchema = dashboardParamsSchema.extend({ panelId: z.uuid() })

// Responses --------------------------------------------------------------------

export interface Dashboard {
  id: string
  name: string
  /** Markdown. */
  description: string
  visibility: Visibility
  /** Increases with every edit of the name, description, or visibility. */
  version: number
  /** Increases with every layout save, and when a panel grows to fit a new kind. */
  layoutVersion: number
  createdBy: Author | null
  updatedBy: Author | null
  createdAt: string
  /** Also moves when panels are added, changed, moved, resized, or removed. */
  updatedAt: string
}

export interface DashboardSummary extends Omit<Dashboard, "description"> {
  /** The start of the description as plain text. */
  excerpt: string
  panelCount: number
}

export interface DashboardList {
  /** Every dashboard the viewer may see (a workspace has at most 200), recently updated first. */
  dashboards: DashboardSummary[]
}

/** The saved query a panel shows, as far as the viewer may see it. */
export interface PanelSavedQuery {
  id: string
  name: string
  source: { id: string; name: string; engine: Engine }
  visibility: Visibility
  lastRunAt: string | null
  /** A required parameter has no default, so running it needs values from its own page. */
  needsValues: boolean
}

/** A saved query's latest succeeded run, cut to what the panel shows. */
export interface PanelRun {
  executionId: string
  connectionId: string
  /** When it ran. */
  createdAt: string
  finishedAt: string | null
  /** Its parameter values as they resolved, by name. */
  parameters: Record<string, string | null> | null
  /**
   * Only the columns the panel shows, and the rows it shows: the first for a
   * number or gauge, up to 100 for a table, 50 for a ticker, 1,000 for a chart.
   */
  result: QueryResult
  /** The result holds fewer rows than the query returned. */
  partialResult: boolean
}

export type PanelData =
  /** The saved query was deleted (or its source removed). */
  | { state: "removed" }
  /** The saved query is private to someone else. */
  | { state: "private" }
  /** latestRun is null until the saved query has a succeeded run. */
  | { state: "available"; savedQuery: PanelSavedQuery; latestRun: PanelRun | null }

/** A run that did not succeed, as the viewer may read it. */
export interface RefreshFailure {
  code: string
  /** Safe to show: written by Manifest, never a raw driver error. */
  message: string
  at: string
}

/**
 * How current a query panel is, from its saved query's latest run: fresh
 * when that run succeeded, refreshing while one runs or waits for a slot,
 * failed when it did not succeed, and stale when it was cancelled or the
 * saved query has never run. The panel keeps showing the last good result.
 */
export type PanelStatus =
  | { state: "fresh"; lastSuccessAt: string }
  /** since is null while it waits its turn in a refresh. */
  | { state: "refreshing"; since: string | null; lastSuccessAt: string | null }
  | { state: "failed"; failure: RefreshFailure; lastSuccessAt: string | null }
  | { state: "stale"; reason: "cancelled" | "not_run"; lastSuccessAt: string | null }

export type DashboardPanel = PanelDefinition & {
  id: string
  /** "" shows the saved query's name (or nothing, for Markdown). */
  title: string
  /** Null for Markdown panels, once the saved query is deleted, and while it is private to someone else. */
  savedQueryId: string | null
  layout: PanelBox
  version: number
  createdAt: string
  updatedAt: string
  /** What a query panel shows; null for Markdown panels. */
  data: PanelData | null
  /** Null for Markdown panels and panels whose saved query the viewer cannot read. */
  status: PanelStatus | null
}

/** The dashboard's refresh, if one is running, with every panel's status. */
export interface DashboardRefresh {
  active: boolean
  startedAt: string | null
  panels: { id: string; status: PanelStatus | null }[]
}

export interface DashboardDetail extends Dashboard {
  /** In dashboard order: top to bottom, then left to right. */
  panels: DashboardPanel[]
  refresh: { active: boolean; startedAt: string | null }
}
