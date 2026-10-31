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

test("chart configs are checked per kind and fill their defaults", () => {
  const chart = (kind: string, config: Record<string, unknown>) =>
    issues({ kind, savedQueryId: SAVED_QUERY, config })

  assert.deepEqual(
    panelInputSchema.parse({
      kind: "bar",
      savedQueryId: SAVED_QUERY,
      config: { xColumn: "status", yColumns: ["revenue"], currency: "USD" },
    }).config,
    {
      xColumn: "status",
      yColumns: ["revenue"],
      stacked: false,
      sort: "none",
      xFormat: "auto",
      format: "number",
      decimals: null,
      currency: null,
    },
  )
  const series = { xColumn: "status", yColumns: ["revenue", "last_month"] }
  assert.deepEqual(chart("bar", { ...series, stacked: true, sort: "value_desc", decimals: 2 }), [])
  assert.match(
    chart("bar", { xColumn: "status", yColumns: [] }).join(),
    /^config\.yColumns: Choose at least one/,
  )
  assert.match(
    chart("bar", { xColumn: "status", yColumns: ["a", "b", "c", "d", "e", "f"] }).join(),
    /at most 5 columns of values/,
  )
  assert.deepEqual(chart("bar", { xColumn: "status", yColumns: ["revenue", "revenue"] }), [
    "config.yColumns: Choose each column once",
  ])
  assert.deepEqual(chart("bar", { xColumn: "status", yColumns: ["status"] }), [
    "config.yColumns: Plot columns other than the x column",
  ])
  assert.deepEqual(chart("bar", { ...series, format: "currency" }), ["config.currency: Choose the currency"])
  assert.match(chart("bar", { ...series, xFormat: "week" }).join(), /^config\.xFormat: /)
  assert.deepEqual(chart("line", { ...series, sort: "x", stacked: true }), [])
  assert.deepEqual(chart("line", { ...series, sort: "value_desc" }), [
    "config.sort: Keep a line in result order or order it by the x column",
  ])

  assert.deepEqual(
    panelInputSchema.parse({
      kind: "gauge",
      savedQueryId: SAVED_QUERY,
      config: { valueColumn: "rate", max: 1 },
    }).config,
    { valueColumn: "rate", min: 0, max: 1, thresholds: [], format: "number", decimals: null, currency: null },
  )
  const gauge = (config: Record<string, unknown>) =>
    chart("gauge", { valueColumn: "rate", max: 100, ...config })
  assert.deepEqual(
    gauge({
      thresholds: [
        { value: 50, status: "warning" },
        { value: 80, status: "critical" },
      ],
    }),
    [],
  )
  assert.deepEqual(gauge({ min: 100 }), ["config.max: The maximum must be above the minimum"])
  assert.match(chart("gauge", { valueColumn: "rate" }).join(), /^config\.max: /)
  assert.deepEqual(gauge({ thresholds: [{ value: 120, status: "good" }] }), [
    "config.thresholds.0.value: A threshold must lie between the minimum and the maximum",
  ])
  assert.deepEqual(
    gauge({
      thresholds: [
        { value: 60, status: "good" },
        { value: 60, status: "warning" },
      ],
    }),
    ["config.thresholds.1.value: List thresholds from the lowest to the highest, each once"],
  )
  assert.match(
    gauge({ thresholds: [{ value: 10, status: "fine" }] }).join(),
    /^config\.thresholds\.0\.status: /,
  )
  assert.match(gauge({ max: 1e16 }).join(), /^config\.max: Use a smaller number/)

  const ticker = (config: Record<string, unknown>) =>
    chart("ticker", { labelColumn: "status", valueColumn: "revenue", ...config })
  assert.deepEqual(ticker({ deltaColumn: "last_month", format: "currency", currency: "EUR" }), [])
  assert.deepEqual(ticker({ valueColumn: "status" }), [
    "config.valueColumn: Use a different column for the labels",
  ])
  assert.deepEqual(ticker({ deltaColumn: "revenue" }), [
    "config.deltaColumn: Use a different column for the change",
  ])

  const flows = { sourceColumn: "channel", targetColumn: "status", valueColumn: "orders" }
  assert.deepEqual(chart("sankey", flows), [])
  assert.deepEqual(chart("sankey", { ...flows, targetColumn: "channel" }), [
    "config.targetColumn: Use a different column for the targets",
  ])
  assert.deepEqual(chart("sankey", { ...flows, valueColumn: "status" }), [
    "config.valueColumn: Use a different column for the values",
  ])
  assert.match(chart("sankey", { ...flows, format: "number" }).join(), /^config: Unrecognized key/)
})

test("chart columns must be in the latest result, and the ones carrying values must hold numbers", () => {
  const parse = (kind: string, config: Record<string, unknown>) =>
    panelInputSchema.parse({ kind, savedQueryId: SAVED_QUERY, config })
  assert.equal(
    columnProblem(parse("bar", { xColumn: "status", yColumns: ["revenue", "orders"] }), columns),
    null,
  )
  assert.deepEqual(
    columnProblem(parse("line", { xColumn: "status", yColumns: ["orders", "status2"] }), columns),
    {
      field: "config.yColumns.1",
      column: "status2",
      message:
        "The latest result has no column “status2”. Its columns are: status, orders, revenue, last_month.",
    },
  )
  assert.equal(
    columnProblem(parse("bar", { xColumn: "revenue", yColumns: ["status"] }), columns)?.message,
    "“status” holds text values; a bar chart needs a column of numbers.",
  )
  assert.equal(
    columnProblem(parse("gauge", { valueColumn: "status", max: 10 }), columns)?.field,
    "config.valueColumn",
  )
  assert.equal(
    columnProblem(
      parse("ticker", { labelColumn: "status", valueColumn: "revenue", deltaColumn: "status2" }),
      columns,
    )?.field,
    "config.deltaColumn",
  )
  assert.equal(
    columnProblem(
      parse("sankey", { sourceColumn: "orders", targetColumn: "revenue", valueColumn: "status" }),
      columns,
    )?.message,
    "“status” holds text values; a Sankey diagram needs a column of numbers.",
  )
})

test("charts carry up to 1,000 rows of their columns, tickers 50, and gauges the first row", () => {
  const many = Array.from({ length: 1_200 }, (_value, index) => [`s${index}`, index, `${index}.50`, null])
  const bar = panelInputSchema.parse({
    kind: "bar",
    savedQueryId: SAVED_QUERY,
    config: { xColumn: "status", yColumns: ["revenue"] },
  })
  const shown = panelResult(bar, result(many))
  assert.deepEqual(shown.result.columns, [columns[0], columns[2]])
  assert.equal(shown.result.rows.length, DASHBOARD_LIMITS.chartRows)
  assert.deepEqual(shown.result.rows[1], ["s1", "1.50"])
  assert.equal(shown.partialResult, true)

  const ticker = panelInputSchema.parse({
    kind: "ticker",
    savedQueryId: SAVED_QUERY,
    config: { labelColumn: "status", valueColumn: "orders", deltaColumn: "last_month" },
  })
  const items = panelResult(ticker, result(many)).result
  assert.equal(items.rows.length, DASHBOARD_LIMITS.tickerRows)
  assert.deepEqual(items.rows[0], ["s0", 0, null])

  const gauge = panelInputSchema.parse({
    kind: "gauge",
    savedQueryId: SAVED_QUERY,
    config: { valueColumn: "revenue", max: 2000 },
  })
  assert.deepEqual(panelResult(gauge, result(many)).result.rows, [["0.50"]])
})
