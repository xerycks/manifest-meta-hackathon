import { Lock, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useDashboards } from "@/entities/dashboards/api.ts"
import { DASHBOARD_LIMITS } from "@/entities/dashboards/types.ts"
import { DashboardForm } from "@/features/dashboard/DashboardForm.tsx"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button } from "@/shared/ui/button.tsx"
import { Card } from "@/shared/ui/card.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

/** Dashboards the user may see, recently updated first, and a form to create one. */
export function DashboardsPage() {
  const session = useWorkspaceSession()
  const location = useLocation()
  const navigate = useNavigate()
  const [notice] = useState(() => (location.state as { notice?: string } | null)?.notice)
  const [creating, setCreating] = useState(false)
  const dashboards = useDashboards(session.workspaceId)
  const listed = dashboards.data?.dashboards ?? []
  const full = listed.length >= DASHBOARD_LIMITS.perWorkspace

  useEffect(() => {
    // Show a confirmation once; reloading the page should not repeat it.
    if (location.state) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboards</h1>
          <p className="mt-1 leading-7 text-(--muted)">
            Saved queries' latest results as numbers and tables, with notes in between. Add a saved query from
            its page, or create a dashboard and add panels to it.
          </p>
        </div>
        {!creating && session.workspaceId && (
          <Button onClick={() => setCreating(true)} disabled={full}>
            <Plus aria-hidden className="size-4" />
            New dashboard
          </Button>
        )}
      </div>

      {notice && (
        <p role="status" className="text-sm text-(--success)">
          {notice}
        </p>
      )}
      {full && (
        <p className="text-sm text-(--muted)">
          This workspace has {DASHBOARD_LIMITS.perWorkspace} dashboards, the most it can have. Delete one to
          create another.
        </p>
      )}
      {creating && session.workspaceId && (
        <Card>
          <h2 className="mb-4 text-base font-semibold tracking-tight">New dashboard</h2>
          <DashboardForm
            workspaceId={session.workspaceId}
            dashboard={null}
            onSaved={(created) =>
              navigate(`/dashboards/${encodeURIComponent(created.id)}`, {
                state: { notice: `Created “${created.name}”. Add its first panel.` },
              })
            }
            onCancel={() => setCreating(false)}
          />
        </Card>
      )}

      {(!session.workspaceId || dashboards.isPending) && <LoadingState label="Loading dashboards…" />}
      {dashboards.isError && (
        <ErrorState
          title="Dashboards unavailable"
          message={apiErrorMessage(dashboards.error)}
          onRetry={() => void dashboards.refetch()}
        />
      )}
      {dashboards.isSuccess && listed.length === 0 && !creating && (
        <EmptyState
          title="No dashboards yet"
          description="Create one to keep the numbers and tables your team checks often in one place, each from a saved query."
          action={<Button onClick={() => setCreating(true)}>Create a dashboard</Button>}
        />
      )}
      {listed.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {listed.map((item) => (
            <li key={item.id}>
              <Link
                to={`/dashboards/${encodeURIComponent(item.id)}`}
                className="block h-full rounded-lg border border-(--border) bg-white p-4 hover:bg-(--surface) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{item.name}</span>
                  {item.visibility === "private" && (
                    <Badge>
                      <Lock aria-hidden className="size-3" />
                      Only you
                    </Badge>
                  )}
                </span>
                {item.excerpt && (
                  <span className="mt-1 line-clamp-2 block text-sm leading-6 text-(--muted)">
                    {item.excerpt}
                  </span>
                )}
                <span className="mt-2 block text-xs text-(--muted)">
                  {item.panelCount === 0
                    ? "No panels"
                    : `${item.panelCount} ${item.panelCount === 1 ? "panel" : "panels"}`}
                  {" · updated "}
                  {formatRelativeTime(item.updatedAt)}
                  {item.updatedBy && ` by ${item.updatedBy.name}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
