import { lazy, useMemo } from "react"

import type { QueryResult } from "@/entities/queries/types.ts"

import { buildSeries, formatExact, seriesSummary } from "../chart-data.ts"
import type { SeriesConfig } from "../types.ts"
import { ChartFrame, ChartTable, resultNotes } from "./ChartFrame.tsx"
import { SERIES_COLORS } from "./colors.ts"

const SeriesChart = lazy(() =>
  import("./SeriesChart.tsx").then((module) => ({ default: module.SeriesChart })),
)

/** Names each series beside a mark like its own: a square for bars and areas, a stroke for lines. */
function Legend({ series, mark }: { series: string[]; mark: "square" | "line" }) {
  return (
    <ul aria-label="Legend" className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-(--foreground)">
      {series.map((name, index) => (
        <li key={name} className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={mark === "square" ? "size-2.5 shrink-0 rounded-sm" : "h-0.5 w-3 shrink-0 rounded-full"}
            style={{ background: SERIES_COLORS[index] }}
          />
          <span className="truncate">{name}</span>
        </li>
      ))}
    </ul>
  )
}

/** A bar or line chart panel: notes on what it leaves out, a legend for several series, and a table view. */
export function SeriesPanel({
  kind,
  config,
  result,
  label,
}: {
  kind: "bar" | "line"
  config: SeriesConfig
  result: QueryResult
  label: string
}) {
  const data = useMemo(() => buildSeries(kind, config, result), [kind, config, result])
  if (data.points.length === 0) {
    return (
      <p className="text-sm text-(--muted)">
        {result.rowCount === 0 ? "The latest result has no rows." : "No row has an x value to chart."}
      </p>
    )
  }
  const summary = seriesSummary(kind, config, data)
  return (
    <ChartFrame
      summary={summary}
      notes={[...resultNotes(result), ...data.notes]}
      table={
        <ChartTable
          label={`${label}: values`}
          headers={[
            { text: config.xColumn, numeric: false },
            ...data.series.map((name) => ({ text: name, numeric: true })),
          ]}
          rows={data.points.map((point) => ({
            key: point.key,
            cells: [point.label, ...point.exact.map((value) => formatExact(value, config))],
          }))}
        />
      }
      chart={
        <div className="flex h-full flex-col gap-1">
          {data.series.length > 1 && (
            <Legend series={data.series} mark={kind === "line" && !config.stacked ? "line" : "square"} />
          )}
          <div className="min-h-0 flex-1">
            <SeriesChart kind={kind} config={config} data={data} title={summary} />
          </div>
        </div>
      }
    />
  )
}
