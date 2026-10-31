import { ArrowLeft, Lock, Pencil, Plus, RefreshCw, Square } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useDashboard, useDeleteDashboard } from "@/entities/dashboards/api.ts"
import { canEditDashboard } from "@/entities/dashboards/panel-config.ts"
import { DASHBOARD_LIMITS, type DashboardDetail, type DashboardPanel } from "@/entities/dashboards/types.ts"
import { DashboardCanvas } from "@/features/dashboard/DashboardCanvas.tsx"
import { DashboardForm } from "@/features/dashboard/DashboardForm.tsx"
import { DashboardPanelCard } from "@/features/dashboard/DashboardPanelCard.tsx"
import { PanelDialog } from "@/features/dashboard/PanelDialog.tsx"
import { useDashboardRefresh } from "@/features/dashboard/use-dashboard-refresh.ts"
import { ApiError } from "@/shared/api/client.ts"
import { useSessionContext } from "@/shared/api/auth.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button } from "@/shared/ui/button.tsx"
import { Card } from "@/shared/ui/card.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Markdown } from "@/shared/ui/markdown.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {formatRelativeTime(iso)}
    </time>
  )
}

function DeleteDashboard({ workspaceId, dashboard }: { workspaceId: string; dashboard: DashboardDetail }) {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const remove = useDeleteDashboard(workspaceId, dashboard.id)
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
        Delete “{dashboard.name}”
        {dashboard.visibility === "workspace" ? " for everyone in this workspace" : ""} with its{" "}
        {dashboard.panels.length === 1 ? "panel" : `${dashboard.panels.length} panels`}? The saved queries
        they show stay. This cannot be undone.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="danger"
          autoFocus
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(undefined, {
              onSuccess: () => navigate("/dashboards", { state: { notice: `Deleted “${dashboard.name}”.` } }),
            })
          }
        >
          {remove.isPending ? "Deleting…" : "Delete dashboard"}
        </Button>
        <Button variant="secondary" disabled={remove.isPending} onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
      {remove.error && <FailureNotice title="Not deleted" message={apiErrorMessage(remove.error)} />}
    </div>
  )
}

/** Whether a refresh could run the panel's saved query from here. */
function refreshable(panel: DashboardPanel): boolean {
  return panel.data?.state === "available" && !panel.data.savedQuery.needsValues
}

/**
 * The panels on their canvas with Refresh all: every distinct saved query
 * runs once, each panel shows its own progress, and the refresh can be
 * cancelled.
 */
function Panels({
  workspaceId,
  dashboard,
  readAt,
  canEdit,
  onEdit,
  onNotice,
}: {
  workspaceId: string
  dashboard: DashboardDetail
  readAt: number
  canEdit: boolean
  onEdit: (panel: DashboardPanel) => void
  onNotice: (message: string) => void
}) {
  const refresh = useDashboardRefresh(workspaceId, dashboard, readAt)
  const anyRefreshable = dashboard.panels.some(refreshable)

  return (
    <>
      {anyRefreshable && (
        <div className="flex flex-wrap items-center gap-2">
          {refresh.active ? (
            <>
              <p role="status" className="flex items-center gap-2 text-sm text-(--muted)">
                <span
                  aria-hidden
                  className="size-4 animate-spin rounded-full border-2 border-(--border) border-t-(--accent) motion-reduce:animate-none"
                />
                Refreshing {refresh.refreshingCount === 1 ? "1 panel" : `${refresh.refreshingCount} panels`}…
              </p>
              <Button variant="secondary" disabled={refresh.cancelling} onClick={refresh.cancel}>
                <Square aria-hidden className="size-4" />
                {refresh.cancelling ? "Cancelling…" : "Cancel refresh"}
              </Button>
            </>
          ) : (
            <Button variant="secondary" disabled={refresh.starting} onClick={() => refresh.start()}>
              <RefreshCw aria-hidden className="size-4" />
              {refresh.starting ? "Starting…" : "Refresh all"}
            </Button>
          )}
        </div>
      )}
      {refresh.error && (
        <FailureNotice title="Refresh not started" message={apiErrorMessage(refresh.error)} />
      )}
      <DashboardCanvas
        workspaceId={workspaceId}
        dashboard={dashboard}
        canEdit={canEdit}
        renderPanel={(panel, moveHandle) => (
          <DashboardPanelCard
            workspaceId={workspaceId}
            dashboardId={dashboard.id}
            panel={panel}
            status={refresh.statuses.get(panel.id) ?? panel.status}
            canEdit={canEdit}
            refreshPending={refresh.starting}
            onRefresh={() => refresh.start([panel.id])}
            onEdit={() => onEdit(panel)}
            onAdded={onNotice}
            moveHandle={moveHandle}
          />
        )}
      />
    </>
  )
}

/** One dashboard: its panels on a grid canvas, with editing for its creator and owners and admins. */
export function DashboardPage() {
  const { dashboardId = "" } = useParams()
  return <DashboardView key={dashboardId} dashboardId={dashboardId} />
}

function DashboardView({ dashboardId }: { dashboardId: string }) {
  const session = useWorkspaceSession()
  const context = useSessionContext()
  const location = useLocation()
  const navigate = useNavigate()
  const dashboard = useDashboard(session.workspaceId, dashboardId)
  const [editing, setEditing] = useState(false)
  // The panel dialog: a panel to edit, or "new" to add one.
  const [dialog, setDialog] = useState<DashboardPanel | "new" | null>(null)
  const [notice, setNotice] = useState(() => (location.state as { notice?: string } | null)?.notice)
  const data = dashboard.data
  // Malformed ids fail validation; either way the dashboard does not exist here.
  const notFound =
    dashboard.error instanceof ApiError && (dashboard.error.status === 404 || dashboard.error.status === 422)
  const canEdit = data ? canEditDashboard(data, context.data?.user.id, session.workspaceRole) : false
  const full = (data?.panels.length ?? 0) >= DASHBOARD_LIMITS.panelsPerDashboard

  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/dashboards"
          className="inline-flex items-center gap-1.5 rounded-md text-sm text-(--muted) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Dashboards
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight break-words">
          {data?.name ?? "Dashboard"}
        </h1>
        {data && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-(--muted)">
            {data.visibility === "private" && (
              <Badge>
                <Lock aria-hidden className="size-3" />
                Only you
              </Badge>
            )}
            <span>
              Created {data.createdBy && `by ${data.createdBy.name} `}
              <When iso={data.createdAt} /> · updated {data.updatedBy && `by ${data.updatedBy.name} `}
              <When iso={data.updatedAt} />
            </span>
          </div>
        )}
      </div>

      {notice && (
        <p role="status" className="text-sm text-(--success)">
          {notice}
        </p>
      )}
      {(!session.workspaceId || dashboard.isPending) && <LoadingState label="Loading the dashboard…" />}
      {notFound && (
        <EmptyState
          title="Dashboard not found"
          description="It does not exist in this workspace, it is private to someone else, or it was deleted."
          action={
            <Link to="/dashboards" className="text-sm font-medium text-(--accent) hover:underline">
              Back to dashboards
            </Link>
          }
        />
      )}
      {dashboard.isError && !notFound && (
        <ErrorState
          title="Dashboard unavailable"
          message={apiErrorMessage(dashboard.error)}
          onRetry={() => void dashboard.refetch()}
        />
      )}

      {data && session.workspaceId && editing && (
        <Card>
          <DashboardForm
            workspaceId={session.workspaceId}
            dashboard={data}
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
            <Markdown className="max-w-3xl rounded-lg border border-(--border) p-4">
              {data.description}
            </Markdown>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {canEdit ? (
              <>
                <Button
                  onClick={() => {
                    setNotice(undefined)
                    setDialog("new")
                  }}
                  disabled={full}
                >
                  <Plus aria-hidden className="size-4" />
                  Add panel
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setNotice(undefined)
                    setEditing(true)
                  }}
                >
                  <Pencil aria-hidden className="size-4" />
                  Edit details
                </Button>
                <DeleteDashboard workspaceId={session.workspaceId} dashboard={data} />
              </>
            ) : (
              <p className="text-sm text-(--muted)">
                Only its creator or a workspace owner or admin can change this dashboard.
              </p>
            )}
          </div>
          {full && canEdit && (
            <p className="text-sm text-(--muted)">
              This dashboard has {DASHBOARD_LIMITS.panelsPerDashboard} panels, the most it can hold. Remove
              one to add another.
            </p>
          )}

          {data.panels.length === 0 ? (
            <EmptyState
              title="No panels yet"
              description={
                canEdit
                  ? "Add a number, table, or chart from a saved query's latest result, or a note in Markdown."
                  : "Nothing has been added to this dashboard yet."
              }
              action={canEdit ? <Button onClick={() => setDialog("new")}>Add a panel</Button> : undefined}
            />
          ) : (
            <Panels
              workspaceId={session.workspaceId}
              dashboard={data}
              readAt={dashboard.dataUpdatedAt}
              canEdit={canEdit}
              onEdit={(panel) => setDialog(panel)}
              onNotice={setNotice}
            />
          )}
        </>
      )}

      {data && session.workspaceId && dialog && (
        <PanelDialog
          workspaceId={session.workspaceId}
          dashboard={data}
          panel={dialog === "new" ? null : dialog}
          onSaved={(message) => {
            setDialog(null)
            setNotice(message)
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}
