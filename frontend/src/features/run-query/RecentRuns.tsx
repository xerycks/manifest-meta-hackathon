import { useId } from "react"

import { useQueryHistory } from "@/entities/queries/api.ts"
import type { ExecutionSummary } from "@/entities/queries/types.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button } from "@/shared/ui/button.tsx"

import { queryPreview } from "./query-draft.ts"
import { STATUS_LABELS } from "./run-outcome.ts"

function outcomeOf(run: ExecutionSummary): string {
  const parts: string[] = []
  if (run.rowCount !== null) {
    parts.push(`${run.rowCount.toLocaleString("en-US")} ${run.rowCount === 1 ? "row" : "rows"}`)
  }
  if (run.durationMs !== null) parts.push(`${run.durationMs.toLocaleString("en-US")} ms`)
  return parts.join(" · ")
}

/** The latest runs on a source; opening one shows its stored result and restores its query. */
export function RecentRuns({
  workspaceId,
  connectionId,
  openId,
  onOpen,
}: {
  workspaceId: string
  connectionId: string
  openId: string | null
  onOpen: (run: ExecutionSummary) => void
}) {
  const headingId = useId()
  const history = useQueryHistory(workspaceId, connectionId)

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-sm font-semibold">
        Recent runs
      </h3>
      {history.isPending && <p className="text-sm text-(--muted)">Loading recent runs…</p>}
      {history.isError && (
        <p role="alert" className="text-sm text-(--danger)">
          Recent runs could not be loaded: {history.error.message}
        </p>
      )}
      {history.isSuccess && history.data.length === 0 && (
        <p className="text-sm text-(--muted)">No queries have run on this source yet.</p>
      )}
      {history.isSuccess && history.data.length > 0 && (
        <ul className="divide-y divide-(--border) rounded-lg border border-(--border)">
          {history.data.map((run) => {
            const status = STATUS_LABELS[run.status]
            const when = formatRelativeTime(run.createdAt)
            const outcome = outcomeOf(run)
            return (
              <li
                key={run.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
                aria-current={run.id === openId ? "true" : undefined}
              >
                <Badge tone={status.tone}>{status.label}</Badge>
                <code className="min-w-0 flex-1 basis-48 truncate text-xs" title={queryPreview(run.query, 2_000)}>
                  {queryPreview(run.query)}
                </code>
                <span className="text-xs text-(--muted)">
                  {outcome && `${outcome} · `}
                  <time dateTime={run.createdAt} title={new Date(run.createdAt).toLocaleString()}>
                    {when}
                  </time>
                </span>
                <Button
                  variant="ghost"
                  className="px-2 py-1"
                  onClick={() => onOpen(run)}
                  aria-label={`Open the ${status.label.toLowerCase()} run from ${when}`}
                >
                  Open
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
