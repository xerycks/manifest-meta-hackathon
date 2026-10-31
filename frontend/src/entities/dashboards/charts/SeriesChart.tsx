import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts"

import { axisNumber, formatExact, formatTime, type SeriesData } from "../chart-data.ts"
import type { SeriesConfig } from "../types.ts"
import { SERIES_COLORS, SURFACE } from "./colors.ts"

/** Points a line marks with dots; denser lines show a dot only where the pointer is. */
const DOTTED_POINTS = 40

const TICK = { fill: "var(--muted)", fontSize: 12 }

interface Row {
  index: number
  label: string
  position: number | null
  [series: `s${number}`]: number | null
}

/** Values lead and series names follow, each keyed by a short stroke of its colour. */
function ChartTooltip({
  active,
  payload,
  data,
  config,
}: Pick<TooltipContentProps, "active" | "payload"> & { data: SeriesData; config: SeriesConfig }) {
  const row = payload?.[0]?.payload as Row | undefined
  const point = row ? data.points[row.index] : undefined
  if (!active || !point) return null
  return (
    <div className="max-w-64 rounded-md border border-(--border) bg-white px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium break-words">{point.label}</p>
      <ul className="space-y-0.5">
        {data.series.map((name, index) => (
          <li key={name} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-0.5 w-3 shrink-0 rounded-full"
              style={{ background: SERIES_COLORS[index] }}
            />
            <span className="font-semibold tabular-nums">
              {formatExact(point.exact[index] ?? null, config)}
            </span>
            <span className="min-w-0 truncate text-(--muted)">{name}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A bar or line chart with one value axis: thin bars rounded at their ends,
 * 2px lines, a recessive grid, compact ticks, and a tooltip with the exact
 * values. Recharts is heavy, so this module loads only when a chart shows.
 */
export function SeriesChart({
  kind,
  config,
  data,
  title,
}: {
  kind: "bar" | "line"
  config: SeriesConfig
  data: SeriesData
  /** Names the chart for assistive technology. */
  title: string
}) {
  const rows: Row[] = data.points.map((point, index) => {
    const row: Row = { index, label: point.label, position: point.position }
    point.values.forEach((value, series) => {
      row[`s${series}`] = value
    })
    return row
  })
  const timeAxis = data.axis === "time"
  const xAxis = (
    <XAxis
      dataKey={data.axis === "category" ? "label" : "position"}
      type={data.axis === "category" ? "category" : "number"}
      domain={data.axis === "category" ? undefined : ["dataMin", "dataMax"]}
      scale={timeAxis ? "time" : "auto"}
      tickFormatter={
        timeAxis
          ? (value: number) => formatTime(value, config.xFormat, data.xKind)
          : data.axis === "number"
            ? (value: number) => axisNumber(value, { format: "number", decimals: null, currency: null })
            : undefined
      }
      tick={TICK}
      tickLine={false}
      axisLine={{ stroke: "var(--chart-axis)" }}
      interval="preserveStartEnd"
      minTickGap={16}
    />
  )
  const yAxis = (
    <YAxis
      width="auto"
      tick={TICK}
      tickLine={false}
      axisLine={false}
      tickFormatter={(value: number) => axisNumber(value, config)}
    />
  )
  const grid = <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
  const tooltip = (
    <Tooltip
      content={(props) => (
        <ChartTooltip active={props.active} payload={props.payload} data={data} config={config} />
      )}
      cursor={kind === "bar" ? { fill: "var(--surface)" } : { stroke: "var(--chart-axis)", strokeWidth: 1 }}
      isAnimationActive={false}
    />
  )
  const margin = { top: 8, right: 12, bottom: 0, left: 0 }
  const last = data.series.length - 1

  return (
    <ResponsiveContainer width="100%" height="100%" minHeight={120}>
      {kind === "bar" ? (
        <BarChart data={rows} margin={margin} barGap={2} barCategoryGap="20%" title={title}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {data.series.map((name, index) => (
            <Bar
              key={name}
              dataKey={`s${index}`}
              name={name}
              fill={SERIES_COLORS[index]}
              maxBarSize={24}
              // Rounded at the data end, square at the baseline; a stack rounds only its top.
              radius={!config.stacked || index === last ? [4, 4, 0, 0] : 0}
              {...(config.stacked ? { stackId: "stack", stroke: SURFACE, strokeWidth: 2 } : {})}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      ) : config.stacked ? (
        <AreaChart data={rows} margin={margin} title={title}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {data.series.map((name, index) => (
            <Area
              key={name}
              type="linear"
              dataKey={`s${index}`}
              name={name}
              stackId="stack"
              stroke={SERIES_COLORS[index]}
              strokeWidth={2}
              fill={SERIES_COLORS[index]}
              fillOpacity={0.1}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      ) : (
        <LineChart data={rows} margin={margin} title={title}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {data.series.map((name, index) => (
            <Line
              key={name}
              type="linear"
              dataKey={`s${index}`}
              name={name}
              stroke={SERIES_COLORS[index]}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={
                rows.length <= DOTTED_POINTS
                  ? { r: 4, fill: SERIES_COLORS[index], stroke: SURFACE, strokeWidth: 2 }
                  : false
              }
              activeDot={{ r: 5, fill: SERIES_COLORS[index], stroke: SURFACE, strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      )}
    </ResponsiveContainer>
  )
}
