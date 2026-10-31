import { BarChart3, Info, Table2 } from "lucide-react"
import { Suspense, useState, type ReactNode } from "react"

import { truncationNotice } from "@/entities/queries/cells.ts"
import type { QueryResult } from "@/entities/queries/types.ts"

/** The rows behind a chart, as a table: its text alternative. */
export function ChartTable({
  label,
  headers,
  rows,
}: {
  label: string
  headers: { text: string; numeric: boolean }[]
  rows: { key: string; cells: string[] }[]
}) {
  return (
    // Focusable so keyboard users can scroll it.
    <div
      role="region"
      aria-label={`${label} (scrollable)`}
      tabIndex={0}
      className="h-full overflow-auto rounded-md border border-(--border) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
    >
      <table aria-label={label} className="w-full border-collapse text-left text-sm">
        <thead className="sticky top-0 bg-(--surface) text-xs text-(--muted)">
          <tr>
            {headers.map((header, index) => (
              <th
                key={index}
                scope="col"
                className={`px-3 py-1.5 font-medium ${header.numeric ? "text-right" : ""}`}
              >
                {header.text}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-(--border)">
              {row.cells.map((cell, index) => (
                <td
                  key={index}
                  className={`px-3 py-1.5 align-top break-words ${headers[index]?.numeric ? "text-right tabular-nums" : ""}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Why a chart shows fewer rows than the query matched: the panel's cut, and the query's own limit. */
export function resultNotes(result: QueryResult): string[] {
  const notes: string[] = []
  if (result.rows.length < result.rowCount) {
    const shown = result.rows.length.toLocaleString("en-US")
    notes.push(`Showing the first ${shown} of ${result.rowCount.toLocaleString("en-US")} rows.`)
  }
  const truncated = truncationNotice(result)
  if (truncated) notes.push(truncated)
  return notes
}

/**
 * A chart with its text alternatives: a one-sentence summary for assistive
 * technology, visible notes on what it leaves out, and a table view of the
 * same values. The chart itself takes keyboard focus, and arrow keys move
 * its tooltip from point to point. `chart` may load lazily.
 */
export function ChartFrame({
  summary,
  notes,
  table,
  chart,
}: {
  summary: string
  notes: string[]
  table: ReactNode
  chart: ReactNode
}) {
  const [asTable, setAsTable] = useState(false)
  return (
    <figure className="flex h-full min-h-0 flex-col gap-1.5">
      <figcaption className="sr-only">{summary}</figcaption>
      {notes.length > 0 && (
        <ul className="space-y-0.5 text-xs leading-5 text-(--muted)">
          {notes.map((note) => (
            <li key={note} className="flex gap-1.5">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {note}
            </li>
          ))}
        </ul>
      )}
      <div className="min-h-0 flex-1">
        {asTable ? (
          table
        ) : (
          <Suspense fallback={<p className="text-sm text-(--muted)">Loading the chart…</p>}>{chart}</Suspense>
        )}
      </div>
      <div>
        <button
          type="button"
          aria-pressed={asTable}
          onClick={() => setAsTable(!asTable)}
          className="inline-flex items-center gap-1 rounded text-xs font-medium text-(--accent) hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          {asTable ? (
            <BarChart3 aria-hidden className="size-3.5" />
          ) : (
            <Table2 aria-hidden className="size-3.5" />
          )}
          {asTable ? "View as chart" : "View as table"}
        </button>
      </div>
    </figure>
  )
}
