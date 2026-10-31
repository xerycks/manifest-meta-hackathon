import type { PanelStatus } from "./types.ts"

/** The ids of the panels refreshing now. */
export function refreshingPanels(panels: { id: string; status: PanelStatus | null }[]): Set<string> {
  return new Set(panels.flatMap((panel) => (panel.status?.state === "refreshing" ? [panel.id] : [])))
}

/** Whether a refresh is running, or any panel's saved query is still running. */
export function refreshUnderway(progress: {
  active: boolean
  panels: { id: string; status: PanelStatus | null }[]
}): boolean {
  return progress.active || refreshingPanels(progress.panels).size > 0
}
