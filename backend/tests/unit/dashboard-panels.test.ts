import assert from "node:assert/strict"
import test from "node:test"

import { columnProblem, panelResult } from "../../src/dashboards/panels.js"
import { DASHBOARD_LIMITS, panelInputSchema, updatePanelSchema } from "../../src/dashboards/schemas.js"
import { MISSING, type QueryResult, type ResultColumn } from "../../src/queries/schemas.js"

const SAVED_QUERY = "4f1c2b8e-6d3a-4e5f-9a7b-1c2d3e4f5a6b"

const column = (name: string, kind: ResultColumn["kind"]): ResultColumn => ({ name, type: kind, kind })

const columns = [
  column("status", "text"),
  column("orders", "integer"),
  column("revenue", "decimal"),
  column("last_month", "decimal"),
]

function result(rows: QueryResult["rows"], rowCount = rows.length): QueryResult {
  return { columns, rows, rowCount, truncated: false, truncatedBy: null, durationMs: 5 }
}

function issues(input: unknown): string[] {
  const parsed = panelInputSchema.safeParse(input)
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
}

test("panel definitions fill their defaults and keep a currency only for currency values", () => {
  assert.deepEqual(
    panelInputSchema.parse({ kind: "number", savedQueryId: SAVED_QUERY, config: { valueColumn: "revenue" } }),
    {
      kind: "number",
      title: "",
      savedQueryId: SAVED_QUERY,
      config: {
        valueColumn: "revenue",
        comparisonColumn: null,
        format: "number",
        decimals: null,
        currency: null,
      },
    },
  )
  const percent = panelInputSchema.parse({
    kind: "number",
    title: "  Refund rate ",
    savedQueryId: SAVED_QUERY,
    config: { valueColumn: "rate", format: "percent", decimals: 1, currency: "USD" },
  })
  assert.equal(percent.title, "Refund rate")
  assert.deepEqual(percent.config, {
    valueColumn: "rate",
    comparisonColumn: null,
    format: "percent",
    decimals: 1,
    currency: null,
  })
  assert.deepEqual(panelInputSchema.parse({ kind: "table", savedQueryId: SAVED_QUERY }).config, {
    columns: null,
  })
})

test("panel configs are checked per kind: formats, currencies, decimals, columns, and Markdown size", () => {
  const number = (config: Record<string, unknown>) =>
    issues({ kind: "number", savedQueryId: SAVED_QUERY, config: { valueColumn: "revenue", ...config } })
  assert.match(number({ format: "scientific" }).join(), /^config\.format: /)
  assert.deepEqual(number({ format: "currency" }), ["config.currency: Choose the currency"])
  assert.match(
    number({ format: "currency", currency: "usd" }).join(),
    /^config\.currency: Use a three-letter ISO 4217/,
  )
  assert.match(number({ format: "currency", currency: "ABC" }).join(), /^config\.currency: /)
  assert.deepEqual(number({ format: "currency", currency: "EUR", decimals: 2 }), [])
  assert.match(number({ decimals: 11 }).join(), /^config\.decimals: /)
  assert.match(number({ decimals: 1.5 }).join(), /^config\.decimals: /)
  assert.deepEqual(number({ comparisonColumn: "revenue" }), [
    "config.comparisonColumn: Compare the value with a different column",
  ])
  assert.match(number({ unknown: true }).join(), /^config: Unrecognized key/)

  const table = (columnsChosen: unknown) =>
    issues({ kind: "table", savedQueryId: SAVED_QUERY, config: { columns: columnsChosen } })
  assert.deepEqual(table(["revenue", "status"]), [])
  assert.deepEqual(table(["status", "status"]), ["config.columns: Choose each column once"])
  assert.match(table([]).join(), /Choose at least one column/)
  assert.match(table(Array.from({ length: 51 }, (_value, index) => `c${index}`)).join(), /at most 50 columns/)

  const markdown = (body: string) => issues({ kind: "markdown", config: { body } })
  assert.deepEqual(markdown("x".repeat(DASHBOARD_LIMITS.markdownChars)), [])
  assert.deepEqual(markdown("x".repeat(DASHBOARD_LIMITS.markdownChars + 1)), [
    "config.body: The text can be at most 4,000 characters",
  ])
  assert.deepEqual(markdown("  \n "), ["config.body: Write the panel's text"])
  // jsonb holds neither NUL nor an unpaired surrogate; a paired one (an emoji) is fine.
  assert.match(markdown("a\u0000b").join(), /^config\.body: The text cannot contain NUL/)
  assert.match(markdown("half \ud800 pair").join(), /^config\.body: /)
  assert.deepEqual(markdown("Revenue \u{1F4C8}"), [])
  assert.match(table(["ok", "lone \udc00"]).join(), /^config\.columns\.1: /)
  assert.match(
    issues({ kind: "markdown", savedQueryId: SAVED_QUERY, config: { body: "Notes" } }).join(),
    /Unrecognized key/,
  )
  assert.match(
    issues({ kind: "number", config: { valueColumn: "revenue" } }).join(),
    /^savedQueryId: Choose a saved query/,
  )
  assert.match(issues({ kind: "chart", savedQueryId: SAVED_QUERY, config: {} }).join(), /^kind: /)
  assert.equal(updatePanelSchema.safeParse({ version: 1 }).success, false)
})

test("config columns must be in the latest result, and a number panel's must hold numbers", () => {
  const number = panelInputSchema.parse({
    kind: "number",
    savedQueryId: SAVED_QUERY,
    config: { valueColumn: "revenue", comparisonColumn: "last_month" },
  })
  assert.equal(columnProblem(number, columns), null)
  const unknown = panelInputSchema.parse({
    kind: "number",
    savedQueryId: SAVED_QUERY,
    config: { valueColumn: "revenue", comparisonColumn: "revenu" },
  })
  assert.deepEqual(columnProblem(unknown, columns), {
    field: "config.comparisonColumn",
    column: "revenu",
    message:
      "The latest result has no column “revenu”. Its columns are: status, orders, revenue, last_month.",
  })
  const text = panelInputSchema.parse({
    kind: "number",
    savedQueryId: SAVED_QUERY,
    config: { valueColumn: "status" },
  })
  assert.equal(
    columnProblem(text, columns)?.message,
    "“status” holds text values; a number panel needs a column of numbers.",
  )
  // Mixed MongoDB fields are checked when shown.
  assert.equal(columnProblem(text, [column("status", "unknown")]), null)

  const table = panelInputSchema.parse({
    kind: "table",
    savedQueryId: SAVED_QUERY,
    config: { columns: ["revenue", "Status"] },
  })
  assert.equal(columnProblem(table, columns)?.field, "config.columns.1")
  assert.equal(columnProblem(panelInputSchema.parse({ kind: "markdown", config: { body: "Hi" } }), []), null)
})

test("panels carry only the columns and rows they show", () => {
  const rows = [
    ["delivered", 120, "18250.40", "17000.00"],
    ["refunded", 7, "-310.25", null],
    ["shipped", 30, "4100.00", MISSING],
  ]
  const number = panelInputSchema.parse({
    kind: "number",
    savedQueryId: SAVED_QUERY,
    config: { valueColumn: "revenue", comparisonColumn: "last_month" },
  })
  const shown = panelResult(number, result(rows, 40))
  assert.deepEqual(shown.result.columns, [columns[2], columns[3]])
  assert.deepEqual(shown.result.rows, [["18250.40", "17000.00"]])
  assert.equal(shown.result.rowCount, 40)
  assert.equal(shown.partialResult, true)

  const chosen = panelInputSchema.parse({
    kind: "table",
    savedQueryId: SAVED_QUERY,
    config: { columns: ["revenue", "status", "gone"] },
  })
  assert.deepEqual(panelResult(chosen, result(rows)).result.rows, [
    ["18250.40", "delivered"],
    ["-310.25", "refunded"],
    ["4100.00", "shipped"],
  ])
  assert.equal(panelResult(chosen, result(rows)).partialResult, false)

  const all = panelInputSchema.parse({ kind: "table", savedQueryId: SAVED_QUERY })
  assert.deepEqual(panelResult(all, result(rows)).result, result(rows))

  // At most 100 rows, and no more than the per-panel byte budget.
  const many = Array.from({ length: 150 }, (_value, index) => ["x", index, "1.00", "1.00"])
  assert.equal(panelResult(all, result(many)).result.rows.length, DASHBOARD_LIMITS.tableRows)
  const wide = Array.from({ length: 10 }, () => ["y".repeat(40_000), 1, "1", "1"])
  const cut = panelResult(all, result(wide))
  assert.equal(cut.result.rows.length, 3)
  assert.equal(cut.partialResult, true)
})
