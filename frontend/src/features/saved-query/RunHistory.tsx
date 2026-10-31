import { useId } from "react"
import { Link } from "react-router-dom"

import { CsvDownloadButton } from "@/entities/queries/CsvDownloadButton.tsx"
import { STATUS_LABELS } from "@/entities/queries/run-outcome.ts"
import { QUERY_LIMITS, type ExecutionSummary } from "@/entities/queries/types.ts"
import { useSavedQueryRuns } from "@/entities/saved-queries/api.ts"
import { formatParameterValue } from "@/entities/saved-queries/parameters.ts"
import type { SavedQueryDetail } from "@/entities/saved-queries/types.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button } from "@/shared/ui/button.tsx"

function outcomeOf(run: ExecutionSummary): string {
  const parts: string[] = []
  if (run.rowCount !== null) {
    parts.push(`${run.rowCount.toLocaleString("en-US")} ${run.rowCount === 1 ? "row" : "rows"}`)
  }
  if (run.durationMs !== null) parts.push(`${run.durationMs.toLocaleString("en-US")} ms`)
  return parts.join(" · ")
}

/** Every run of a saved query, newest first, with the values it ran with. */
export function RunHistory({
  workspaceId,
  savedQuery,
}: {
  workspaceId: string
  savedQuery: SavedQueryDetail
}) {
  const headingId = useId()
  const runs = useSavedQueryRuns(workspaceId, savedQuery.id)
  const listed = runs.data?.pages.flatMap((page) => page.runs) ?? []
  const labels = new Map(savedQuery.parameters.map((parameter) => [parameter.name, parameter.label]))

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h2 id={headingId} className="text-base font-semibold tracking-tight">
        Run history
      </h2>
      {runs.isPending && <p className="text-sm text-(--muted)">Loading runs…</p>}
      {runs.isLoadingError && (
        <p role="alert" className="text-sm text-(--danger)">
          Runs could not be loaded: {runs.error.message}
        </p>
      )}
      {runs.isSuccess && listed.length === 0 && <p className="text-sm text-(--muted)">No runs yet.</p>}
      {listed.length > 0 && (
        <ul className="divide-y divide-(--border) rounded-lg border border-(--border)">
          {listed.map((run) => {
            const status = STATUS_LABELS[run.status]
            const when = formatRelativeTime(run.createdAt)
            const outcome = outcomeOf(run)
            const values = Object.entries(run.parameters ?? {}).map(
              ([name, value]) =>
                `${labels.get(name) ?? name}: ${value === null ? "none" : formatParameterValue(value)}`,
            )
            return (
              <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <Badge tone={status.tone}>{status.label}</Badge>
                <span className="min-w-0 flex-1 basis-48 text-xs text-(--muted)">
                  {values.length > 0 ? values.join(" · ") : "No parameters"}
                </span>
                <span className="text-xs text-(--muted)">
                  {outcome && `${outcome} · `}
                  <time dateTime={run.createdAt} title={new Date(run.createdAt).toLocaleString()}>
                    {when}
                  </time>
                </span>
                {run.status === "succeeded" && (
                  <CsvDownloadButton
                    workspaceId={workspaceId}
                    connectionId={run.connectionId}
                    executionId={run.id}
                    name={savedQuery.name}
                    createdAt={run.createdAt}
                    partial={run.truncated || (run.rowCount ?? 0) > QUERY_LIMITS.snapshotRows}
                  />
                )}
                <Link
                  to={`/sources/${encodeURIComponent(run.connectionId)}/queries/${encodeURIComponent(run.id)}`}
                  aria-label={`Open the ${status.label.toLowerCase()} run from ${when}`}
                  className="rounded-md px-2 py-1 text-xs font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
                >
                  Open
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      {runs.hasNextPage && (
        <Button
          variant="secondary"
          disabled={runs.isFetchingNextPage}
          onClick={() => void runs.fetchNextPage()}
        >
          {runs.isFetchingNextPage ? "Loading…" : "Show older runs"}
        </Button>
      )}
      {runs.isFetchNextPageError && (
        <p role="alert" className="text-sm text-(--danger)">
          Older runs could not be loaded. {runs.error.message}
        </p>
      )}
    </section>
  )
}
