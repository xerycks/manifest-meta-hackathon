import { Pause, Play, Timer } from "lucide-react"
import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"

import { useDeleteRoutine, useRunRoutine, useSetRoutinePaused } from "@/entities/routines/api.ts"
import type { Routine } from "@/entities/routines/types.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { Button, buttonVariants } from "@/shared/ui/button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"

/** Starts a run now, paused or not; one mutation id per click, so a resent request starts no second run. */
export function RunNowButton({ workspaceId, routine }: { workspaceId: string; routine: Routine }) {
  const run = useRunRoutine(workspaceId, routine.id)
  const [started, setStarted] = useState(false)
  return (
    <div className="space-y-2">
      <Button
        disabled={run.isPending}
        onClick={() => run.mutate(crypto.randomUUID(), { onSuccess: () => setStarted(true) })}
      >
        <Play aria-hidden className="size-4" />
        {run.isPending ? "Starting…" : "Run now"}
      </Button>
      {started && !run.isPending && !run.isError && (
        <p role="status" className="text-sm text-(--muted)">
          Started. The run shows in the history below.
        </p>
      )}
      {run.error && <FailureNotice title="Not started" message={apiErrorMessage(run.error)} />}
    </div>
  )
}

/** Pauses scheduled runs, or resumes them from the next slot (slots missed while paused do not run). */
export function PauseResumeButton({
  workspaceId,
  routine,
  compact = false,
}: {
  workspaceId: string
  routine: Routine
  compact?: boolean
}) {
  const toggle = useSetRoutinePaused(workspaceId)
  const paused = !routine.enabled
  return (
    <div className="space-y-2">
      <Button
        variant="secondary"
        className={compact ? "px-3 py-1.5" : undefined}
        disabled={toggle.isPending}
        aria-label={compact ? `${paused ? "Resume" : "Pause"} ${routine.name}` : undefined}
        onClick={() => toggle.mutate({ id: routine.id, paused: !paused })}
      >
        {paused ? <Play aria-hidden className="size-4" /> : <Pause aria-hidden className="size-4" />}
        {toggle.isPending ? (paused ? "Resuming…" : "Pausing…") : paused ? "Resume" : "Pause"}
      </Button>
      {toggle.error && (
        <FailureNotice title={paused ? "Not resumed" : "Not paused"} message={apiErrorMessage(toggle.error)} />
      )}
    </div>
  )
}

/** Deletes the routine with its run history, after a confirmation. */
export function DeleteRoutine({ workspaceId, routine }: { workspaceId: string; routine: Routine }) {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const remove = useDeleteRoutine(workspaceId, routine.id)
  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        Delete
      </Button>
    )
  }
  return (
    <div
      role="group"
      aria-label="Confirm deletion"
      className="w-full space-y-2 rounded-md border border-(--danger-border) p-3"
    >
      <p className="text-sm">
        Delete “{routine.name}” and its run history? It stops running for everyone.
        {routine.kind === "question" ? " Its conversation stays with its owner." : ""} This cannot be undone.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="danger"
          autoFocus
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(undefined, {
              onSuccess: () => navigate("/routines", { state: { notice: `Deleted “${routine.name}”.` } }),
            })
          }
        >
          {remove.isPending ? "Deleting…" : "Delete routine"}
        </Button>
        <Button variant="secondary" disabled={remove.isPending} onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
      {remove.error && <FailureNotice title="Not deleted" message={apiErrorMessage(remove.error)} />}
    </div>
  )
}

/** Starts a routine that runs this saved query on a schedule. */
export function CreateRoutineLink({ savedQueryId }: { savedQueryId: string }) {
  return (
    <Link
      to={`/routines/new?savedQueryId=${encodeURIComponent(savedQueryId)}`}
      className={buttonVariants({ variant: "secondary" })}
    >
      <Timer aria-hidden className="size-4" />
      Create routine
    </Link>
  )
}
