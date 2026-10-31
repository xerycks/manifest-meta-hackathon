import { useEffect, useRef } from "react"

import {
  useCancelRefresh,
  useRefreshedDashboard,
  useRefreshProgress,
  useStartRefresh,
} from "@/entities/dashboards/api.ts"
import { refreshingPanels, refreshUnderway } from "@/entities/dashboards/refresh-state.ts"
import type { DashboardDetail, PanelStatus } from "@/entities/dashboards/types.ts"

/**
 * A dashboard's refresh as the page shows it: each panel's latest status
 * (from the progress it polls while anything refreshes, or from the
 * dashboard read when that is newer), and starting or cancelling a refresh.
 * Whenever a panel stops refreshing, the dashboard is reread for its result.
 */
export function useDashboardRefresh(
  workspaceId: string,
  dashboard: DashboardDetail,
  /** When the dashboard read arrived. */
  readAt: number,
) {
  const start = useStartRefresh(workspaceId, dashboard.id)
  const cancel = useCancelRefresh(workspaceId, dashboard.id)
  const reread = useRefreshedDashboard(workspaceId, dashboard.id)
  const underway = refreshUnderway({ active: dashboard.refresh.active, panels: dashboard.panels })
  const progress = useRefreshProgress(workspaceId, dashboard.id, underway)
  const live = progress.data && progress.dataUpdatedAt > readAt ? progress.data : null

  const statuses = new Map<string, PanelStatus | null>(
    (live?.panels ?? dashboard.panels).map((panel) => [panel.id, panel.status]),
  )
  const refreshing = refreshingPanels(live?.panels ?? dashboard.panels)
  const active = live ? live.active : dashboard.refresh.active

  // A panel that stopped refreshing has a new result (or failure) to read.
  const previous = useRef<Set<string>>(refreshing)
  useEffect(() => {
    const finished = [...previous.current].some((id) => !refreshing.has(id))
    previous.current = refreshing
    if (finished) void reread()
  })

  return {
    statuses,
    active,
    refreshingCount: refreshing.size,
    start: (panelIds?: string[]) => start.mutate(panelIds),
    starting: start.isPending,
    cancel: () => cancel.mutate(undefined, { onSettled: () => void reread() }),
    cancelling: cancel.isPending,
    error: start.error ?? cancel.error,
  }
}
