import { Copy, Pencil, RefreshCw, Trash2 } from "lucide-react"
import { useId, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"

import { useAddPanel, useDeletePanel } from "@/entities/dashboards/api.ts"
import { PanelBody } from "@/entities/dashboards/PanelBody.tsx"
import { PANEL_KIND_LABELS, panelTitle } from "@/entities/dashboards/panel-config.ts"
import type { DashboardPanel, PanelStatus } from "@/entities/dashboards/types.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { cn } from "@/shared/lib/cn.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Button } from "@/shared/ui/button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"

import { duplicateInput } from "./panel-form.ts"

const LINK =
  "rounded-md font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
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

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {formatRelativeTime(iso)}
    </time>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-6 text-(--muted)">{children}</p>
}

/** When the result a panel still shows after a refresh that did not succeed ran. */
function ShownFrom({ iso }: { iso: string | null }) {
  return iso ? (
    <>
      ; showing the result from <When iso={iso} />
    </>
  ) : null
}

/** How current the panel is, after the saved query's name. */
function StatusText({ status }: { status: PanelStatus }) {
  switch (status.state) {
    case "fresh":
      return (
        <>
          {" "}
          · updated <When iso={status.lastSuccessAt} />
        </>
      )
    case "refreshing":
      return (
        <span className="inline-flex items-center gap-1">
          {" "}
          ·
          <span
            aria-hidden
            className="size-3 animate-spin rounded-full border-2 border-(--border) border-t-(--accent) motion-reduce:animate-none"
          />
          {status.since ? "refreshing…" : "waiting to refresh…"}
        </span>
      )
    case "failed":
      return (
        <>
          {" "}
          · refresh failed
          <ShownFrom iso={status.lastSuccessAt} />
        </>
      )
    case "stale":
      return status.reason === "cancelled" ? (
        <>
          {" "}
          · refresh cancelled
          <ShownFrom iso={status.lastSuccessAt} />
        </>
      ) : (
        <> · not run yet</>
      )
  }
}

/**
 * One panel: its content from the saved query's latest result, how current
 * it is, and its actions: refresh (joining any run already under way), view
 * the saved query, and for editors edit, duplicate, and remove. A failed
 * refresh is shown above the last good result, which stays visible.
 */
export function DashboardPanelCard({
  workspaceId,
  dashboardId,
  panel,
  status,
  canEdit,
  refreshPending,
  onRefresh,
  onEdit,
  onAdded,
  moveHandle,
}: {
  workspaceId: string
  dashboardId: string
  panel: DashboardPanel
  /** The latest known status, which may be newer than the panel's own. */
  status: PanelStatus | null
  canEdit: boolean
  /** A refresh request is on its way. */
  refreshPending: boolean
  onRefresh: () => void
  onEdit: () => void
  onAdded: (message: string) => void
  /** The canvas's move and resize control, when the panel can move. */
  moveHandle?: ReactNode
}) {
  const titleId = useId()
  const remove = useDeletePanel(workspaceId, dashboardId)
  const add = useAddPanel(workspaceId)
  const [confirming, setConfirming] = useState(false)

  const data = panel.data
  const savedQuery = data?.state === "available" ? data.savedQuery : null
  const latestRun = data?.state === "available" ? data.latestRun : null
  const title = panelTitle(panel.title, savedQuery?.name ?? null)
  const label = title || `${PANEL_KIND_LABELS[panel.kind]} panel`
  const refreshing = status?.state === "refreshing"
  const duplicate = duplicateInput(panel)

  return (
    <article
      aria-labelledby={titleId}
      className="flex h-full min-w-0 flex-col gap-2 overflow-hidden rounded-lg border border-(--border) bg-white p-3"
    >
      <header className="flex items-start gap-1">
        {moveHandle}
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className={title ? "truncate text-sm font-semibold" : "sr-only"} title={title}>
            {label}
          </h2>
          {savedQuery && (
            <p className="mt-0.5 text-xs text-(--muted)">
              From{" "}
              <Link to={`/saved/${encodeURIComponent(savedQuery.id)}`} className={LINK}>
                {savedQuery.name}
              </Link>
              {status && <StatusText status={status} />}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
          {savedQuery &&
            (savedQuery.needsValues ? (
              <Link to={`/saved/${encodeURIComponent(savedQuery.id)}`} className={`${LINK} px-1.5 text-xs`}>
                Run with values
              </Link>
            ) : (
              <IconButton
                label={`Refresh ${label}`}
                disabled={refreshing || refreshPending}
                onClick={onRefresh}
              >
                <RefreshCw aria-hidden className={cn("size-4", refreshing && "motion-safe:animate-spin")} />
              </IconButton>
            ))}
          {canEdit && (
            <>
              <IconButton label={`Edit ${label}`} onClick={onEdit}>
                <Pencil aria-hidden className="size-4" />
              </IconButton>
              {duplicate && (
                <IconButton
                  label={`Duplicate ${label}`}
                  disabled={add.isPending}
                  onClick={() =>
                    add.mutate(
                      { dashboardId, input: duplicate },
                      { onSuccess: () => onAdded(`Duplicated “${label}”.`) },
                    )
                  }
                >
                  <Copy aria-hidden className="size-4" />
                </IconButton>
              )}
              <IconButton label={`Remove ${label}`} onClick={() => setConfirming(true)}>
                <Trash2 aria-hidden className="size-4" />
              </IconButton>
            </>
          )}
        </div>
      </header>

      {/* Notices scroll with the content, so a small panel never cuts them off. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        {add.error && <FailureNotice title="Not duplicated" message={apiErrorMessage(add.error)} />}
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
        {status?.state === "failed" && (
          <FailureNotice
            title="Refresh failed"
            message={`${status.failure.message}${status.lastSuccessAt ? " The panel still shows the last good result." : ""}`}
          />
        )}

        {/* While a refresh runs, the last result stays in place, dimmed. */}
        <div
          className={cn(
            "min-h-0 flex-1 transition-opacity motion-reduce:transition-none",
            refreshing && latestRun && "opacity-60",
          )}
        >
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
                : refreshing
                  ? "Its first result appears here when the refresh finishes."
                  : "Refresh the panel to show its result here."}
            </Note>
          )}
        </div>
      </div>
    </article>
  )
}
