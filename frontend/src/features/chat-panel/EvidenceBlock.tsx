import { ExternalLink } from "lucide-react"
import { useId, type ReactNode } from "react"
import { Link } from "react-router-dom"

import type { EvidenceItem } from "@/entities/agent/types.ts"
import { CsvDownloadButton } from "@/entities/queries/CsvDownloadButton.tsx"
import { queryKind, queryText } from "@/entities/queries/query-text.ts"
import { ResultNotice, ResultRows } from "@/entities/queries/ResultTable.tsx"
import { QUERY_LIMITS } from "@/entities/queries/types.ts"
import { CopyButton } from "@/shared/ui/copy-button.tsx"

const count = (value: number) => `${value.toLocaleString("en-US")} ${value === 1 ? "row" : "rows"}`

/**
 * An execution an answer cites: what it supports, the query as run, its first
 * rows, and a CSV of its stored rows, plus any action the screen adds.
 */
export function EvidenceBlock({
  workspaceId,
  item,
  sourceName,
  createdAt,
  action,
}: {
  workspaceId: string
  item: EvidenceItem
  sourceName: string | null
  /** When the answer was given, for the downloaded file's name. */
  createdAt: string
  /** E.g. "Save as query". */
  action?: ReactNode
}) {
  const id = useId()
  const text = queryText(item.query)
  const shown =
    item.rows.length < item.rowCount
      ? `First ${item.rows.length.toLocaleString("en-US")} of ${count(item.rowCount)}`
      : count(item.rowCount)

  return (
    <section
      aria-labelledby={id}
      className="min-w-0 space-y-3 rounded-lg border border-(--border) bg-white p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 id={id} className="min-w-0 text-sm font-semibold break-words">
          {item.label}
        </h4>
        <Link
          to={`/sources/${encodeURIComponent(item.connectionId)}/queries/${encodeURIComponent(item.executionId)}`}
          className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          Open the query run
          <ExternalLink aria-hidden className="size-3.5" />
        </Link>
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xs text-(--muted)">
            {queryKind(item.query)}
            {sourceName ? ` on ${sourceName}` : ""}
          </p>
          <CopyButton text={text} label={`the query for “${item.label}”`} />
        </div>
        <pre className="max-h-64 overflow-auto rounded-md bg-(--surface) p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words">
          <code>{text}</code>
        </pre>
      </div>
      <div className="space-y-2">
        <p className="text-sm text-(--muted)">
          {shown}
          {item.rows.length < item.rowCount ? " · open the query run for the stored rows" : ""}
        </p>
        {item.truncated && (
          <ResultNotice>
            The query stopped at its row or size limit, so more rows matched than it returned.
          </ResultNotice>
        )}
        <ResultRows columns={item.columns} rows={item.rows} label={`Rows behind “${item.label}”`} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <CsvDownloadButton
          workspaceId={workspaceId}
          connectionId={item.connectionId}
          executionId={item.executionId}
          name={item.label}
          createdAt={createdAt}
          partial={item.truncated || item.rowCount > QUERY_LIMITS.snapshotRows}
        />
        {action}
      </div>
    </section>
  )
}
