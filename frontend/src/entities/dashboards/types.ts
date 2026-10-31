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
} as const

export type PanelKind = "number" | "table" | "markdown"
export type NumberFormat = "number" | "currency" | "percent"
export type Visibility = "workspace" | "private"

/**
 * One value from the first row; a percent value is a ratio (0.25 shows as
 * 25%), and decimals null shows the value exactly as stored.
 */
export interface NumberConfig {
  valueColumn: string
  /** Its difference from the value is shown next to it. */
  comparisonColumn: string | null
  format: NumberFormat
  decimals: number | null
  /** ISO 4217, for currency values only. */
  currency: string | null
}

export interface TableConfig {
  /** The columns to show, in order; null shows them all. */
  columns: string[] | null
}

export interface MarkdownConfig {
  body: string
}

/** A panel's kind with its config. */
export type PanelDefinition =
  | { kind: "number"; config: NumberConfig }
  | { kind: "table"; config: TableConfig }
  | { kind: "markdown"; config: MarkdownConfig }

export interface Dashboard {
  id: string
  name: string
  /** Markdown. */
  description: string
  visibility: Visibility
  version: number
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

export type DashboardPanel = PanelDefinition & {
  id: string
  /** "" shows the saved query's name (or nothing, for Markdown). */
  title: string
  savedQueryId: string | null
  position: number
  version: number
  createdAt: string
  updatedAt: string
  /** Null for Markdown panels. */
  data: PanelData | null
}

export interface DashboardDetail extends Dashboard {
  panels: DashboardPanel[]
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

export type PanelInput =
  | { kind: "number"; title: string; savedQueryId: string; config: NumberConfig }
  | { kind: "table"; title: string; savedQueryId: string; config: TableConfig }
  | { kind: "markdown"; title: string; config: MarkdownConfig }

export type UpdatePanelInput = { version: number } & Partial<{
  kind: PanelKind
  title: string
  savedQueryId: string
  config: NumberConfig | TableConfig | MarkdownConfig
}>
