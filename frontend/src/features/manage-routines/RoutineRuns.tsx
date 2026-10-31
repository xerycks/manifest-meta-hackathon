import { ExternalLink } from "lucide-react"
import { useMemo } from "react"
import { Link } from "react-router-dom"

import { useRoutineRuns } from "@/entities/routines/api.ts"
import { formatInZone, runStatus, runTime, TRIGGER_LABELS } from "@/entities/routines/status.ts"
import type { RoutineDetail, RoutineRun } from "@/entities/routines/types.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button } from "@/shared/ui/button.tsx"
import { Card } from "@/shared/ui/card.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { ErrorState } from "@/shared/ui/states.tsx"

const LINK =
  "inline-flex items-center gap-1 rounded-md text-sm font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"

/** Where a run's result can be opened: its query run, or the answer in the owner's conversation. */
function RunResult({ routine, run }: { routine: RoutineDetail; run: RoutineRun }) {
  if (run.execution) {
    const { connectionId, id } = run.execution
    return (
      <Link
        to={`/sources/${encodeURIComponent(connectionId)}/queries/${encodeURIComponent(id)}`}
        className={LINK}
      >
        Open the query run
        <ExternalLink aria-hidden className="size-3.5" />
      </Link>
    )
  }
  if (run.conversationId) {
    return (
      <Link to={`/ask/${encodeURIComponent(run.conversationId)}`} className={LINK}>
        Open the answer
        <ExternalLink aria-hidden className="size-3.5" />
      </Link>
    )
  }
  if (routine.kind === "question" && run.agentRunId) {
    return <span className="text-xs text-(--muted)">In the owner's conversation, which only they can open</span>
  }
  if (routine.savedQuery?.state === "private" && run.status === "succeeded") {
    return <span className="text-xs text-(--muted)">The result is private to the saved query's owner</span>
  }
  return null
}

function RunItem({ routine, run }: { routine: RoutineDetail; run: RoutineRun }) {
  const status = runStatus(run.status)
  const when = runTime(run)
  return (
    <li className="space-y-1.5 border-t border-(--border) py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={status.tone}>{status.label}</Badge>
        <time dateTime={when} className="text-sm font-medium">
          {formatInZone(when, routine.timeZone)}
        </time>
        <span className="text-xs text-(--muted)">
          {TRIGGER_LABELS[run.trigger]}
          {run.requestedBy && ` by ${run.requestedBy.name}`} · {formatRelativeTime(run.createdAt)}
        </span>
      </div>
      {run.error && (
        <p
          className={
            run.status === "failed" ? "text-sm leading-6 text-(--danger)" : "text-sm leading-6 text-(--muted)"
          }
        >
          {run.error.message}
        </p>
      )}
      <RunResult routine={routine} run={run} />
    </li>
  )
}

/** The routine's runs, newest first, with their outcomes and where to open their results. */
export function RoutineRuns({ workspaceId, routine }: { workspaceId: string; routine: RoutineDetail }) {
  const runs = useRoutineRuns(workspaceId, routine.id)
  const items = useMemo(() => (runs.data?.pages ?? []).flatMap((page) => page.runs), [runs.data])
  return (
    <Card className="space-y-3">
      <h2 className="text-base font-semibold tracking-tight">Run history</h2>
      <p className="text-xs text-(--muted)">Times are in {routine.timeZone}.</p>
      {runs.isPending && (
        <p role="status" className="text-sm text-(--muted)">
          Loading runs…
        </p>
      )}
      {runs.isLoadingError && (
        <ErrorState
          title="Runs unavailable"
          message={apiErrorMessage(runs.error)}
          onRetry={() => void runs.refetch()}
        />
      )}
      {runs.isSuccess && items.length === 0 && (
        <p className="text-sm leading-6 text-(--muted)">
          No runs yet. {routine.enabled ? "The first one starts at its next scheduled time, or " : "Paused: "}
          run it now to see a result.
        </p>
      )}
      {items.length > 0 && (
        <ul aria-label="Runs">
          {items.map((run) => (
            <RunItem key={run.id} routine={routine} run={run} />
          ))}
        </ul>
      )}
      {runs.isFetchNextPageError && (
        <FailureNotice title="More runs could not be loaded" message={apiErrorMessage(runs.error)} />
      )}
      {runs.hasNextPage && (
        <Button variant="ghost" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
          {runs.isFetchingNextPage ? "Loading…" : "Load older runs"}
        </Button>
      )}
    </Card>
  )
}
