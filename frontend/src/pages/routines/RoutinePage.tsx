import { AlertTriangle, ArrowLeft, ExternalLink, Pencil } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useConnections } from "@/entities/connections/api.ts"
import { useRoutine } from "@/entities/routines/api.ts"
import {
  canManageRoutine,
  formatInZone,
  routineState,
  runStatus,
  scheduleLabel,
} from "@/entities/routines/status.ts"
import { ROUTINE_LIMITS, type RoutineDetail } from "@/entities/routines/types.ts"
import {
  describeParameterValue,
  formatParameterValue,
  relativeLabel,
} from "@/entities/saved-queries/parameters.ts"
import { DeleteRoutine, PauseResumeButton, RunNowButton } from "@/features/manage-routines/RoutineActions.tsx"
import { RoutineForm } from "@/features/manage-routines/RoutineForm.tsx"
import { RoutineRuns } from "@/features/manage-routines/RoutineRuns.tsx"
import { ApiError } from "@/shared/api/client.ts"
import { useSessionContext } from "@/shared/api/auth.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button } from "@/shared/ui/button.tsx"
import { Card } from "@/shared/ui/card.tsx"
import { Markdown } from "@/shared/ui/markdown.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

const LINK =
  "inline-flex items-center gap-1 rounded-md font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
      <dt className="text-sm text-(--muted)">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

/** A parameter value as the routine sets it: "Yesterday", "7 days ago", or a fixed date. */
function valueLabel(value: RoutineDetail["parameters"][string]): string {
  if (value === null) return "No value"
  if (typeof value !== "string") return describeParameterValue(value)
  const relative = relativeLabel(value)
  return relative === value ? formatParameterValue(value) : relative
}

/** What the routine runs, as the viewer may see it. */
function Target({ workspaceId, routine }: { workspaceId: string; routine: RoutineDetail }) {
  const sources = useConnections(routine.kind === "question" ? workspaceId : null)
  if (routine.kind === "question") {
    const names = routine.connectionIds.map(
      (sourceId) => sources.data?.find((source) => source.id === sourceId)?.name ?? "A removed source",
    )
    return (
      <>
        <Row label="Question">
          <span className="whitespace-pre-wrap">{routine.question}</span>
        </Row>
        <Row label="Sources">{names.length > 0 ? names.join(", ") : "All sources"}</Row>
        <Row label="Answers">
          {routine.conversationId ? (
            <Link to={`/ask/${encodeURIComponent(routine.conversationId)}`} className={LINK}>
              Open the routine's conversation
              <ExternalLink aria-hidden className="size-3.5" />
            </Link>
          ) : (
            "In its owner's conversation, which only they can open"
          )}
        </Row>
      </>
    )
  }
  const savedQuery = routine.savedQuery
  const parameters = Object.entries(routine.parameters)
  return (
    <>
      <Row label="Saved query">
        {savedQuery?.state === "available" ? (
          <Link to={`/saved/${encodeURIComponent(savedQuery.id)}`} className={LINK}>
            {savedQuery.name}
          </Link>
        ) : savedQuery?.state === "private" ? (
          "A saved query private to its owner"
        ) : (
          <span className="text-(--danger)">The saved query was deleted, so runs fail.</span>
        )}
      </Row>
      <Row label="Parameters">
        {parameters.length === 0 ? (
          "The saved query's defaults"
        ) : (
          <ul>
            {parameters.map(([name, value]) => (
              <li key={name}>
                <code className="font-mono text-xs">{name}</code>: {valueLabel(value)}
              </li>
            ))}
          </ul>
        )}
      </Row>
    </>
  )
}

/** One routine: what it runs and when, its actions, and its run history. */
export function RoutinePage() {
  const { routineId = "" } = useParams()
  return <RoutineView key={routineId} routineId={routineId} />
}

function RoutineView({ routineId }: { routineId: string }) {
  const session = useWorkspaceSession()
  const context = useSessionContext()
  const location = useLocation()
  const navigate = useNavigate()
  const routine = useRoutine(session.workspaceId, routineId)
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState(() => (location.state as { notice?: string } | null)?.notice)
  const data = routine.data
  // Malformed ids fail validation; either way the routine does not exist here.
  const notFound =
    routine.error instanceof ApiError && (routine.error.status === 404 || routine.error.status === 422)
  const canManage = data ? canManageRoutine(data, context.data?.user.id, session.workspaceRole) : false
  const state = data ? routineState(data) : null
  const last = data?.lastStatus ? runStatus(data.lastStatus) : null

  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/routines"
          className="inline-flex items-center gap-1.5 rounded-md text-sm text-(--muted) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Routines
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight break-words">{data?.name ?? "Routine"}</h1>
        {data && state && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-(--muted)">
            <Badge>{data.kind === "question" ? "Question" : "Saved query"}</Badge>
            <Badge tone={state.tone}>{state.label}</Badge>
            <span>
              Runs as {data.owner?.name ?? "a user who no longer exists"}
              {data.updatedBy && (
                <>
                  {" "}
                  · updated by {data.updatedBy.name} {formatRelativeTime(data.updatedAt)}
                </>
              )}
            </span>
          </div>
        )}
      </div>

      {notice && (
        <p role="status" className="text-sm text-(--success)">
          {notice}
        </p>
      )}
      {(!session.workspaceId || routine.isPending) && <LoadingState label="Loading the routine…" />}
      {notFound && (
        <EmptyState
          title="Routine not found"
          description="It does not exist in this workspace, or it was deleted."
          action={
            <Link to="/routines" className="text-sm font-medium text-(--accent) hover:underline">
              Back to routines
            </Link>
          }
        />
      )}
      {routine.isError && !notFound && (
        <ErrorState
          title="Routine unavailable"
          message={apiErrorMessage(routine.error)}
          onRetry={() => void routine.refetch()}
        />
      )}

      {data && session.workspaceId && data.pausedReason === "failures" && (
        <div
          role="alert"
          className="flex gap-3 rounded-md border border-(--danger-border) bg-(--danger-surface) px-4 py-3 text-sm text-(--danger)"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">Paused because its runs failed</p>
            <p className="leading-6">
              It pauses itself after {ROUTINE_LIMITS.failuresBeforePause} failed runs in a row, or when its schedule
              can no longer be read. The latest error is in the run history below. Fix its cause, run it now to
              check, then resume the schedule.
            </p>
          </div>
        </div>
      )}

      {data && session.workspaceId && editing && (
        <Card>
          <RoutineForm
            workspaceId={session.workspaceId}
            routine={data}
            onSaved={(saved) => {
              setEditing(false)
              setNotice(`Saved “${saved.name}”.`)
            }}
            onCancel={() => setEditing(false)}
          />
        </Card>
      )}
      {data && session.workspaceId && !editing && (
        <>
          {data.description.trim() && (
            <Markdown className="max-w-3xl rounded-lg border border-(--border) p-4">{data.description}</Markdown>
          )}
          <Card>
            <dl className="space-y-3">
              <Target workspaceId={session.workspaceId} routine={data} />
              <Row label="Schedule">
                {scheduleLabel(data)} <code className="ml-1 font-mono text-xs text-(--muted)">{data.cron}</code>
              </Row>
              <Row label="Next runs">
                {data.upcoming.length > 0 ? (
                  <ol>
                    {data.upcoming.map((time) => (
                      <li key={time}>
                        <time dateTime={time}>{formatInZone(time, data.timeZone)}</time>
                      </li>
                    ))}
                  </ol>
                ) : (
                  "None while paused; it runs only when someone runs it now"
                )}
              </Row>
              <Row label="Last run">
                {last && data.lastRunAt ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Badge tone={last.tone}>{last.label}</Badge>
                    <time dateTime={data.lastRunAt}>{formatInZone(data.lastRunAt, data.timeZone)}</time>
                  </span>
                ) : (
                  "Not run yet"
                )}
              </Row>
              <Row label="Results">Kept in Manifest, in the run history below</Row>
            </dl>
          </Card>
          {canManage ? (
            <div className="flex flex-wrap items-start gap-2">
              <RunNowButton workspaceId={session.workspaceId} routine={data} />
              <PauseResumeButton workspaceId={session.workspaceId} routine={data} />
              <Button
                variant="secondary"
                onClick={() => {
                  setNotice(undefined)
                  setEditing(true)
                }}
              >
                <Pencil aria-hidden className="size-4" />
                Edit
              </Button>
              <DeleteRoutine workspaceId={session.workspaceId} routine={data} />
            </div>
          ) : (
            <p className="text-sm text-(--muted)">
              Only the routine's owner or a workspace owner or admin can run, change, pause, or delete it.
            </p>
          )}
          <RoutineRuns workspaceId={session.workspaceId} routine={data} />
        </>
      )}
    </div>
  )
}
