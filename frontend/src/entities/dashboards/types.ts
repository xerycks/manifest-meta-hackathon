// Mirrors backend/src/dashboards/schemas.ts; change both together.

import type { ConnectionEngine } from "../connections/types.ts"
import type { Author } from "../manifests/types.ts"
import type { QueryResult } from "../queries/types.ts"

/** Bounds the backend enforces. */
export const DASHBOARD_LIMITS = {
  nameChars: 200,
  descriptionChars: 5_000,
  perWorkspace: 200,
  panelsPerDashboard: 30,
  titleChars: 200,
  markdownChars: 4_000,
  tableColumns: 50,
  maxDecimals: 10,
  tableRows: 100,
  seriesColumns: 5,
  chartRows: 1_000,
  tickerRows: 50,
  gaugeThresholds: 4,
  gaugeBound: 1e15,
} as const

export type PanelKind = "number" | "table" | "markdown" | "bar" | "line" | "gauge" | "ticker" | "sankey"
export type NumberFormat = "number" | "currency" | "percent"
export type Visibility = "workspace" | "private"

/** The dashboard grid: 12 columns, panels at most 12 rows tall, starting no lower than row 500. */
export const GRID = { columns: 12, maxHeight: 12, maxRow: 500 } as const

/** Each kind's smallest box, and the box a new panel gets. */
export const PANEL_SIZES: Record<
  PanelKind,
  { min: { w: number; h: number }; default: { w: number; h: number } }
> = {
  number: { min: { w: 2, h: 2 }, default: { w: 3, h: 2 } },
  table: { min: { w: 4, h: 3 }, default: { w: 12, h: 4 } },
  markdown: { min: { w: 2, h: 1 }, default: { w: 4, h: 2 } },
  bar: { min: { w: 3, h: 3 }, default: { w: 6, h: 4 } },
  line: { min: { w: 3, h: 3 }, default: { w: 6, h: 4 } },
  gauge: { min: { w: 2, h: 2 }, default: { w: 3, h: 3 } },
  ticker: { min: { w: 3, h: 2 }, default: { w: 12, h: 2 } },
  sankey: { min: { w: 4, h: 3 }, default: { w: 6, h: 5 } },
}

/** A panel's box on the grid: column, row, width in columns, height in rows. */
export interface PanelBox {
  x: number
  y: number
  w: number
  h: number
}

/** How values are written; decimals null keeps every stored digit. */
export interface ValueFormat {
  format: NumberFormat
  decimals: number | null
  /** ISO 4217, for currency values only. */
  currency: string | null
}

/**
 * One value from the first row; a percent value is a ratio (0.25 shows as
 * 25%), and decimals null shows the value exactly as stored.
 */
export interface NumberConfig extends ValueFormat {
  valueColumn: string
  /** Its difference from the value is shown next to it. */
  comparisonColumn: string | null
}

export interface TableConfig {
  /** The columns to show, in order; null shows them all. */
  columns: string[] | null
}

export interface MarkdownConfig {
  body: string
}

export type SeriesSort = "none" | "x" | "value_desc" | "value_asc"
export type XFormat = "auto" | "text" | "date" | "month" | "datetime"

/** A bar or line chart: one series per y column against one value axis. */
export interface SeriesConfig extends ValueFormat {
  xColumn: string
  yColumns: string[]
  stacked: boolean
  /** Lines keep result order or follow x; bars may also follow the row's total. */
  sort: SeriesSort
  xFormat: XFormat
}

export type ThresholdStatus = "good" | "warning" | "critical"

/** One value from the first row on a scale; it takes the status of the highest threshold it reaches. */
export interface GaugeConfig extends ValueFormat {
  valueColumn: string
  min: number
  max: number
  thresholds: { value: number; status: ThresholdStatus }[]
}

export interface TickerConfig extends ValueFormat {
  labelColumn: string
  valueColumn: string
  deltaColumn: string | null
}

export interface SankeyConfig {
  sourceColumn: string
  targetColumn: string
  valueColumn: string
}

/** A panel's kind with its config. */
export type PanelDefinition =
  | { kind: "number"; config: NumberConfig }
  | { kind: "table"; config: TableConfig }
  | { kind: "markdown"; config: MarkdownConfig }
  | { kind: "bar"; config: SeriesConfig }
  | { kind: "line"; config: SeriesConfig }
  | { kind: "gauge"; config: GaugeConfig }
  | { kind: "ticker"; config: TickerConfig }
  | { kind: "sankey"; config: SankeyConfig }

export interface Dashboard {
  id: string
  name: string
  /** Markdown. */
  description: string
  visibility: Visibility
  version: number
  /** Increases with every layout save. */
  layoutVersion: number
  createdBy: Author | null
  updatedBy: Author | null
  createdAt: string
  /** Also moves when panels change. */
  updatedAt: string
}

export interface DashboardSummary extends Omit<Dashboard, "description"> {
  excerpt: string
  panelCount: number
}

export interface DashboardList {
  dashboards: DashboardSummary[]
}

export interface PanelSavedQuery {
  id: string
  name: string
  source: { id: string; name: string; engine: ConnectionEngine }
  visibility: Visibility
  lastRunAt: string | null
  /** A required parameter has no default, so running it needs values from its own page. */
  needsValues: boolean
}

/** A saved query's latest succeeded run, cut to the columns and rows the panel shows. */
export interface PanelRun {
  executionId: string
  connectionId: string
  createdAt: string
  finishedAt: string | null
  parameters: Record<string, string | null> | null
  result: QueryResult
  partialResult: boolean
}

export type PanelData =
  | { state: "removed" }
  | { state: "private" }
  | { state: "available"; savedQuery: PanelSavedQuery; latestRun: PanelRun | null }

export interface RefreshFailure {
  code: string
  message: string
  at: string
}

/** How current a query panel is; the panel keeps showing its last good result. */
export type PanelStatus =
  | { state: "fresh"; lastSuccessAt: string }
  /** since is null while it waits its turn. */
  | { state: "refreshing"; since: string | null; lastSuccessAt: string | null }
  | { state: "failed"; failure: RefreshFailure; lastSuccessAt: string | null }
  | { state: "stale"; reason: "cancelled" | "not_run"; lastSuccessAt: string | null }

export type DashboardPanel = PanelDefinition & {
  id: string
  /** "" shows the saved query's name (or nothing, for Markdown). */
  title: string
  savedQueryId: string | null
  layout: PanelBox
  version: number
  createdAt: string
  updatedAt: string
  /** Null for Markdown panels. */
  data: PanelData | null
  /** Null for Markdown panels and panels whose saved query the viewer cannot read. */
  status: PanelStatus | null
}

export interface DashboardDetail extends Dashboard {
  /** Top to bottom, then left to right. */
  panels: DashboardPanel[]
  refresh: { active: boolean; startedAt: string | null }
}

/** A dashboard's refresh, if one is running, with every panel's status. */
export interface DashboardRefresh {
  active: boolean
  startedAt: string | null
  panels: { id: string; status: PanelStatus | null }[]
}

export interface SaveLayoutInput {
  version: number
  boxes: ({ panelId: string } & PanelBox)[]
}

export interface CreateDashboardInput {
  name: string
  description: string
  visibility: Visibility
}

export interface UpdateDashboardInput {
  version: number
  name?: string
  description?: string
  visibility?: Visibility
}

/** A query panel's definition with its saved query, or a Markdown panel's. */
export type PanelInput =
  | ({ title: string } & Extract<PanelDefinition, { kind: "markdown" }>)
  | ({ title: string; savedQueryId: string } & Exclude<PanelDefinition, { kind: "markdown" }>)

export type UpdatePanelInput = { version: number } & Partial<{
  kind: PanelKind
  title: string
  savedQueryId: string
  config: PanelDefinition["config"]
}>
