import assert from "node:assert/strict"
import test from "node:test"

import {
  describeNumber,
  formatDecimal,
  parseDecimal,
  percentChange,
  roundDecimal,
  type NumberStyle,
} from "../src/entities/dashboards/number-format.ts"
import {
  canEditDashboard,
  columnProblem,
  movedIds,
  numberCells,
  panelTitle,
  runValues,
  shownResult,
} from "../src/entities/dashboards/panel-config.ts"
import type { DashboardPanel, NumberConfig } from "../src/entities/dashboards/types.ts"
import type { QueryResult, ResultColumn } from "../src/entities/queries/types.ts"
import { dashboardPatch, nameProblem } from "../src/features/dashboard/dashboard-form.ts"
import {
  draftFromPanel,
  newPanelDraft,
  panelInput,
  panelPatch,
  privateQueryProblem,
  suggestedColumns,
  type PanelDraft,
} from "../src/features/dashboard/panel-form.ts"
import { startDraft } from "../src/shared/lib/draft.ts"

const SAVED_QUERY = "4f1c2b8e-6d3a-4e5f-9a7b-1c2d3e4f5a6b"

const exact: NumberStyle = { format: "number", decimals: null, currency: null }
const show = (cell: string | number, style: Partial<NumberStyle> = {}) => {
  const value = parseDecimal(cell)
  assert.ok(value, `${cell} parses`)
  return formatDecimal(value, { ...exact, ...style })
}

const column = (name: string, kind: ResultColumn["kind"]): ResultColumn => ({ name, type: kind, kind })
const columns = [column("status", "text"), column("revenue", "decimal"), column("last_month", "decimal")]
const result: QueryResult = {
  columns,
  rows: [
    ["delivered", "18250.40", "17000.00"],
    ["refunded", "-310.25", null],
  ],
  rowCount: 2,
  truncated: false,
  truncatedBy: null,
  durationMs: 4,
}

const numberConfig: NumberConfig = {
  valueColumn: "revenue",
  comparisonColumn: "last_month",
  format: "currency",
  decimals: 2,
  currency: "USD",
}

test("decimal strings are formatted from their digits, never through a float", () => {
  assert.equal(show("12345678901234567890.123456789"), "12,345,678,901,234,567,890.123456789")
  assert.equal(show("9007199254740993"), "9,007,199,254,740,993")
  assert.equal(show("-0.000120"), "-0.000120")
  assert.equal(show("1234.50"), "1,234.50")
  assert.equal(show(42), "42")
  assert.equal(show(0.1 + 0.2), "0.30000000000000004")
  assert.equal(show(1e21), "1,000,000,000,000,000,000,000")
  assert.equal(show("-1.5e-7"), "-0.00000015")
  assert.equal(show("+.5"), "0.5")
  const notNumbers = ["NaN", "Infinity", "-Infinity", "", " ", "-", "1,000", "12abc", ".", "0x1F", "1e99999"]
  for (const text of notNumbers) assert.equal(parseDecimal(text), null, text)
  // Decimal128 writes exponents up to E+6144.
  assert.equal(show("1.23E+5"), "123,000")
  assert.equal(show("1E+6144").replaceAll(",", ""), `1${"0".repeat(6144)}`)
  // The longest PostgreSQL numerics group in linear time, every digit kept.
  const longest = `-${"9".repeat(131_072)}.${"1".repeat(16_383)}`
  const started = performance.now()
  const long = show(longest)
  assert.ok(performance.now() - started < 1_000)
  assert.ok(long.startsWith("-99,999,999,"))
  assert.equal(long.replaceAll(",", ""), longest)
  assert.equal(long.split(",").length - 1, Math.ceil(131_072 / 3) - 1)
  assert.equal(parseDecimal(Number.NaN), null)
  assert.equal(parseDecimal(true), null)
  assert.equal(parseDecimal(null), null)
})

test("rounding is half away from zero, exactly, and percent values are ratios", () => {
  assert.equal(show("2.345", { decimals: 2 }), "2.35")
  assert.equal(show("-2.345", { decimals: 2 }), "-2.35")
  assert.equal(show("2.344999999999999999999", { decimals: 2 }), "2.34")
  assert.equal(show("99999999999999999999.995", { decimals: 2 }), "100,000,000,000,000,000,000.00")
  assert.equal(show("-0.004", { decimals: 2 }), "0.00")
  assert.equal(show("7", { decimals: 3 }), "7.000")
  assert.deepEqual(roundDecimal({ units: 15n, scale: 1 }, 0), { units: 2n, scale: 0 })
  assert.equal(show("0.2534", { format: "percent" }), "25.34%")
  assert.equal(show("0.2534", { format: "percent", decimals: 1 }), "25.3%")
  assert.equal(show("-1.5", { format: "percent", decimals: 0 }), "-150%")
  assert.equal(show("3", { format: "percent" }), "300%")
})

test("currency values use the currency's symbol around the exact amount", () => {
  assert.equal(show("18250.4", { format: "currency", currency: "USD", decimals: 2 }), "$18,250.40")
  assert.equal(show("-310.25", { format: "currency", currency: "EUR", decimals: 2 }), "-€310.25")
  assert.equal(
    show("1234567890123456789.5", { format: "currency", currency: "INR" }),
    "₹1,234,567,890,123,456,789.5",
  )
  assert.equal(show("12.5", { format: "currency", currency: "CHF", decimals: 2 }), "CHF 12.50")
  const value = parseDecimal("1250.4")
  assert.ok(value)
  assert.equal(formatDecimal(value, { format: "currency", currency: "USD", decimals: 2 }, true), "+$1,250.40")
})

test("a number panel shows its value with the difference from the comparison", () => {
  assert.deepEqual(describeNumber("18250.40", "17000.00", numberConfig), {
    kind: "value",
    text: "$18,250.40",
    exact: "18250.40",
    delta: { text: "+$1,250.40", direction: "up", change: "+7.4%" },
  })
  const down = describeNumber("90", "120", { ...numberConfig, format: "number", decimals: null })
  assert.deepEqual(down.kind === "value" && down.delta, { text: "-30", direction: "down", change: "-25.0%" })
  const flat = describeNumber(5, 5, { ...numberConfig, format: "number", decimals: null })
  assert.deepEqual(flat.kind === "value" && flat.delta, { text: "0", direction: "flat", change: "0.0%" })
  const fromZero = describeNumber("5", "0", { ...numberConfig, format: "number" })
  assert.equal(fromZero.kind === "value" && fromZero.delta?.change, null)
  const percent = describeNumber("0.25", "0.2", { ...numberConfig, format: "percent", decimals: 1 })
  assert.deepEqual(percent.kind === "value" && percent.delta, {
    text: "+5.0%",
    direction: "up",
    change: null,
  })
  // A comparison that is NULL shows no difference.
  const noBase = describeNumber("10", null, numberConfig)
  assert.equal(noBase.kind === "value" && noBase.delta, null)
  assert.deepEqual(describeNumber(null, undefined, numberConfig), {
    kind: "empty",
    message: "No value: “revenue” is NULL.",
  })
  assert.equal(describeNumber({ $missing: true }, undefined, numberConfig).kind, "empty")
  assert.deepEqual(describeNumber("NaN", undefined, numberConfig), {
    kind: "invalid",
    message: "“revenue” is NaN, not a number.",
  })
  assert.deepEqual(describeNumber("", undefined, numberConfig), {
    kind: "invalid",
    message: "“revenue” is empty, not a number.",
  })
  assert.deepEqual(describeNumber("x".repeat(500), undefined, numberConfig), {
    kind: "invalid",
    message: `“revenue” is ${"x".repeat(60)}…, not a number.`,
  })
  const huge = parseDecimal("10000000000000000000001")
  const base = parseDecimal("10000000000000000000000")
  assert.ok(huge && base)
  assert.deepEqual(percentChange(huge, base), { units: 0n, scale: 1 })
})

test("panel configs are checked against a result's columns, and panels show only their part", () => {
  assert.equal(columnProblem({ kind: "number", config: numberConfig }, columns), null)
  assert.deepEqual(
    columnProblem({ kind: "number", config: { ...numberConfig, comparisonColumn: "gone" } }, columns),
    {
      field: "comparisonColumn",
      column: "gone",
      message: "The result has no column “gone”.",
    },
  )
  assert.match(
    columnProblem({ kind: "number", config: { ...numberConfig, valueColumn: "status" } }, columns)?.message ??
      "",
    /holds text values/,
  )
  // Mixed MongoDB fields are checked when shown.
  const mixed = { ...numberConfig, valueColumn: "status", comparisonColumn: null }
  assert.equal(columnProblem({ kind: "number", config: mixed }, [column("status", "unknown")]), null)
  assert.equal(columnProblem({ kind: "table", config: { columns: null } }, []), null)

  const table = shownResult({ kind: "table", config: { columns: ["revenue", "status"] } }, result)
  assert.deepEqual(
    table.columns.map((item) => item.name),
    ["revenue", "status"],
  )
  assert.deepEqual(table.rows, [
    ["18250.40", "delivered"],
    ["-310.25", "refunded"],
  ])
  assert.deepEqual(shownResult({ kind: "table", config: { columns: null } }, result), result)
  const number = shownResult({ kind: "number", config: numberConfig }, result)
  assert.deepEqual(number.rows, [["18250.40", "17000.00"]])
  assert.deepEqual(numberCells(numberConfig, result), { value: "18250.40", comparison: "17000.00" })
  assert.deepEqual(numberCells({ ...numberConfig, comparisonColumn: null }, result), {
    value: "18250.40",
    comparison: undefined,
  })
  assert.equal(numberCells(numberConfig, { ...result, rows: [] }), undefined)
  assert.equal(panelTitle("  ", "Order totals"), "Order totals")
  assert.equal(panelTitle("Revenue", "Order totals"), "Revenue")
  assert.equal(panelTitle("", null), "")
})

test("a panel says which parameter values its result ran with", () => {
  assert.equal(runValues(null), null)
  assert.equal(runValues({}), null)
  assert.equal(
    runValues({ since: "2026-07-31T00:00:00+05:30", until: null }),
    "since: 2026-07-31 00:00:00+05:30 · until: none",
  )
  assert.equal(runValues({ day: "2026-10-01" }), "day: 2026-10-01")
})

test("panels move one place at a time, and only editors may move them", () => {
  assert.deepEqual(movedIds(["a", "b", "c"], 1, -1), ["b", "a", "c"])
  assert.deepEqual(movedIds(["a", "b", "c"], 1, 1), ["a", "c", "b"])
  assert.equal(movedIds(["a", "b", "c"], 0, -1), null)
  assert.equal(movedIds(["a", "b", "c"], 2, 1), null)
  assert.equal(movedIds([], 0, 1), null)
  const dashboard = { createdBy: { id: "u1", name: "Ava" } }
  assert.equal(canEditDashboard(dashboard, "u1", "member"), true)
  assert.equal(canEditDashboard(dashboard, "u2", "member"), false)
  assert.equal(canEditDashboard(dashboard, "u2", "admin"), true)
  assert.equal(canEditDashboard({ createdBy: null }, "u2", "owner"), true)
  assert.equal(canEditDashboard({ createdBy: null }, undefined, null), false)
})

test("the panel form mirrors the server's checks and round-trips saved panels", () => {
  const draft = (changes: Partial<PanelDraft>): PanelDraft => ({ ...newPanelDraft(SAVED_QUERY), ...changes })
  const errorsOf = (changes: Partial<PanelDraft>, known: ResultColumn[] | null = columns) => {
    const built = panelInput(draft(changes), known)
    return "errors" in built ? built.errors : {}
  }
  assert.deepEqual(newPanelDraft().kind, "table")
  assert.deepEqual(errorsOf({ savedQueryId: "" }), { savedQueryId: "Choose a saved query." })
  assert.deepEqual(errorsOf({ kind: "number" }), { valueColumn: "Choose the column with the value." })
  assert.deepEqual(errorsOf({ kind: "number", valueColumn: "revenue", comparisonColumn: "revenue" }), {
    comparisonColumn: "Compare the value with a different column.",
  })
  assert.match(
    errorsOf({ kind: "number", valueColumn: "revenue", format: "currency", currency: "us" }).currency ?? "",
    /three-letter/,
  )
  assert.deepEqual(errorsOf({ kind: "number", valueColumn: "revenue", comparisonColumn: "profit" }), {
    comparisonColumn: "The result has no column “profit”.",
  })
  assert.match(errorsOf({ kind: "number", valueColumn: "status" }).valueColumn ?? "", /holds text values/)
  // Without a stored result, columns are not checked yet.
  assert.deepEqual(errorsOf({ kind: "number", valueColumn: "anything" }, null), {})
  assert.deepEqual(errorsOf({ columns: [] }), { columns: "Choose at least one column, or show them all." })
  assert.deepEqual(errorsOf({ columns: ["status", "profit"] }), {
    columns: "The result has no column “profit”.",
  })
  assert.deepEqual(errorsOf({ kind: "markdown", body: "  " }), { body: "Write the panel's text." })
  assert.match(errorsOf({ kind: "markdown", body: "x".repeat(4_001) }).body ?? "", /at most 4,000/)
  assert.match(errorsOf({ title: "t".repeat(201) }).title ?? "", /at most 200/)

  assert.deepEqual(
    panelInput(
      draft({
        kind: "number",
        title: " Revenue ",
        valueColumn: "revenue",
        format: "percent",
        decimals: "1",
        currency: "EUR",
      }),
      columns,
    ),
    {
      input: {
        kind: "number",
        title: "Revenue",
        savedQueryId: SAVED_QUERY,
        config: {
          valueColumn: "revenue",
          comparisonColumn: null,
          format: "percent",
          decimals: 1,
          currency: null,
        },
      },
    },
  )
  assert.deepEqual(panelInput(draft({ kind: "markdown", body: "## Notes" }), null), {
    input: { kind: "markdown", title: "", config: { body: "## Notes" } },
  })

  const saved: DashboardPanel = {
    id: "p1",
    kind: "number",
    title: "Revenue",
    savedQueryId: SAVED_QUERY,
    config: numberConfig,
    layout: { x: 0, y: 0, w: 3, h: 2 },
    version: 3,
    createdAt: "2026-10-31T10:00:00.000Z",
    updatedAt: "2026-10-31T10:00:00.000Z",
    data: null,
    status: null,
  }
  const reopened = panelInput(draftFromPanel(saved), columns)
  assert.ok("input" in reopened)
  assert.deepEqual(reopened.input, {
    kind: "number",
    title: "Revenue",
    savedQueryId: SAVED_QUERY,
    config: numberConfig,
  })
  assert.deepEqual(panelPatch(saved, reopened.input), { version: 3, ...reopened.input })
  const tablePanel: DashboardPanel = { ...saved, kind: "table", title: "", config: { columns: ["status"] } }
  assert.deepEqual(draftFromPanel(tablePanel).columns, ["status"])
  assert.deepEqual(suggestedColumns("number", newPanelDraft(), columns), { valueColumn: "revenue" })
  assert.deepEqual(suggestedColumns("number", newPanelDraft(), [column("status", "text")]), {
    valueColumn: "",
  })
})

test("private saved queries only go on private dashboards; dashboard edits send what changed", () => {
  const mine = { name: "My totals", visibility: "private" as const }
  assert.match(
    privateQueryProblem({ kind: "table" }, mine, { visibility: "workspace" }) ?? "",
    /visible only to you/,
  )
  assert.equal(privateQueryProblem({ kind: "table" }, mine, { visibility: "private" }), null)
  assert.equal(privateQueryProblem({ kind: "markdown" }, mine, { visibility: "workspace" }), null)
  assert.equal(
    privateQueryProblem({ kind: "table" }, { ...mine, visibility: "workspace" }, { visibility: "workspace" }),
    null,
  )

  assert.equal(nameProblem("  "), "Give the dashboard a name.")
  assert.match(nameProblem("n".repeat(201)) ?? "", /at most 200/)
  assert.equal(nameProblem("Overview"), null)
  const state = startDraft({ name: "Overview", description: "Old", visibility: "workspace" }, 4)
  assert.deepEqual(
    dashboardPatch({ ...state, draft: { ...state.draft, name: " Store overview ", description: "" } }),
    {
      version: 4,
      name: "Store overview",
      description: "",
    },
  )
  assert.deepEqual(dashboardPatch({ ...state, draft: { ...state.draft, visibility: "private" } }), {
    version: 4,
    visibility: "private",
  })
})
