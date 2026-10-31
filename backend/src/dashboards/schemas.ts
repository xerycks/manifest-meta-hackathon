import { z } from "zod"

import type { Author } from "../auth/repository.js"
import type { Engine } from "../connections/schemas.js"
import type { QueryResult } from "../queries/schemas.js"

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
} as const

export const PANEL_KINDS = ["number", "table", "markdown"] as const

export type PanelKind = (typeof PANEL_KINDS)[number]

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

/**
 * A number panel shows one value from the first row of the result, with an
 * optional comparison column whose difference it shows next to it. A percent
 * value is a ratio (0.25 shows as 25%). decimals null keeps the value exactly
 * as stored.
 */
export const numberConfigSchema = z
  .strictObject({
    valueColumn: columnSchema,
    comparisonColumn: columnSchema.nullable().default(null),
    format: z.enum(NUMBER_FORMATS).default("number"),
    decimals: z.number().int().min(0).max(DASHBOARD_LIMITS.maxDecimals).nullable().default(null),
    currency: z
      .string()
      .refine((code) => CURRENCIES.has(code), "Use a three-letter ISO 4217 currency code, such as USD or EUR")
      .nullable()
      .default(null),
  })
  .superRefine((config, context) => {
    if (config.format === "currency" && config.currency === null) {
      context.addIssue({ code: "custom", path: ["currency"], message: "Choose the currency" })
    }
    if (config.comparisonColumn !== null && config.comparisonColumn === config.valueColumn) {
      context.addIssue({
        code: "custom",
        path: ["comparisonColumn"],
        message: "Compare the value with a different column",
      })
    }
  })
  .transform((config) => ({ ...config, currency: config.format === "currency" ? config.currency : null }))

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
])

export type PanelInput = z.infer<typeof panelInputSchema>
export type PanelConfig = PanelInput["config"]

/** A panel's kind with its config, kept together so each kind's config type follows from its kind. */
export type PanelDefinition =
  | { kind: "number"; config: NumberConfig }
  | { kind: "table"; config: TableConfig }
  | { kind: "markdown"; config: MarkdownConfig }

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

export const reorderPanelsSchema = z.strictObject({
  panelIds: z
    .array(z.uuid())
    .max(DASHBOARD_LIMITS.panelsPerDashboard)
    .refine((ids) => new Set(ids).size === ids.length, "List each panel once"),
})

export type ReorderPanelsInput = z.infer<typeof reorderPanelsSchema>

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
  createdBy: Author | null
  updatedBy: Author | null
  createdAt: string
  /** Also moves when panels are added, changed, reordered, or removed. */
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
  /** Only the columns the panel shows; a number panel gets the first row, a table up to 100 rows. */
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

export type DashboardPanel = PanelDefinition & {
  id: string
  /** "" shows the saved query's name (or nothing, for Markdown). */
  title: string
  /** Null for Markdown panels, once the saved query is deleted, and while it is private to someone else. */
  savedQueryId: string | null
  position: number
  version: number
  createdAt: string
  updatedAt: string
  /** What a query panel shows; null for Markdown panels. */
  data: PanelData | null
}

export interface DashboardDetail extends Dashboard {
  /** In dashboard order. */
  panels: DashboardPanel[]
}
