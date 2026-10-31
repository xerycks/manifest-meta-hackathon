import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react"

import { ResultTable } from "@/entities/queries/ResultTable.tsx"
import type { QueryResult } from "@/entities/queries/types.ts"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Markdown } from "@/shared/ui/markdown.tsx"

import { GaugePanel } from "./charts/GaugePanel.tsx"
import { SankeyPanel } from "./charts/SankeyPanel.tsx"
import { SeriesPanel } from "./charts/SeriesPanel.tsx"
import { TickerPanel } from "./charts/TickerPanel.tsx"
import { describeNumber } from "./number-format.ts"
import { columnProblem, numberCells, shownResult } from "./panel-config.ts"
import type { NumberConfig, PanelDefinition } from "./types.ts"

const DIRECTION_ICONS = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight }

function NumberValue({ config, result }: { config: NumberConfig; result: QueryResult }) {
  const cells = numberCells(config, result)
  if (!cells) {
    // The row can also be left out because it is larger than a panel carries.
    return (
      <p className="text-sm text-(--muted)">
        {result.rowCount > 0
          ? "The first row is too large to show here; open the saved query to see it."
          : "The latest result has no rows."}
      </p>
    )
  }
  const shown = describeNumber(cells.value, cells.comparison, config)
  if (shown.kind === "empty") return <p className="text-sm text-(--muted)">{shown.message}</p>
  if (shown.kind === "invalid") return <FailureNotice title="Not a number" message={shown.message} />
  const Icon = shown.delta ? DIRECTION_ICONS[shown.delta.direction] : null
  return (
    <div className="space-y-1">
      <p
        className="text-3xl font-semibold tracking-tight tabular-nums wrap-anywhere"
        title={shown.exact !== shown.text ? `Stored value: ${shown.exact}` : undefined}
      >
        {shown.text}
      </p>
      {shown.delta && Icon && (
        <p className="flex flex-wrap items-center gap-1 text-sm text-(--muted)">
          <Icon aria-hidden className="size-4 shrink-0" />
          <span className="font-medium text-(--foreground) tabular-nums">{shown.delta.text}</span>
          {shown.delta.change && <span className="tabular-nums">({shown.delta.change})</span>}
          <span>vs {config.comparisonColumn}</span>
        </p>
      )}
    </div>
  )
}

/**
 * A panel's content: a Markdown panel's text, or a query panel's number,
 * table, or chart from a result, filling the space it is given. A config
 * that no longer fits the result's columns says so instead of showing
 * something wrong.
 */
export function PanelBody({
  panel,
  result,
  label,
}: {
  panel: PanelDefinition
  /** The saved query's latest result; query panels show nothing without one. */
  result: QueryResult | null
  /** Names tables and charts for assistive technology. */
  label: string
}) {
  if (panel.kind === "markdown") return <Markdown>{panel.config.body}</Markdown>
  if (!result) return null
  const problem = columnProblem(panel, result.columns)
  if (problem) {
    return (
      <FailureNotice
        title="The saved query's columns changed"
        message={`${problem.message} Edit the panel to choose from the columns it returns now.`}
      />
    )
  }
  const shown = shownResult(panel, result)
  switch (panel.kind) {
    case "number":
      return <NumberValue config={panel.config} result={result} />
    case "table":
      return <ResultTable result={shown} partial={shown.rows.length < shown.rowCount} label={label} />
    case "bar":
    case "line":
      return <SeriesPanel kind={panel.kind} config={panel.config} result={shown} label={label} />
    case "gauge":
      return <GaugePanel config={panel.config} result={shown} />
    case "ticker":
      return <TickerPanel config={panel.config} result={shown} label={label} />
    case "sankey":
      return <SankeyPanel config={panel.config} result={shown} label={label} />
  }
}
