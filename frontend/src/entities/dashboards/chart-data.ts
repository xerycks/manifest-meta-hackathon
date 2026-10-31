import { displayCell, isMissing } from "../queries/cells.ts"
import type { Cell, ColumnKind, QueryResult, ResultColumn } from "../queries/types.ts"
import {
  addDecimal,
  describeNumber,
  formatDecimal,
  parseDecimal,
  type Decimal,
  type NumberStyle,
} from "./number-format.ts"
import type {
  GaugeConfig,
  SankeyConfig,
  SeriesConfig,
  ThresholdStatus,
  TickerConfig,
  XFormat,
} from "./types.ts"

/** Categories a bar chart draws; the rest are added together as "Other". */
export const BAR_CATEGORIES = 25
/** Flows a Sankey diagram draws, largest first. */
export const SANKEY_LINKS = 50

const count = (value: number, one: string, many = `${one}s`) =>
  `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`

/** The index of the first column of each name; results may repeat a name. */
function firstIndexes(columns: ResultColumn[]): Map<string, number> {
  const indexes = new Map<string, number>()
  columns.forEach((column, index) => {
    if (!indexes.has(column.name)) indexes.set(column.name, index)
  })
  return indexes
}

function columnOf(result: QueryResult, name: string): { index: number; column: ResultColumn } {
  const index = firstIndexes(result.columns).get(name) ?? -1
  return { index, column: result.columns[index] ?? { name, type: "unknown", kind: "unknown" } }
}

/** A number for plotting only (labels and tooltips keep the exact value); null when the cell holds none. */
export function plotNumber(cell: Cell): number | null {
  if (!parseDecimal(cell)) return null
  const value = typeof cell === "number" ? cell : Number(String(cell).trim())
  return Number.isFinite(value) ? value : null
}

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/

/** A date or timestamp at its wall-clock time as written (its offset is not applied), in ms; else null. */
export function wallClock(cell: Cell): number | null {
  if (typeof cell !== "string") return null
  const match = WALL_CLOCK.exec(cell)
  if (!match) return null
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match
  const time = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  )
  return Number.isNaN(time) ? null : time
}

type TimeFormat = "date" | "month" | "datetime"

const TIME_FORMATS: Record<TimeFormat, Intl.DateTimeFormat> = {
  date: new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  }),
  month: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "short" }),
  datetime: new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }),
}

/** The format an x column is written in: the chosen one, or the one its kind suggests. */
function timeFormat(format: XFormat, kind: ColumnKind): TimeFormat | null {
  if (format === "date" || format === "month" || format === "datetime") return format
  if (format === "auto" && (kind === "date" || kind === "datetime"))
    return kind === "date" ? "date" : "datetime"
  return null
}

/** A time position (wall-clock ms) as the axis writes it. */
export function formatTime(time: number, format: XFormat, kind: ColumnKind): string {
  return TIME_FORMATS[timeFormat(format, kind) ?? "datetime"].format(time)
}

/** How an x value reads on the axis, in tooltips, and in the table view. */
export function xLabel(cell: Cell, column: ResultColumn, format: XFormat): string {
  const asTime = timeFormat(format, column.kind)
  const time = asTime ? wallClock(cell) : null
  return time === null || !asTime ? displayCell(cell, column).text : TIME_FORMATS[asTime].format(time)
}

/** An exact value as a chart's tooltips and table write it. */
export function formatExact(value: Decimal | null, style: NumberStyle): string {
  return value ? formatDecimal(value, style) : "No value"
}

/** An axis tick: compact from 10,000 ("12.5K"), percent values (ratios) times 100. */
export function axisNumber(value: number, style: NumberStyle): string {
  const scaled = style.format === "percent" ? value * 100 : value
  const options: Intl.NumberFormatOptions =
    Math.abs(scaled) >= 10_000
      ? { notation: "compact", maximumFractionDigits: 1 }
      : { maximumFractionDigits: 2 }
  if (style.format === "currency" && style.currency) {
    try {
      return new Intl.NumberFormat("en-US", {
        ...options,
        style: "currency",
        currency: style.currency,
        minimumFractionDigits: 0,
      }).format(scaled)
    } catch {
      // An unknown currency falls through to a plain number.
    }
  }
  const text = new Intl.NumberFormat("en-US", options).format(scaled)
  return style.format === "percent" ? `${text}%` : text
}

// Bar and line charts ------------------------------------------------------------

export interface SeriesPoint {
  /** Unique per point. */
  key: string
  label: string
  /** Where the point sits on a number or time axis; null on a category axis. */
  position: number | null
  /** Per y column, for plotting only; null where there is no number. */
  values: (number | null)[]
  /** Per y column, exactly, for tooltips and the table view. */
  exact: (Decimal | null)[]
  /** Categories added together into this one ("Other"); 0 for a category of its own. */
  folded: number
}

export interface SeriesData {
  /** The y columns, one series each, in order. */
  series: string[]
  points: SeriesPoint[]
  axis: "category" | "number" | "time"
  /** The x column's kind, which decides how an automatic x format writes times. */
  xKind: ColumnKind
  /** Why the chart shows less, or other than, the rows it was given. */
  notes: string[]
}

const NUMERIC = new Set<ColumnKind>(["integer", "decimal", "float"])

const total = (point: Pick<SeriesPoint, "values">) =>
  point.values.reduce<number>((sum, value) => sum + (value ?? 0), 0)

function addAll(sums: (Decimal | null)[], values: (Decimal | null)[]): (Decimal | null)[] {
  return sums.map((sum, index) => {
    const value = values[index] ?? null
    if (!value) return sum
    return sum ? addDecimal(sum, value) : value
  })
}

/** An exact value as a float, for plotting only; null when it is too large for one. */
function decimalNumber(value: Decimal): number | null {
  const digits = (value.units < 0n ? -value.units : value.units).toString().padStart(value.scale + 1, "0")
  const whole = value.scale > 0 ? `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}` : digits
  const number = Number(`${value.units < 0n ? "-" : ""}${whole}`)
  return Number.isFinite(number) ? number : null
}

function plotted(exact: (Decimal | null)[]): (number | null)[] {
  return exact.map((value) => (value ? decimalNumber(value) : null))
}

const EXACT: NumberStyle = { format: "number", decimals: null, currency: null }

/**
 * Keeps the `limit` largest categories by total, in their order, and adds
 * the rest together into a final "Other" category (each series exactly).
 */
export function topWithOther(points: SeriesPoint[], limit = BAR_CATEGORIES): SeriesPoint[] {
  if (points.length <= limit) return points
  const kept = new Set(
    [...points]
      .sort((a, b) => total(b) - total(a))
      .slice(0, limit)
      .map((point) => point.key),
  )
  const rest = points.filter((point) => !kept.has(point.key))
  const exact = rest.reduce<(Decimal | null)[]>(
    (sums, point) => addAll(sums, point.exact),
    rest[0]?.exact.map(() => null) ?? [],
  )
  const other: SeriesPoint = {
    key: "\u0000other",
    label: `Other (${count(rest.length, "category", "categories")})`,
    position: null,
    values: plotted(exact),
    exact,
    folded: rest.length,
  }
  return [...points.filter((point) => kept.has(point.key)), other]
}

/**
 * The points a bar or line chart draws from a result's rows: decimals stay
 * exact for tooltips and become floats only for plotting, cells without a
 * number are gaps, bars add up rows that share a category, a line on a date
 * or number column follows its axis, and bars keep the 25 largest
 * categories plus "Other".
 */
export function buildSeries(kind: "bar" | "line", config: SeriesConfig, result: QueryResult): SeriesData {
  const x = columnOf(result, config.xColumn)
  const ys = config.yColumns.map((name) => columnOf(result, name).index)
  const notes: string[] = []
  let notNumbers = 0
  const rows = result.rows.map((row) => {
    const cell = row[x.index] ?? null
    const exact = ys.map((index) => {
      const value = row[index] ?? null
      const parsed = parseDecimal(value)
      if (!parsed && value !== null && !isMissing(value)) notNumbers += 1
      return parsed
    })
    return { cell, exact }
  })

  const asTime = timeFormat(config.xFormat, x.column.kind) !== null
  const positioned = rows.filter((row) => row.cell !== null && !isMissing(row.cell))
  let axis: SeriesData["axis"] = "category"
  if (kind === "line" && asTime && positioned.every((row) => wallClock(row.cell) !== null)) axis = "time"
  else if (kind === "line" && NUMERIC.has(x.column.kind) && config.xFormat === "auto") axis = "number"

  let points: SeriesPoint[]
  if (axis !== "category") {
    const position = (cell: Cell) => (axis === "time" ? wallClock(cell) : plotNumber(cell))
    points = rows.flatMap((row, index) => {
      const at = position(row.cell)
      if (at === null) return []
      const label = xLabel(row.cell, x.column, config.xFormat)
      return [
        { key: String(index), label, position: at, values: plotted(row.exact), exact: row.exact, folded: 0 },
      ]
    })
    if (points.length < rows.length) {
      notes.push(
        `${count(rows.length - points.length, "row")} without an x value ${rows.length - points.length === 1 ? "is" : "are"} left out.`,
      )
    }
    // A line along a continuous axis follows it.
    points.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  } else if (kind === "bar") {
    const byLabel = new Map<string, SeriesPoint & { order: number | null }>()
    for (const row of rows) {
      const label = xLabel(row.cell, x.column, config.xFormat)
      const found = byLabel.get(label)
      if (found) {
        found.exact = addAll(found.exact, row.exact)
        continue
      }
      const order = asTime ? wallClock(row.cell) : NUMERIC.has(x.column.kind) ? plotNumber(row.cell) : null
      byLabel.set(label, {
        key: label,
        label,
        position: null,
        values: [],
        exact: row.exact,
        folded: 0,
        order,
      })
    }
    if (byLabel.size < rows.length) notes.push("Rows with the same x value are added together.")
    const merged = [...byLabel.values()].map((point) => ({ ...point, values: plotted(point.exact) }))
    if (config.sort === "x") {
      merged.sort((a, b) =>
        a.order !== null && b.order !== null
          ? a.order - b.order
          : a.label.localeCompare(b.label, "en-US", { numeric: true }),
      )
    }
    if (config.sort === "value_desc") merged.sort((a, b) => total(b) - total(a))
    if (config.sort === "value_asc") merged.sort((a, b) => total(a) - total(b))
    points = topWithOther(merged.map(({ order: _order, ...point }) => point))
    if (merged.length > BAR_CATEGORIES) {
      notes.push(
        `Showing the ${BAR_CATEGORIES} largest of ${count(merged.length, "category", "categories")}; the other ${(merged.length - BAR_CATEGORIES).toLocaleString("en-US")} are added together as “Other”.`,
      )
    }
  } else {
    points = rows.map((row, index) => ({
      key: String(index),
      label: xLabel(row.cell, x.column, config.xFormat),
      position: null,
      values: plotted(row.exact),
      exact: row.exact,
      folded: 0,
    }))
    if (config.sort === "x") points.sort((a, b) => a.label.localeCompare(b.label, "en-US", { numeric: true }))
  }
  if (notNumbers > 0)
    notes.push(
      `${count(notNumbers, "value")} that ${notNumbers === 1 ? "is" : "are"} not a number ${notNumbers === 1 ? "is" : "are"} left out.`,
    )
  return { series: config.yColumns, points, axis, xKind: x.column.kind, notes }
}

// Sankey diagrams -----------------------------------------------------------------

export interface SankeyLink {
  source: number
  target: number
  /** For layout only. */
  value: number
  exact: Decimal
}

export interface SankeyNode {
  name: string
  /** What passes through it: the larger of what flows in and what flows out. */
  exact: Decimal
}

export interface SankeyData {
  nodes: SankeyNode[]
  /** Largest first. */
  links: SankeyLink[]
  notes: string[]
}

/** Whether `to` can already be reached from `from` along the links. */
function reaches(links: Map<string, Set<string>>, from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [from]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node === to) return true
    if (seen.has(node)) continue
    seen.add(node)
    stack.push(...(links.get(node) ?? []))
  }
  return false
}

/**
 * The flows a Sankey diagram draws: rows with the same source and target
 * added together exactly, the largest `limit` kept, and flows that would loop
 * back (a Sankey diagram cannot draw a cycle) or carry no positive value left out.
 */
export function sankeyData(config: SankeyConfig, result: QueryResult, limit = SANKEY_LINKS): SankeyData {
  const source = columnOf(result, config.sourceColumn)
  const target = columnOf(result, config.targetColumn)
  const value = columnOf(result, config.valueColumn)
  const sums = new Map<string, { from: string; to: string; exact: Decimal }>()
  let unusable = 0
  let selfLinks = 0
  for (const row of result.rows) {
    const from = row[source.index] ?? null
    const to = row[target.index] ?? null
    const amount = parseDecimal(row[value.index] ?? null)
    if (from === null || to === null || isMissing(from) || isMissing(to) || !amount || amount.units <= 0n) {
      unusable += 1
      continue
    }
    const fromName = displayCell(from, source.column).text
    const toName = displayCell(to, target.column).text
    if (fromName === toName) {
      selfLinks += 1
      continue
    }
    const key = JSON.stringify([fromName, toName])
    const found = sums.get(key)
    sums.set(key, { from: fromName, to: toName, exact: found ? addDecimal(found.exact, amount) : amount })
  }
  const flows = [...sums.values()]
    // A sum too large to plot draws as the largest number there is; its exact value stays in the tooltip.
    .map((flow) => ({ ...flow, value: decimalNumber(flow.exact) ?? Number.MAX_VALUE }))
    .sort((a, b) => b.value - a.value)

  const notes: string[] = []
  if (unusable > 0) {
    notes.push(
      `${count(unusable, "row")} without a source, a target, or a positive value ${unusable === 1 ? "is" : "are"} left out.`,
    )
  }
  if (selfLinks > 0)
    notes.push(
      `${count(selfLinks, "row")} flowing back into the same node ${selfLinks === 1 ? "is" : "are"} left out.`,
    )
  const kept = flows.slice(0, limit)
  if (flows.length > limit) notes.push(`Showing the ${limit} largest of ${count(flows.length, "flow")}.`)

  const outgoing = new Map<string, Set<string>>()
  const names: string[] = []
  const indexOf = (name: string) => {
    const found = names.indexOf(name)
    return found >= 0 ? found : names.push(name) - 1
  }
  const links: SankeyLink[] = []
  let loops = 0
  for (const flow of kept) {
    if (reaches(outgoing, flow.to, flow.from)) {
      loops += 1
      continue
    }
    outgoing.set(flow.from, new Set([...(outgoing.get(flow.from) ?? []), flow.to]))
    links.push({ source: indexOf(flow.from), target: indexOf(flow.to), value: flow.value, exact: flow.exact })
  }
  if (loops > 0)
    notes.push(`${count(loops, "flow")} that would loop back ${loops === 1 ? "is" : "are"} left out.`)
  const through = (index: number) => {
    const sum = (side: "source" | "target") =>
      links
        .filter((link) => link[side] === index)
        .reduce<Decimal>((total, link) => addDecimal(total, link.exact), { units: 0n, scale: 0 })
    const inflow = sum("target")
    const outflow = sum("source")
    return (decimalNumber(inflow) ?? Infinity) >= (decimalNumber(outflow) ?? Infinity) ? inflow : outflow
  }
  return { nodes: names.map((name, index) => ({ name, exact: through(index) })), links, notes }
}

// Tickers and gauges ---------------------------------------------------------------

export interface TickerItem {
  key: string
  label: string
  /** The value as configured, or a short reason there is none. */
  value: string
  /** The stored value, when formatting changed how it reads. */
  exact: string | null
  delta: { text: string; direction: "up" | "down" | "flat" } | null
}

/** A ticker's items, one per row: label, formatted value, and the signed change when a delta column is set. */
export function tickerItems(config: TickerConfig, result: QueryResult): TickerItem[] {
  const label = columnOf(result, config.labelColumn)
  const value = columnOf(result, config.valueColumn)
  const delta = config.deltaColumn === null ? null : columnOf(result, config.deltaColumn)
  return result.rows.map((row, index) => {
    const cell = row[value.index] ?? null
    const shown = describeNumber(cell, undefined, { ...config, comparisonColumn: null })
    const change = delta ? parseDecimal(row[delta.index] ?? null) : null
    return {
      key: String(index),
      label: displayCell(row[label.index] ?? null, label.column).text,
      value: shown.kind === "value" ? shown.text : shown.kind === "empty" ? "No value" : "Not a number",
      exact: shown.kind === "value" && shown.exact !== shown.text ? shown.exact : null,
      delta: change
        ? {
            text: formatDecimal(change, config, true),
            direction: change.units > 0n ? "up" : change.units < 0n ? "down" : "flat",
          }
        : null,
    }
  })
}

export type GaugeReading =
  | {
      kind: "value"
      text: string
      exact: string
      /** Where the value sits between min and max, from 0 to 1. */
      ratio: number
      /** The status of the highest threshold the value reaches, if any. */
      status: ThresholdStatus | null
      outside: "below" | "above" | null
    }
  | { kind: "empty"; message: string }
  | { kind: "invalid"; message: string }

/** Where the value sits on the gauge's scale, and its status. */
export function gaugeReading(config: GaugeConfig, result: QueryResult): GaugeReading {
  const row = result.rows[0]
  if (!row) {
    return {
      kind: "empty",
      message:
        result.rowCount > 0 ? "The first row is too large to show here." : "The latest result has no rows.",
    }
  }
  const cell = row[columnOf(result, config.valueColumn).index] ?? null
  const shown = describeNumber(cell, undefined, { ...config, comparisonColumn: null })
  if (shown.kind !== "value") return shown
  // A value too large for a float sits beyond the end of the scale its sign points to.
  const value = plotNumber(cell) ?? (String(cell).trim().startsWith("-") ? -Infinity : Infinity)
  const reached = config.thresholds.filter((threshold) => value >= threshold.value)
  return {
    kind: "value",
    text: shown.text,
    exact: shown.exact,
    ratio: Math.min(1, Math.max(0, (value - config.min) / (config.max - config.min))),
    status: reached.at(-1)?.status ?? null,
    outside: value < config.min ? "below" : value > config.max ? "above" : null,
  }
}

/** A gauge bound or threshold as the gauge writes it. */
export function formatBound(value: number, style: NumberStyle): string {
  const exact = parseDecimal(value)
  return exact ? formatDecimal(exact, style) : String(value)
}

// Text alternatives -------------------------------------------------------------------

/** One sentence describing a bar or line chart, for assistive technology. */
export function seriesSummary(kind: "bar" | "line", config: SeriesConfig, data: SeriesData): string {
  const chart = kind === "bar" ? "Bar chart" : "Line chart"
  const what = `${chart} of ${data.series.join(", ")} by ${config.xColumn}`
  if (data.points.length === 0) return `${what}: no rows to show.`
  const first = data.series[0] ?? ""
  const values = data.points.flatMap((point) =>
    point.values[0] === null ? [] : [{ point, value: point.values[0] ?? 0 }],
  )
  const unit =
    kind === "bar" ? count(data.points.length, "category", "categories") : count(data.points.length, "point")
  if (values.length === 0) return `${what}: ${unit}, none with a value.`
  const highest = values.reduce((best, item) => (item.value > best.value ? item : best))
  const lowest = values.reduce((best, item) => (item.value < best.value ? item : best))
  const say = (item: { point: SeriesPoint }) =>
    `${item.point.label} (${formatExact(item.point.exact[0] ?? null, config)})`
  const range = kind === "line" ? ` from ${data.points[0]?.label} to ${data.points.at(-1)?.label}` : ""
  return `${what}: ${unit}${range}. Highest ${first}: ${say(highest)}; lowest: ${say(lowest)}.`
}

/** One sentence describing a Sankey diagram, for assistive technology. */
export function sankeySummary(data: SankeyData): string {
  const largest = data.links[0]
  if (!largest) return "Sankey diagram: no flows to show."
  const name = (index: number) => data.nodes[index]?.name ?? ""
  return `Sankey diagram of ${count(data.links.length, "flow")} between ${count(data.nodes.length, "node")}; the largest is ${name(largest.source)} to ${name(largest.target)} (${formatExact(largest.exact, EXACT)}).`
}
