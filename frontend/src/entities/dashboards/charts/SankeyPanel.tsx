import { lazy, useMemo } from "react"

import type { QueryResult } from "@/entities/queries/types.ts"

import { formatExact, sankeyData, sankeySummary } from "../chart-data.ts"
import type { SankeyConfig } from "../types.ts"
import { ChartFrame, ChartTable, resultNotes } from "./ChartFrame.tsx"

const SankeyChart = lazy(() =>
  import("./SankeyChart.tsx").then((module) => ({ default: module.SankeyChart })),
)

const EXACT = { format: "number", decimals: null, currency: null } as const

/** A Sankey panel: its largest flows, notes on what it leaves out, and a table of the flows. */
export function SankeyPanel({
  config,
  result,
  label,
}: {
  config: SankeyConfig
  result: QueryResult
  label: string
}) {
  const data = useMemo(() => sankeyData(config, result), [config, result])
  const notes = [...resultNotes(result), ...data.notes]
  if (data.links.length === 0) {
    return (
      <div className="space-y-1 text-sm text-(--muted)">
        <p>{result.rowCount === 0 ? "The latest result has no rows." : "No row has a flow to draw."}</p>
        {notes.map((note) => (
          <p key={note} className="text-xs">
            {note}
          </p>
        ))}
      </div>
    )
  }
  const summary = sankeySummary(data)
  const name = (index: number) => data.nodes[index]?.name ?? ""
  return (
    <ChartFrame
      summary={summary}
      notes={notes}
      table={
        <ChartTable
          label={`${label}: flows`}
          headers={[
            { text: config.sourceColumn, numeric: false },
            { text: config.targetColumn, numeric: false },
            { text: config.valueColumn, numeric: true },
          ]}
          rows={data.links.map((link) => ({
            key: `${link.source}-${link.target}`,
            cells: [name(link.source), name(link.target), formatExact(link.exact, EXACT)],
          }))}
        />
      }
      chart={<SankeyChart data={data} title={summary} />}
    />
  )
}
