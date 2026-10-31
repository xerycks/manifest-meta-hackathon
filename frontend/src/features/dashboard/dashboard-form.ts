import {
  DASHBOARD_LIMITS,
  type CreateDashboardInput,
  type Dashboard,
  type UpdateDashboardInput,
  type Visibility,
} from "../../entities/dashboards/types.ts"
import { changedKeys, type DraftFields, type DraftState } from "../../shared/lib/draft.ts"

export type DashboardField = "name" | "description" | "visibility"

export const EMPTY_DASHBOARD: DraftFields<DashboardField> = {
  name: "",
  description: "",
  visibility: "workspace",
}

export function dashboardFields(dashboard: Dashboard): DraftFields<DashboardField> {
  return { name: dashboard.name, description: dashboard.description, visibility: dashboard.visibility }
}

/** A problem with the name that the server would reject, or null. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "Give the dashboard a name."
  if (trimmed.length > DASHBOARD_LIMITS.nameChars) {
    return `A name can be at most ${DASHBOARD_LIMITS.nameChars} characters.`
  }
  return null
}

export function newDashboard(draft: DraftFields<DashboardField>): CreateDashboardInput {
  return {
    name: draft.name.trim(),
    description: draft.description,
    visibility: draft.visibility as Visibility,
  }
}

/** Only the changed fields; an emptied description is sent as "". */
export function dashboardPatch(state: DraftState<DashboardField>): UpdateDashboardInput {
  const patch: UpdateDashboardInput = { version: state.version }
  for (const key of changedKeys(state.base, state.draft)) {
    if (key === "name") patch.name = state.draft.name.trim()
    if (key === "description") patch.description = state.draft.description
    if (key === "visibility") patch.visibility = state.draft.visibility as Visibility
  }
  return patch
}
