import { Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useRoutines } from "@/entities/routines/api.ts"
import {
  canManageRoutine,
  formatInZone,
  routineState,
  runStatus,
  scheduleLabel,
} from "@/entities/routines/status.ts"
import { ROUTINE_LIMITS, type Routine } from "@/entities/routines/types.ts"
import { PauseResumeButton } from "@/features/manage-routines/RoutineActions.tsx"
import { useSessionContext } from "@/shared/api/auth.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { buttonVariants } from "@/shared/ui/button.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

const NEW_ROUTINE = "/routines/new"

function RoutineRow({
  routine,
  workspaceId,
  canManage,
}: {
  routine: Routine
  workspaceId: string
  canManage: boolean
}) {
  const state = routineState(routine)
  const last = routine.lastStatus ? runStatus(routine.lastStatus) : null
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-(--border) bg-white p-4">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/routines/${encodeURIComponent(routine.id)}`}
            className="rounded-md font-medium break-words hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
          >
            {routine.name}
          </Link>
          <Badge>{routine.kind === "question" ? "Question" : "Saved query"}</Badge>
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
        <p className="text-sm text-(--muted)">{scheduleLabel(routine)}</p>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-1.5">
            <dt className="text-(--muted)">Next run</dt>
            <dd>
              {routine.nextRunAt ? (
                <time dateTime={routine.nextRunAt}>{formatInZone(routine.nextRunAt, routine.timeZone)}</time>
              ) : (
                "Paused"
              )}
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-(--muted)">Last run</dt>
            <dd className="flex items-center gap-1.5">
              {last && routine.lastRunAt ? (
                <>
                  <Badge tone={last.tone}>{last.label}</Badge>
                  <time dateTime={routine.lastRunAt}>{formatRelativeTime(routine.lastRunAt)}</time>
                </>
              ) : (
                "Never"
              )}
            </dd>
          </div>
        </dl>
      </div>
      {canManage && <PauseResumeButton workspaceId={workspaceId} routine={routine} compact />}
    </li>
  )
}

/** The workspace's routines with their schedules, next runs, and last outcomes. */
export function RoutinesPage() {
  const session = useWorkspaceSession()
  const context = useSessionContext()
  const location = useLocation()
  const navigate = useNavigate()
  const [notice] = useState(() => (location.state as { notice?: string } | null)?.notice)
  const routines = useRoutines(session.workspaceId)
  const listed = routines.data?.routines ?? []
  const full = listed.length >= ROUTINE_LIMITS.perWorkspace

  useEffect(() => {
    // Show a confirmation once; reloading the page should not repeat it.
    if (location.state) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight">Routines</h1>
          <p className="mt-1 leading-7 text-(--muted)">
            Saved queries and questions that run on a schedule as their owner, with a history of every run. Anyone
            in the workspace can see them; their owner or a workspace owner or admin manages them.
          </p>
        </div>
        {session.workspaceId && !full && (
          <Link to={NEW_ROUTINE} className={buttonVariants()}>
            <Plus aria-hidden className="size-4" />
            New routine
          </Link>
        )}
      </div>

      {notice && (
        <p role="status" className="text-sm text-(--success)">
          {notice}
        </p>
      )}
      {full && (
        <p className="text-sm text-(--muted)">
          This workspace has {ROUTINE_LIMITS.perWorkspace} routines, the most it can have. Delete one to create
          another.
        </p>
      )}
      {(!session.workspaceId || routines.isPending) && <LoadingState label="Loading routines…" />}
      {routines.isError && (
        <ErrorState
          title="Routines unavailable"
          message={apiErrorMessage(routines.error)}
          onRetry={() => void routines.refetch()}
        />
      )}
      {routines.isSuccess && listed.length === 0 && (
        <EmptyState
          title="No routines yet"
          description="Run a saved query or ask a question on a schedule, such as every weekday at 09:00, and keep a history of every result."
          action={
            <Link to={NEW_ROUTINE} className={buttonVariants()}>
              Create a routine
            </Link>
          }
        />
      )}
      {listed.length > 0 && session.workspaceId && (
        <ul className="space-y-3">
          {listed.map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              workspaceId={session.workspaceId as string}
              canManage={canManageRoutine(routine, context.data?.user.id, session.workspaceRole)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
