import { ArrowDown, ArrowUp, Pencil, RefreshCw, Square, Trash2 } from "lucide-react"
import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react"
import { Link } from "react-router-dom"

import { useDeletePanel, useRunPanel } from "@/entities/dashboards/api.ts"
import { PanelBody } from "@/entities/dashboards/PanelBody.tsx"
import { PANEL_KIND_LABELS, panelTitle } from "@/entities/dashboards/panel-config.ts"
import type { DashboardPanel } from "@/entities/dashboards/types.ts"
import { describeOutcome, describeRunError, type OutcomeNotice } from "@/entities/queries/run-outcome.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Button } from "@/shared/ui/button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"

const LINK =
  "rounded-md font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"

const STOPPED: OutcomeNotice = {
  title: "Run stopped",
  message: "The request was closed, so the query was stopped on the source.",
}

function IconButton({
  label,
  disabled,
  onClick,
  ref,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  ref?: Ref<HTMLButtonElement>
  children: ReactNode
}) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      className="p-1.5"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-6 text-(--muted)">{children}</p>
}

/**
 * One panel on a dashboard: its content from the saved query's latest stored
 * result with when it ran, Run now (through the saved query's run route),
 * and, for editors, edit, move, and remove. A failed run is shown in the
 * panel, above the result it still has.
 */
export function DashboardPanelCard({
  workspaceId,
  dashboardId,
  panel,
  index,
  count,
  canEdit,
  onEdit,
  onMove,
}: {
  workspaceId: string
  dashboardId: string
  panel: DashboardPanel
  index: number
  count: number
  canEdit: boolean
  onEdit: () => void
  /** False when the move did not start (another is being saved). */
  onMove: (offset: -1 | 1) => boolean
}) {
  const titleId = useId()
  const run = useRunPanel(workspaceId, dashboardId)
  const remove = useDeletePanel(workspaceId, dashboardId)
  const request = useRef<AbortController | null>(null)
  const earlier = useRef<HTMLButtonElement>(null)
  const later = useRef<HTMLButtonElement>(null)
  const moved = useRef<-1 | 1 | null>(null)
  const [runNotice, setRunNotice] = useState<OutcomeNotice | null>(null)
  const [confirming, setConfirming] = useState(false)

  // Leaving the page closes the request, which also stops the query on the source.
  useEffect(() => () => request.current?.abort(), [])

  // A panel moved in the list can lose focus; keep it on the button that moved it.
  useEffect(() => {
    if (moved.current === null) return
    const button = moved.current === -1 && index > 0 ? earlier.current : later.current
    ;(button && !button.disabled ? button : (earlier.current ?? later.current))?.focus()
    moved.current = null
  }, [index])

  const data = panel.data
  const savedQuery = data?.state === "available" ? data.savedQuery : null
  const latestRun = data?.state === "available" ? data.latestRun : null
  const title = panelTitle(panel.title, savedQuery?.name ?? null)
  const label = title || `${PANEL_KIND_LABELS[panel.kind]} panel`

  function runNow(savedQueryId: string) {
    const controller = new AbortController()
    request.current = controller
    setRunNotice(null)
    run
      .mutateAsync({ savedQueryId, signal: controller.signal })
      .then(
        (result) => setRunNotice(describeOutcome(result.execution)),
        (error: unknown) => setRunNotice(controller.signal.aborted ? STOPPED : describeRunError(error)),
      )
      .finally(() => {
        request.current = null
      })
  }

  return (
    <article
      aria-labelledby={titleId}
      className="flex h-full min-w-0 flex-col gap-3 rounded-lg border border-(--border) bg-white p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className={title ? "font-semibold break-words" : "sr-only"}>
            {label}
          </h2>
          {savedQuery && (
            <p className="mt-0.5 text-xs text-(--muted)">
              From{" "}
              <Link to={`/saved/${encodeURIComponent(savedQuery.id)}`} className={LINK}>
                {savedQuery.name}
              </Link>
              {latestRun && (
                <>
                  {" "}
                  · ran{" "}
                  <time dateTime={latestRun.createdAt} title={new Date(latestRun.createdAt).toLocaleString()}>
                    {formatRelativeTime(latestRun.createdAt)}
                  </time>
                </>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-0.5">
          {savedQuery &&
            (savedQuery.needsValues ? (
              <Link to={`/saved/${encodeURIComponent(savedQuery.id)}`} className={`${LINK} px-2 text-xs`}>
                Run with values
              </Link>
            ) : run.isPending ? (
              <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => request.current?.abort()}>
                <Square aria-hidden className="size-3.5" />
                Stop
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                aria-label={`Run now: ${label}`}
                onClick={() => runNow(savedQuery.id)}
              >
                <RefreshCw aria-hidden className="size-3.5" />
                Run now
              </Button>
            ))}
          {canEdit && (
            <>
              <IconButton
                ref={earlier}
                label={`Move ${label} earlier`}
                disabled={index === 0}
                onClick={() => {
                  if (onMove(-1)) moved.current = -1
                }}
              >
                <ArrowUp aria-hidden className="size-4" />
              </IconButton>
              <IconButton
                ref={later}
                label={`Move ${label} later`}
                disabled={index === count - 1}
                onClick={() => {
                  if (onMove(1)) moved.current = 1
                }}
              >
                <ArrowDown aria-hidden className="size-4" />
              </IconButton>
              <IconButton label={`Edit ${label}`} onClick={onEdit}>
                <Pencil aria-hidden className="size-4" />
              </IconButton>
              <IconButton label={`Remove ${label}`} onClick={() => setConfirming(true)}>
                <Trash2 aria-hidden className="size-4" />
              </IconButton>
            </>
          )}
        </div>
      </header>

      {confirming && (
        <div
          role="group"
          aria-label="Confirm removal"
          className="space-y-2 rounded-md border border-(--danger-border) p-3"
        >
          <p className="text-sm">Remove this panel from the dashboard? Its saved query stays.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              autoFocus
              disabled={remove.isPending}
              onClick={() => remove.mutate(panel.id, { onSuccess: () => setConfirming(false) })}
            >
              {remove.isPending ? "Removing…" : "Remove panel"}
            </Button>
            <Button variant="secondary" disabled={remove.isPending} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
          {remove.error && <FailureNotice title="Not removed" message={apiErrorMessage(remove.error)} />}
        </div>
      )}

      {run.isPending && (
        <p role="status" className="text-sm text-(--muted)">
          Running the saved query…
        </p>
      )}
      {!run.isPending && runNotice && <FailureNotice title={runNotice.title} message={runNotice.message} />}

      <div className="min-w-0">
        {panel.kind === "markdown" ? (
          <PanelBody panel={panel} result={null} label={label} />
        ) : data?.state === "removed" ? (
          <Note>
            Its saved query was deleted, so there is nothing to show.
            {canEdit && " Edit the panel to choose another saved query, or remove it."}
          </Note>
        ) : data?.state === "private" ? (
          <Note>It shows a saved query that only its creator can see.</Note>
        ) : latestRun ? (
          <PanelBody panel={panel} result={latestRun.result} label={label} />
        ) : (
          <Note>
            “{savedQuery?.name}” has not been run yet.{" "}
            {savedQuery?.needsValues
              ? "It needs parameter values: run it from its page."
              : "Run it to show its result here."}
          </Note>
        )}
      </div>
    </article>
  )
}
