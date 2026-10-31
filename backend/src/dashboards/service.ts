import type { ExecutionPreview, QueryExecutionsRepository } from "../queries/repository.js"
import type { SavedQueriesRepository } from "../saved-queries/repository.js"
import { AppError } from "../shared/http/errors.js"
import { parseInput } from "../shared/http/validate.js"
import { isForeignKeyViolation, isUniqueViolation } from "../shared/postgres/errors.js"
import { MANAGER_ROLES } from "../workspaces/access.js"
import type { WorkspaceRole } from "../workspaces/repository.js"
import { columnProblem, panelResult } from "./panels.js"
import type { DashboardsRepository, PanelRecord, PanelValues } from "./repository.js"
import {
  DASHBOARD_LIMITS,
  panelInputSchema,
  type CreateDashboardInput,
  type Dashboard,
  type DashboardDetail,
  type DashboardList,
  type DashboardPanel,
  type PanelData,
  type PanelInput,
  type UpdateDashboardInput,
  type UpdatePanelInput,
} from "./schemas.js"

const NOT_FOUND = "Dashboard not found"
const PANEL_NOT_FOUND = "Panel not found"

export interface Actor {
  userId: string
  role: WorkspaceRole
}

export interface DashboardsServiceDeps {
  dashboards: DashboardsRepository
  savedQueries: SavedQueriesRepository
  executions: QueryExecutionsRepository
}

/** A saved query deleted between checking it and saving the panel. */
function savedQueryGone(error: unknown): unknown {
  return isForeignKeyViolation(error)
    ? AppError.validation("That saved query was just deleted. Choose another.", { field: "savedQueryId" })
    : error
}

function nameTaken(name: string): AppError {
  return AppError.conflict(
    `A dashboard named “${name}” already exists in this workspace (it may be private to someone else). Choose another name.`,
  )
}

/** The creator, or a workspace owner or admin, may change a dashboard and its panels. */
export function canEdit(dashboard: Pick<Dashboard, "createdBy">, actor: Actor): boolean {
  return MANAGER_ROLES.includes(actor.role) || dashboard.createdBy?.id === actor.userId
}

function panelData(record: PanelRecord, previews: Map<string, ExecutionPreview>): PanelData | null {
  if (record.kind === "markdown") return null
  if (!record.query) return { state: "removed" }
  if (!record.query.visible) return { state: "private" }
  const preview = record.query.lastExecutionId ? previews.get(record.query.lastExecutionId) : undefined
  if (!preview) return { state: "available", savedQuery: record.query.savedQuery, latestRun: null }
  const { result, partialResult } = panelResult(record, preview.result)
  return {
    state: "available",
    savedQuery: record.query.savedQuery,
    latestRun: {
      executionId: preview.id,
      connectionId: preview.connectionId,
      createdAt: preview.createdAt,
      finishedAt: preview.finishedAt,
      parameters: preview.parameters,
      result,
      partialResult,
    },
  }
}

function toPanel(record: PanelRecord, previews: Map<string, ExecutionPreview>): DashboardPanel {
  const { query, ...panel } = record
  // Someone else's private saved query is not named, not even by its id.
  const savedQueryId = query?.visible === false ? null : panel.savedQueryId
  return { ...panel, savedQueryId, data: panelData(record, previews) }
}

/**
 * Dashboards: workspace-visible ones are every member's to view; private ones
 * only their creator's, so other members, owners, and admins get 404 as if
 * they did not exist. The creator, or an owner or admin, edits a dashboard
 * they can see. Query panels show their saved query's latest stored result,
 * as far as the viewer may see that saved query.
 */
export class DashboardsService {
  constructor(private readonly deps: DashboardsServiceDeps) {}

  list(workspaceId: string, userId: string): Promise<DashboardList> {
    return this.deps.dashboards.list(workspaceId, userId)
  }

  async get(workspaceId: string, userId: string, id: string): Promise<DashboardDetail> {
    return this.detail(workspaceId, await this.visible(workspaceId, userId, id), userId)
  }

  async create(workspaceId: string, userId: string, input: CreateDashboardInput): Promise<DashboardDetail> {
    let created: Dashboard | null
    try {
      created = await this.deps.dashboards.insert({ workspaceId, userId, ...input })
    } catch (error) {
      throw isUniqueViolation(error) ? nameTaken(input.name) : error
    }
    if (!created) {
      throw AppError.conflict(
        `A workspace can have at most ${DASHBOARD_LIMITS.perWorkspace} dashboards. Delete one to create another.`,
      )
    }
    return { ...created, panels: [] }
  }

  /** A save based on an older version gets 409 with the current dashboard. */
  async update(
    workspaceId: string,
    id: string,
    input: UpdateDashboardInput,
    actor: Actor,
  ): Promise<DashboardDetail> {
    const dashboard = await this.editable(workspaceId, id, actor)
    const { version, ...changes } = input
    // Someone else's private saved queries already show as private to everyone else.
    if (changes.visibility === "workspace" && dashboard.visibility === "private") {
      const names = await this.deps.dashboards.privateQueryNames(workspaceId, id, actor.userId)
      if (names.length > 0) {
        throw AppError.validation(
          `Panels show saved queries that only you can see (${names.map((name) => `“${name}”`).join(", ")}). Make them visible to everyone, or remove those panels, before sharing this dashboard.`,
          { field: "visibility" },
        )
      }
    }
    let result
    try {
      result = await this.deps.dashboards.update(workspaceId, id, version, changes, actor.userId)
    } catch (error) {
      throw isUniqueViolation(error) ? nameTaken(changes.name ?? dashboard.name) : error
    }
    if (result.status === "missing") throw AppError.notFound(NOT_FOUND)
    if (result.status === "stale") {
      // Read again as the actor: its creator may have made it private meanwhile.
      const current = await this.visible(workspaceId, actor.userId, id)
      throw AppError.stale("dashboard", await this.detail(workspaceId, current, actor.userId))
    }
    return this.detail(workspaceId, result.record, actor.userId)
  }

  async remove(workspaceId: string, id: string, actor: Actor): Promise<void> {
    await this.editable(workspaceId, id, actor)
    if (!(await this.deps.dashboards.delete(workspaceId, id))) throw AppError.notFound(NOT_FOUND)
  }

  async addPanel(
    workspaceId: string,
    dashboardId: string,
    input: PanelInput,
    actor: Actor,
  ): Promise<DashboardPanel> {
    const dashboard = await this.editable(workspaceId, dashboardId, actor)
    const values = await this.panelValues(workspaceId, dashboard, input, actor)
    let added
    try {
      added = await this.deps.dashboards.insertPanel(workspaceId, dashboardId, values, actor.userId)
    } catch (error) {
      throw savedQueryGone(error)
    }
    if (added === null) throw AppError.notFound(NOT_FOUND)
    if (added === "limit") {
      throw AppError.conflict(
        `A dashboard can have at most ${DASHBOARD_LIMITS.panelsPerDashboard} panels. Remove one to add another.`,
      )
    }
    return this.panel(workspaceId, dashboardId, added.id, actor.userId)
  }

  /**
   * Changes a panel's title, kind, saved query, or config; the result is
   * checked as a whole definition. A change based on an older version gets
   * 409 with the current panel.
   */
  async updatePanel(
    workspaceId: string,
    dashboardId: string,
    panelId: string,
    input: UpdatePanelInput,
    actor: Actor,
  ): Promise<DashboardPanel> {
    const dashboard = await this.editable(workspaceId, dashboardId, actor)
    const current = await this.deps.dashboards.panel(workspaceId, dashboardId, panelId, actor.userId)
    if (!current) throw AppError.notFound(PANEL_NOT_FOUND)
    const kind = input.kind ?? current.kind
    const savedQueryId = input.savedQueryId ?? current.savedQueryId ?? undefined
    const merged = parseInput(panelInputSchema, {
      kind,
      title: input.title ?? current.title,
      // Markdown panels show no saved query; one sent anyway is refused as an unknown field.
      ...(kind !== "markdown" || input.savedQueryId !== undefined ? { savedQueryId } : {}),
      config: input.config ?? (kind === current.kind ? current.config : undefined),
    })
    const values = await this.panelValues(workspaceId, dashboard, merged, actor)
    let outcome
    try {
      outcome = await this.deps.dashboards.updatePanel(
        workspaceId,
        dashboardId,
        panelId,
        input.version,
        values,
        actor.userId,
      )
    } catch (error) {
      throw savedQueryGone(error)
    }
    if (outcome === "missing") throw AppError.notFound(PANEL_NOT_FOUND)
    if (outcome === "stale") {
      throw AppError.stale("panel", await this.panel(workspaceId, dashboardId, panelId, actor.userId))
    }
    return this.panel(workspaceId, dashboardId, panelId, actor.userId)
  }

  async removePanel(workspaceId: string, dashboardId: string, panelId: string, actor: Actor): Promise<void> {
    await this.editable(workspaceId, dashboardId, actor)
    if (!(await this.deps.dashboards.deletePanel(workspaceId, dashboardId, panelId, actor.userId))) {
      throw AppError.notFound(PANEL_NOT_FOUND)
    }
  }

  /** `panelIds` lists every panel once; a list that no longer matches gets 409 with the current dashboard. */
  async reorder(
    workspaceId: string,
    dashboardId: string,
    panelIds: string[],
    actor: Actor,
  ): Promise<DashboardDetail> {
    await this.editable(workspaceId, dashboardId, actor)
    const outcome = await this.deps.dashboards.reorder(workspaceId, dashboardId, panelIds, actor.userId)
    if (outcome === "missing") throw AppError.notFound(NOT_FOUND)
    const dashboard = await this.visible(workspaceId, actor.userId, dashboardId)
    const detail = await this.detail(workspaceId, dashboard, actor.userId)
    if (outcome === "mismatch") {
      throw AppError.conflict(
        "Panels were added or removed after you opened this dashboard. Review the current order, then move them again.",
        { current: detail },
      )
    }
    return detail
  }

  /** The dashboard with its panels and each query panel's latest stored result, cut to what it shows. */
  private async detail(
    workspaceId: string,
    dashboard: Dashboard,
    viewerId: string,
  ): Promise<DashboardDetail> {
    const records = await this.deps.dashboards.panels(workspaceId, dashboard.id, viewerId)
    return { ...dashboard, panels: await this.withData(workspaceId, records) }
  }

  private async panel(
    workspaceId: string,
    dashboardId: string,
    panelId: string,
    viewerId: string,
  ): Promise<DashboardPanel> {
    const record = await this.deps.dashboards.panel(workspaceId, dashboardId, panelId, viewerId)
    if (!record) throw AppError.notFound(PANEL_NOT_FOUND)
    const [panel] = await this.withData(workspaceId, [record])
    if (!panel) throw AppError.notFound(PANEL_NOT_FOUND)
    return panel
  }

  private async withData(workspaceId: string, records: PanelRecord[]): Promise<DashboardPanel[]> {
    const runIds = new Set<string>()
    for (const record of records) {
      if (record.query?.visible && record.query.lastExecutionId) runIds.add(record.query.lastExecutionId)
    }
    const previews = await this.deps.executions.previews(workspaceId, [...runIds], DASHBOARD_LIMITS.tableRows)
    const byId = new Map(previews.map((preview) => [preview.id, preview]))
    return records.map((record) => toPanel(record, byId))
  }

  private async visible(workspaceId: string, userId: string, id: string): Promise<Dashboard> {
    const dashboard = await this.deps.dashboards.get(workspaceId, userId, id)
    if (!dashboard) throw AppError.notFound(NOT_FOUND)
    return dashboard
  }

  private async editable(workspaceId: string, id: string, actor: Actor): Promise<Dashboard> {
    const dashboard = await this.visible(workspaceId, actor.userId, id)
    if (!canEdit(dashboard, actor)) {
      throw AppError.forbidden("Only its creator or a workspace owner or admin can change this dashboard")
    }
    return dashboard
  }

  /**
   * What a panel saves. A query panel's saved query must be one the editor
   * can see, a private one only on a private dashboard, and the columns its
   * config names must be in the saved query's latest result when it has one.
   */
  private async panelValues(
    workspaceId: string,
    dashboard: Dashboard,
    input: PanelInput,
    actor: Actor,
  ): Promise<PanelValues> {
    if (input.kind === "markdown") return { ...input, savedQueryId: null }
    const savedQuery = await this.deps.savedQueries.get(workspaceId, actor.userId, input.savedQueryId)
    if (!savedQuery) {
      throw AppError.validation("Choose a saved query you can see in this workspace.", {
        field: "savedQueryId",
      })
    }
    if (savedQuery.visibility === "private" && dashboard.visibility === "workspace") {
      throw AppError.validation(
        `“${savedQuery.name}” is visible only to you, so it can only be shown on a private dashboard. Make it visible to everyone first, or use a private dashboard.`,
        { field: "savedQueryId" },
      )
    }
    if (savedQuery.lastExecutionId) {
      const [latest] = await this.deps.executions.previews(workspaceId, [savedQuery.lastExecutionId], 0)
      const problem = latest ? columnProblem(input, latest.result.columns) : null
      if (problem)
        throw AppError.validation(problem.message, { field: problem.field, column: problem.column })
    }
    return input
  }
}
