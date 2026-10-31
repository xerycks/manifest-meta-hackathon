import assert from "node:assert/strict"
import test from "node:test"

import {
  axisNumber,
  BAR_CATEGORIES,
  buildSeries,
  formatExact,
  gaugeReading,
  plotNumber,
  sankeyData,
  sankeySummary,
  seriesSummary,
  tickerItems,
  topWithOther,
  wallClock,
  xLabel,
} from "../src/entities/dashboards/chart-data.ts"
import { refreshingPanels, refreshUnderway } from "../src/entities/dashboards/refresh-state.ts"
import type {
  DashboardPanel,
  GaugeConfig,
  SankeyConfig,
  SeriesConfig,
  TickerConfig,
} from "../src/entities/dashboards/types.ts"
import type { Cell, QueryResult, ResultColumn } from "../src/entities/queries/types.ts"
import {
  DECIMAL_CHOICES,
  draftFromPanel,
  duplicateInput,
  newPanelDraft,
  panelInput,
  settingsErrors,
  suggestedColumns,
  type PanelDraft,
} from "../src/features/dashboard/panel-form.ts"

const SAVED_QUERY = "4f1c2b8e-6d3a-4e5f-9a7b-1c2d3e4f5a6b"
const column = (name: string, kind: ResultColumn["kind"]): ResultColumn => ({ name, type: kind, kind })
const resultOf = (columns: ResultColumn[], rows: Cell[][], rowCount = rows.length): QueryResult => ({
  columns,
  rows,
  rowCount,
  truncated: false,
  truncatedBy: null,
  durationMs: 3,
})
const series = (changes: Partial<SeriesConfig> = {}): SeriesConfig => ({
  xColumn: "status",
  yColumns: ["revenue"],
  stacked: false,
  sort: "none",
  xFormat: "auto",
  format: "number",
  decimals: null,
  currency: null,
  ...changes,
})
const exact = { format: "number", decimals: null, currency: null } as const

test("decimal strings become floats only for plotting; labels keep their exact digits", () => {
  assert.equal(plotNumber("18250.40"), 18250.4)
  assert.equal(plotNumber(7), 7)
  assert.equal(plotNumber("9007199254740993"), 9007199254740992)
  for (const cell of [null, { $missing: true } as const, "NaN", "Infinity", "n/a", true]) {
    assert.equal(plotNumber(cell), null)
  }
  // Wall-clock time as written, whatever the offset.
  assert.equal(wallClock("2026-10-31T23:30:00+05:30"), Date.UTC(2026, 9, 31, 23, 30))
  assert.equal(wallClock("2026-10-01"), Date.UTC(2026, 9, 1))
  assert.equal(wallClock("October"), null)
  const month = column("month", "datetime")
  assert.equal(xLabel("2026-10-01T00:00:00Z", month, "month"), "Oct 2026")
  assert.equal(xLabel("2026-10-01T00:00:00Z", month, "auto"), "Oct 1, 2026, 00:00")
  assert.equal(xLabel("2026-10-01", column("day", "date"), "auto"), "Oct 1, 2026")
  assert.equal(xLabel("2026-10-01", column("day", "date"), "text"), "2026-10-01")
  assert.equal(xLabel(null, column("status", "text"), "auto"), "NULL")
  assert.equal(axisNumber(12500, exact), "12.5K")
  assert.equal(axisNumber(0.25, { ...exact, format: "percent" }), "25%")
  assert.equal(axisNumber(2000, { format: "currency", currency: "USD", decimals: null }), "$2,000")
})

test("bar series add up rows that share a category, keep exact sums, and leave out what is not a number", () => {
  const columns = [column("status", "text"), column("revenue", "decimal"), column("orders", "integer")]
  const result = resultOf(columns, [
    ["delivered", "100.10", 3],
    ["refunded", "-0.05", null],
    ["delivered", "0.20", 2],
    [null, "5", 1],
    ["shipped", "n/a", 1],
  ])
  const data = buildSeries("bar", series({ yColumns: ["revenue", "orders"], sort: "value_desc" }), result)
  assert.equal(data.axis, "category")
  assert.deepEqual(
    data.points.map((point) => [
      point.label,
      point.values,
      point.exact.map((value) => formatExact(value, exact)),
    ]),
    [
      ["delivered", [100.3, 5], ["100.30", "5"]],
      ["NULL", [5, 1], ["5", "1"]],
      ["shipped", [null, 1], ["No value", "1"]],
      ["refunded", [-0.05, null], ["-0.05", "No value"]],
    ],
  )
  assert.deepEqual(data.notes, [
    "Rows with the same x value are added together.",
    "1 value that is not a number is left out.",
  ])
  assert.match(
    seriesSummary("bar", series({ yColumns: ["revenue", "orders"] }), data),
    /^Bar chart of revenue, orders by status: 4 categories\. Highest revenue: delivered \(100\.30\)/,
  )
  const byLabel = buildSeries("bar", series({ sort: "x" }), result)
  assert.deepEqual(
    byLabel.points.map((point) => point.label),
    ["delivered", "NULL", "refunded", "shipped"],
  )
})

test("values too large for a float are not plotted but keep their exact digits", () => {
  const huge = `9${"0".repeat(400)}`
  const columns = [column("status", "text"), column("revenue", "decimal")]
  const data = buildSeries("bar", series(), resultOf(columns, [["big", huge], ["small", "2.5"]]))
  assert.deepEqual(
    data.points.map((point) => [point.label, point.values, formatExact(point.exact[0] ?? null, exact)]),
    [
      ["big", [null], formatExact({ units: BigInt(huge), scale: 0 }, exact)],
      ["small", [2.5], "2.5"],
    ],
  )
  const flows = sankeyData(
    { sourceColumn: "from", targetColumn: "to", valueColumn: "amount" },
    resultOf(
      [column("from", "text"), column("to", "text"), column("amount", "decimal")],
      [
        ["a", "b", huge],
        ["b", "c", "1"],
      ],
    ),
  )
  assert.deepEqual(
    flows.links.map((link) => [Number.isFinite(link.value), link.exact.units === BigInt(huge)]),
    [
      [true, true],
      [true, false],
    ],
  )
  const gauge: GaugeConfig = {
    valueColumn: "rate",
    min: 0,
    max: 100,
    thresholds: [{ value: 50, status: "critical" }],
    format: "number",
    decimals: null,
    currency: null,
  }
  const reading = (cell: Cell) => gaugeReading(gauge, resultOf([column("rate", "decimal")], [[cell]]))
  assert.deepEqual(
    [reading("1E+400"), reading("-1E+400")].map((shown) =>
      shown.kind === "value" ? [shown.ratio, shown.outside, shown.status] : shown.kind,
    ),
    [
      [1, "above", "critical"],
      [0, "below", null],
    ],
  )
})

test("bars keep the largest categories and add the rest together as Other", () => {
  const columns = [column("product", "text"), column("revenue", "decimal")]
  const rows: Cell[][] = Array.from({ length: 30 }, (_value, index) => [`p${index}`, `${index}.10`])
  const data = buildSeries("bar", series({ xColumn: "product" }), resultOf(columns, rows))
  assert.equal(data.points.length, BAR_CATEGORIES + 1)
  const other = data.points.at(-1)
  assert.equal(other?.label, "Other (5 categories)")
  assert.equal(other?.folded, 5)
  // p0..p4 are the smallest: 0.1 + 1.1 + 2.1 + 3.1 + 4.1, exactly.
  assert.equal(formatExact(other?.exact[0] ?? null, exact), "10.50")
  assert.deepEqual(
    data.points.slice(0, 3).map((point) => point.label),
    ["p5", "p6", "p7"],
  )
  assert.match(
    data.notes.join(" "),
    /Showing the 25 largest of 30 categories; the other 5 are added together/,
  )
  const few = data.points.slice(0, 3)
  assert.equal(topWithOther(few, 25), few)
})

test("lines on a date column follow time, with gaps where a value is missing", () => {
  const columns = [column("day", "date"), column("revenue", "decimal")]
  const result = resultOf(columns, [
    ["2026-10-03", "30.5"],
    ["2026-10-01", "10.25"],
    ["2026-10-02", null],
    [null, "99"],
  ])
  const data = buildSeries("line", series({ xColumn: "day" }), result)
  assert.equal(data.axis, "time")
  assert.deepEqual(
    data.points.map((point) => [point.label, point.position, point.values[0]]),
    [
      ["Oct 1, 2026", Date.UTC(2026, 9, 1), 10.25],
      ["Oct 2, 2026", Date.UTC(2026, 9, 2), null],
      ["Oct 3, 2026", Date.UTC(2026, 9, 3), 30.5],
    ],
  )
  assert.deepEqual(data.notes, ["1 row without an x value is left out."])
  assert.match(
    seriesSummary("line", series({ xColumn: "day" }), data),
    /3 points from Oct 1, 2026 to Oct 3, 2026/,
  )
  // Numbers along a number axis; text stays in result order unless sorted.
  const numeric = buildSeries(
    "line",
    series({ xColumn: "n" }),
    resultOf(
      [column("n", "integer"), column("revenue", "decimal")],
      [
        [3, "1"],
        [1, "2"],
      ],
    ),
  )
  assert.equal(numeric.axis, "number")
  assert.deepEqual(
    numeric.points.map((point) => point.position),
    [1, 3],
  )
  const text = buildSeries(
    "line",
    series(),
    resultOf(
      [column("status", "text"), column("revenue", "decimal")],
      [
        ["b", "1"],
        ["a", "2"],
      ],
    ),
  )
  assert.equal(text.axis, "category")
  assert.deepEqual(
    text.points.map((point) => point.label),
    ["b", "a"],
  )
})

test("Sankey flows add up exactly and leave out self-links, loops, unusable rows, and the smallest flows", () => {
  const config: SankeyConfig = { sourceColumn: "from", targetColumn: "to", valueColumn: "orders" }
  const columns = [column("from", "text"), column("to", "text"), column("orders", "decimal")]
  const result = resultOf(columns, [
    ["web", "paid", "10.5"],
    ["web", "paid", "4.5"],
    ["app", "paid", "7"],
    ["paid", "shipped", "20"],
    ["shipped", "web", "1"],
    ["web", "web", "3"],
    ["app", null, "2"],
    ["app", "shipped", "0"],
    ["app", "refunded", "0.5"],
  ])
  const data = sankeyData(config, result)
  const name = (index: number) => data.nodes[index]?.name
  assert.deepEqual(
    data.links.map((link) => [name(link.source), name(link.target), formatExact(link.exact, exact)]),
    [
      ["paid", "shipped", "20"],
      ["web", "paid", "15.0"],
      ["app", "paid", "7"],
      ["app", "refunded", "0.5"],
    ],
  )
  assert.deepEqual(data.notes, [
    "2 rows without a source, a target, or a positive value are left out.",
    "1 row flowing back into the same node is left out.",
    "1 flow that would loop back is left out.",
  ])
  assert.equal(formatExact(data.nodes.find((node) => node.name === "paid")?.exact ?? null, exact), "22.0")
  assert.equal(
    sankeySummary(data),
    "Sankey diagram of 4 flows between 5 nodes; the largest is paid to shipped (20).",
  )
  const top = sankeyData(config, result, 2)
  assert.equal(top.links.length, 2)
  assert.match(top.notes.join(" "), /Showing the 2 largest of 5 flows\./)
  assert.equal(sankeySummary(sankeyData(config, resultOf(columns, []))), "Sankey diagram: no flows to show.")
})

test("ticker items format each value and its signed change", () => {
  const config: TickerConfig = {
    labelColumn: "region",
    valueColumn: "revenue",
    deltaColumn: "change",
    format: "currency",
    decimals: 2,
    currency: "USD",
  }
  const columns = [column("region", "text"), column("revenue", "decimal"), column("change", "decimal")]
  const items = tickerItems(
    config,
    resultOf(columns, [
      ["EMEA", "1250.4", "-30"],
      ["APAC", null, "0"],
      ["LATAM", "x", null],
    ]),
  )
  assert.deepEqual(
    items.map((item) => [item.label, item.value, item.exact, item.delta]),
    [
      ["EMEA", "$1,250.40", "1250.4", { text: "-$30.00", direction: "down" }],
      ["APAC", "No value", null, { text: "$0.00", direction: "flat" }],
      ["LATAM", "Not a number", null, null],
    ],
  )
})

test("a gauge places its value on the scale and takes the status of the highest threshold reached", () => {
  const config: GaugeConfig = {
    valueColumn: "rate",
    min: 0,
    max: 1,
    thresholds: [
      { value: 0.5, status: "warning" },
      { value: 0.8, status: "critical" },
    ],
    format: "percent",
    decimals: 1,
    currency: null,
  }
  const at = (cell: Cell) => gaugeReading(config, resultOf([column("rate", "decimal")], [[cell]]))
  assert.deepEqual(at("0.625"), {
    kind: "value",
    text: "62.5%",
    exact: "0.625",
    ratio: 0.625,
    status: "warning",
    outside: null,
  })
  assert.equal((at("0.2") as { status: unknown }).status, null)
  assert.deepEqual(
    [(at("1.5") as { ratio: number }).ratio, (at("1.5") as { outside: unknown }).outside],
    [1, "above"],
  )
  assert.equal(at(null).kind, "empty")
  assert.equal(at("high").kind, "invalid")
  assert.equal(gaugeReading(config, resultOf([column("rate", "decimal")], [])).kind, "empty")
})

test("panel statuses say what is still refreshing", () => {
  const panels = [
    { id: "a", status: { state: "refreshing" as const, since: null, lastSuccessAt: null } },
    { id: "b", status: { state: "fresh" as const, lastSuccessAt: "2026-10-31T10:00:00.000Z" } },
    { id: "c", status: null },
  ]
  assert.deepEqual([...refreshingPanels(panels)], ["a"])
  assert.equal(refreshUnderway({ active: false, panels }), true)
  assert.equal(refreshUnderway({ active: false, panels: panels.slice(1) }), false)
  assert.equal(refreshUnderway({ active: true, panels: [] }), true)
})

test("the chart settings mirror the server's checks and round-trip saved panels", () => {
  assert.deepEqual(DECIMAL_CHOICES, ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"])
  const columns = [
    column("day", "date"),
    column("status", "text"),
    column("channel", "text"),
    column("revenue", "decimal"),
    column("orders", "integer"),
  ]
  const draft = (changes: Partial<PanelDraft>): PanelDraft => ({ ...newPanelDraft(SAVED_QUERY), ...changes })
  const errorsOf = (changes: Partial<PanelDraft>) => {
    const built = panelInput(draft(changes), columns)
    return "errors" in built ? built.errors : {}
  }

  assert.deepEqual(suggestedColumns("line", newPanelDraft(), columns), {
    xColumn: "day",
    yColumns: ["revenue"],
  })
  assert.deepEqual(suggestedColumns("bar", draft({ yColumns: ["orders"] }), columns), {
    xColumn: "day",
    yColumns: ["orders"],
  })
  assert.deepEqual(suggestedColumns("sankey", newPanelDraft(), columns), {
    sourceColumn: "day",
    targetColumn: "status",
    valueColumn: "revenue",
  })
  assert.deepEqual(suggestedColumns("ticker", draft({ valueColumn: "orders" }), columns), {
    labelColumn: "day",
    valueColumn: "orders",
  })

  assert.deepEqual(errorsOf({ kind: "bar" }), {
    xColumn: "Choose the column for the x axis.",
    yColumns: "Choose at least one column of values.",
  })
  assert.deepEqual(errorsOf({ kind: "bar", xColumn: "status", yColumns: ["status"] }), {
    yColumns: "Plot columns other than the x column.",
  })
  assert.match(
    errorsOf({ kind: "line", xColumn: "day", yColumns: ["revenue", "channel"] }).yColumns ?? "",
    /“channel” holds text values; a line chart needs a column of numbers/,
  )
  assert.deepEqual(errorsOf({ kind: "gauge", valueColumn: "revenue", min: "10", max: "5" }), {
    max: "The maximum must be above the minimum.",
  })
  assert.deepEqual(errorsOf({ kind: "gauge", valueColumn: "revenue", min: "", max: "x" }), {
    min: "Enter the lowest value of the scale.",
    max: "Enter the highest value of the scale.",
  })
  assert.match(
    errorsOf({
      kind: "gauge",
      valueColumn: "revenue",
      thresholds: [
        { value: "60", status: "warning" },
        { value: "40", status: "critical" },
      ],
    }).thresholds ?? "",
    /lowest to the highest/,
  )
  assert.deepEqual(errorsOf({ kind: "ticker", labelColumn: "status", valueColumn: "status" }), {
    valueColumn: "Use a different column for the labels.",
  })
  assert.deepEqual(
    errorsOf({ kind: "sankey", sourceColumn: "status", targetColumn: "status", valueColumn: "orders" }),
    {
      targetColumn: "Use a different column for the targets.",
    },
  )
  assert.deepEqual(settingsErrors(draft({ kind: "bar", xColumn: "status", yColumns: ["revenue"] })), {})

  // A line keeps result order or follows x, whatever a bar chart left in the draft.
  const line = panelInput(
    draft({ kind: "line", xColumn: "day", yColumns: ["revenue"], sort: "value_desc" }),
    columns,
  )
  assert.ok("input" in line)
  assert.deepEqual(line.input.kind === "line" && line.input.config.sort, "none")

  const gauge = panelInput(
    draft({
      kind: "gauge",
      title: "Refund rate",
      valueColumn: "revenue",
      min: "0",
      max: "1",
      thresholds: [{ value: "0.5", status: "warning" }],
      format: "percent",
      decimals: "10",
    }),
    columns,
  )
  assert.ok("input" in gauge)
  const saved: DashboardPanel = {
    ...gauge.input,
    id: "p1",
    layout: { x: 0, y: 0, w: 3, h: 3 },
    version: 2,
    createdAt: "2026-10-31T10:00:00.000Z",
    updatedAt: "2026-10-31T10:00:00.000Z",
    data: null,
    status: null,
  } as DashboardPanel
  assert.deepEqual(saved.config, {
    format: "percent",
    decimals: 10,
    currency: null,
    valueColumn: "revenue",
    min: 0,
    max: 1,
    thresholds: [{ value: 0.5, status: "warning" }],
  })
  const reopened = panelInput(draftFromPanel(saved), columns)
  assert.ok("input" in reopened)
  assert.deepEqual(reopened.input, gauge.input)
  assert.deepEqual(duplicateInput(saved), { ...gauge.input, title: "Refund rate (copy)" })
  assert.equal(duplicateInput({ ...saved, savedQueryId: null }), null)
})
