import { useState } from "react"

import { cn } from "@/shared/lib/cn.ts"

import { describeResult, displayCell, isNumericColumn, truncationNotice } from "./cells.ts"
import type { QueryResult } from "./types.ts"

/** Rows rendered at first; more appear on request so large results stay responsive. */
const PAGE_ROWS = 200

/**
 * The rows behind a query, as any feature shows them: one column per result
 * column (duplicates included), exact numbers right-aligned, NULL and missing
 * labelled, and horizontal scrolling on narrow screens.
 */
export function ResultTable({
  result,
  partial = false,
  label,
}: {
  result: QueryResult
  /** A stored snapshot holding only the first rows the query returned. */
  partial?: boolean
  /** Names the table for assistive technology, e.g. "Query result". */
  label: string
}) {
  const notice = truncationNotice(result)

  return (
    <div className="space-y-2">
      <p className="text-sm text-(--muted)">{describeResult(result, partial)}</p>
      {notice && <ResultNotice>{notice}</ResultNotice>}
      <ResultRows columns={result.columns} rows={result.rows} label={label} />
    </div>
  )
}

/** Why a result is incomplete, shown above its rows. */
export function ResultNotice({ children }: { children: string }) {
  return (
    <p
      role="note"
      className="rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-sm leading-6 text-(--warning)"
    >
      {children}
    </p>
  )
}

/** The table of a result's rows, for callers that describe the result themselves. */
export function ResultRows({
  columns,
  rows,
  label,
}: Pick<QueryResult, "columns" | "rows"> & { label: string }) {
  const [shown, setShown] = useState(PAGE_ROWS)
  const visible = rows.slice(0, shown)

  return (
    <>
      {columns.length === 0 ? (
        <p className="text-sm text-(--muted)">The query returned no columns.</p>
      ) : (
        // Focusable so keyboard users can scroll it.
        <div
          role="region"
          aria-label={`${label} (scrollable)`}
          tabIndex={0}
          className="max-h-[32rem] overflow-auto rounded-lg border border-(--border) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          <table aria-label={label} className="w-full border-collapse text-left text-sm">
            <thead className="sticky top-0 bg-(--surface) text-xs text-(--muted)">
              <tr>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="sr-only">Row</span>#
                </th>
                {columns.map((column, index) => (
                  <th
                    key={index}
                    scope="col"
                    className={cn(
                      "px-3 py-2 align-bottom font-medium whitespace-nowrap",
                      isNumericColumn(column) && "text-right",
                    )}
                  >
                    <span className="block text-(--foreground)">{column.name}</span>
                    <span className="block font-normal">{column.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-(--border) align-top">
                  <td className="px-3 py-1.5 text-right text-xs text-(--muted) tabular-nums">{rowIndex + 1}</td>
                  {columns.map((column, index) => {
                    const cell = displayCell(row[index] ?? null, column)
                    return (
                      <td
                        key={index}
                        title={cell.title}
                        className={cn(
                          "max-w-md px-3 py-1.5 break-words",
                          cell.align === "right" && "text-right tabular-nums whitespace-nowrap",
                          (column.kind === "json" || column.kind === "binary" || column.kind === "id") &&
                            cell.tone === "value" &&
                            "font-mono text-xs",
                          cell.tone === "null" && "text-xs font-medium tracking-wide text-(--muted)",
                          cell.tone === "missing" && "text-xs text-(--muted) italic",
                        )}
                      >
                        {cell.text}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length === 0 && columns.length > 0 && <p className="text-sm text-(--muted)">No rows matched.</p>}
      {rows.length > shown && (
        <button
          type="button"
          onClick={() => setShown((count) => count + PAGE_ROWS * 5)}
          className="rounded-md text-sm font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          Show more rows ({(rows.length - shown).toLocaleString("en-US")} not shown yet)
        </button>
      )}
    </>
  )
}
