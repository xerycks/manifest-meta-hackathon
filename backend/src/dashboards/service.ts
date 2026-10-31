import type { ExecutionPreview, LatestRun, QueryExecutionsRepository } from "../queries/repository.js"
import type { SavedQueriesRepository } from "../saved-queries/repository.js"
import type { SavedQueriesService } from "../saved-queries/service.js"
import { AppError } from "../shared/http/errors.js"
import { parseInput } from "../shared/http/validate.js"
import { isCheckViolation, isForeignKeyViolation, isUniqueViolation } from "../shared/postgres/errors.js"
import { MANAGER_ROLES } from "../workspaces/access.js"
import type { WorkspaceRole } from "../workspaces/repository.js"
import { GRID } from "./layout.js"
import { columnProblem, panelResult, panelRows } from "./panels.js"
import type { DashboardRefresher, RefreshProgress } from "./refresh.js"
import type { DashboardsRepository, PanelRecord, PanelValues } from "./repository.js"
import {
  DASHBOARD_LIMITS,
  panelInputSchema,
  type CreateDashboardInput,
  type Dashboard,
  type DashboardDetail,
  type DashboardList,
  type DashboardPanel,
  type DashboardRefresh,
  type PanelData,
  type PanelInput,
  type PanelStatus,
  type SaveLayoutInput,
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
  /** Running panels' saved queries; null without CONNECTION_ENCRYPTION_KEY (refreshes answer 503). */
  refreshes: { refresher: DashboardRefresher; runs: SavedQueriesService } | null
}

/**
 * A saved query deleted between checking it and saving the panel, or a panel
 * placed (below the others, or pushed down as it grows) past the grid's last row.
 */
function panelNotSaved(error: unknown): unknown {
  if (isForeignKeyViolation(error)) {
    return AppError.validation("That saved query was just deleted. Choose another.", { field: "savedQueryId" })
  }
  if (isCheckViolation(error, "dashboard_panels_grid_check")) {
    return AppError.conflict(
      `There is no room for this panel within the grid's ${GRID.maxRow} rows. Move panels up to make room, then try again.`,
    )
  }
  return error
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

function toPanel(
  record: PanelRecord,
  previews: Map<string, ExecutionPreview>,
  statuses: Map<string, PanelStatus>,
): DashboardPanel {
  const { query, ...panel } = record
  // Someone else's private saved query is not named, not even by its id.
  const savedQueryId = query?.visible === false ? null : panel.savedQueryId
  return {
    ...panel,
    savedQueryId,
    data: panelData(record, previews),
    status: statuses.get(record.id) ?? null,
  }
}

/** The saved query a panel shows, when the viewer may read it. */
function readableQuery(record: PanelRecord): string | null {
  return record.kind !== "markdown" && record.query?.visible ? record.savedQueryId : null
}

/** Why a refresh cannot run a panel's saved query, or null when it can. */
function refreshProblem(record: PanelRecord): string | null {
  if (record.kind === "markdown") return "A Markdown panel has nothing to refresh."
  if (!record.query) return "This panel's saved query was deleted."
  if (!record.query.visible) return "This panel shows a saved query that only its creator can see."
  if (record.query.savedQuery.needsValues) {
    return `“${record.query.savedQuery.name}” needs parameter values, so run it from its own page.`
  }
  return null
}

const time = (iso: string) => Date.parse(iso)

/**
 * A panel's status from its saved query's latest run and this process's
 * refreshes. A failure noted by a refresh (such as a run that never got a
 * slot) counts when it is at least as new as the latest recorded run.
 */
function panelStatus(
  latest: LatestRun | undefined,
  progress: RefreshProgress,
  savedQueryId: string,
): PanelStatus {
  const lastSuccessAt = latest?.lastSuccessAt ?? null
  const run = latest?.latest ?? null
  if (progress.refreshing.has(savedQueryId) || run?.status === "running") {
    const since = progress.refreshing.get(savedQueryId) ?? run?.createdAt ?? null
    return { state: "refreshing", since, lastSuccessAt }
  }
  const noted = progress.failures.get(savedQueryId)
  if (noted && (!run || time(noted.at) >= time(run.createdAt))) {
    return noted.code === "QUERY_CANCELLED"
      ? { state: "stale", reason: "cancelled", lastSuccessAt }
      : { state: "failed", failure: noted, lastSuccessAt }
  }
  if (!run) return { state: "stale", reason: "not_run", lastSuccessAt }
  switch (run.status) {
    case "succeeded":
      return { state: "fresh", lastSuccessAt: lastSuccessAt ?? run.createdAt }
    case "cancelled":
      return { state: "stale", reason: "cancelled", lastSuccessAt }
    default:
      return {
        state: "failed",
        failure: {
          code: run.error?.code ?? "QUERY_FAILED",
          message: run.error?.message ?? "The query did not succeed.",
          at: run.finishedAt ?? run.createdAt,
        },
        lastSuccessAt,
      }
  }
}

const IDLE: RefreshProgress = { active: false, startedAt: null, refreshing: new Map(), failures: new Map() }

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
    return { ...created, panels: [], refresh: { active: false, startedAt: null } }
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
      throw panelNotSaved(error)
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
      throw panelNotSaved(error)
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

  /**
   * Saves every panel's box at once. A layout based on an older one, or one
   * that no longer lists exactly the dashboard's panels, gets 409 with the
   * current dashboard; boxes that leave the grid, are smaller than their
   * kind allows, or overlap get 422 naming the panel.
   */
  async saveLayout(
    workspaceId: string,
    dashboardId: string,
    input: SaveLayoutInput,
    actor: Actor,
  ): Promise<DashboardDetail> {
    await this.editable(workspaceId, dashboardId, actor)
    const boxes = input.boxes.map(({ panelId, ...box }) => ({ id: panelId, ...box }))
    const outcome = await this.deps.dashboards.saveLayout(
      workspaceId,
      dashboardId,
      input.version,
      boxes,
      actor.userId,
    )
    if (outcome === "missing") throw AppError.notFound(NOT_FOUND)
    if (typeof outcome === "object") {
      throw AppError.validation(outcome.message, { field: "boxes", panelId: outcome.panelId })
    }
    const dashboard = await this.visible(workspaceId, actor.userId, dashboardId)
    const detail = await this.detail(workspaceId, dashboard, actor.userId)
    if (outcome === "stale") throw AppError.stale("dashboard's layout", detail)
    if (outcome === "mismatch") {
      throw AppError.conflict(
        "Panels were added or removed after you opened this dashboard. Review the current layout, then move them again.",
        { current: detail },
      )
    }
    return detail
  }

  /**
   * Runs the saved queries of the dashboard's panels (or of the listed ones)
   * with their defaults as the viewer, each once however many panels show
   * it. Panels that cannot run here are skipped, or refused when listed:
   * Markdown, removed or private saved queries, and saved queries that need
   * parameter values. Answers at once with the refresh's progress.
   */
  async refresh(
    workspaceId: string,
    dashboardId: string,
    userId: string,
    panelIds: string[] | undefined,
  ): Promise<DashboardRefresh> {
    const { refresher, runs } = this.refreshes()
    await this.visible(workspaceId, userId, dashboardId)
    const records = await this.deps.dashboards.panels(workspaceId, dashboardId, userId)
    const chosen = panelIds
      ? panelIds.map((id) => {
          const record = records.find((candidate) => candidate.id === id)
          if (!record) throw AppError.notFound(PANEL_NOT_FOUND)
          const problem = refreshProblem(record)
          if (problem) throw AppError.validation(problem, { field: "panelIds", panelId: id })
          return record
        })
      : records.filter((record) => !refreshProblem(record))
    const savedQueryIds = new Set(chosen.flatMap((record) => readableQuery(record) ?? []))
    refresher.start(
      workspaceId,
      dashboardId,
      [...savedQueryIds].map((savedQueryId) => ({
        savedQueryId,
        run: (signal: AbortSignal) =>
          runs.run(workspaceId, userId, savedQueryId, {}, { signal, origin: "dashboard" }),
      })),
    )
    return this.refreshState(workspaceId, dashboardId, records)
  }

  /** Stops the dashboard's refresh; runs that another refresh still waits on keep going. */
  async cancelRefresh(workspaceId: string, dashboardId: string, userId: string): Promise<DashboardRefresh> {
    const { refresher } = this.refreshes()
    await this.visible(workspaceId, userId, dashboardId)
    await refresher.cancel(workspaceId, dashboardId)
    const records = await this.deps.dashboards.panels(workspaceId, dashboardId, userId)
    return this.refreshState(workspaceId, dashboardId, records)
  }

  /** Whether the dashboard is refreshing, with every panel's status. */
  async refreshProgress(workspaceId: string, dashboardId: string, userId: string): Promise<DashboardRefresh> {
    await this.visible(workspaceId, userId, dashboardId)
    const records = await this.deps.dashboards.panels(workspaceId, dashboardId, userId)
    return this.refreshState(workspaceId, dashboardId, records)
  }

  private refreshes(): NonNullable<DashboardsServiceDeps["refreshes"]> {
    if (!this.deps.refreshes) throw AppError.connectionsNotConfigured()
    return this.deps.refreshes
  }

  private async refreshState(
    workspaceId: string,
    dashboardId: string,
    records: PanelRecord[],
  ): Promise<DashboardRefresh> {
    const { progress, statuses } = await this.statuses(workspaceId, dashboardId, records)
    return {
      active: progress.active,
      startedAt: progress.startedAt,
      panels: records.map((record) => ({ id: record.id, status: statuses.get(record.id) ?? null })),
    }
  }

  /** Each query panel's status, by panel id. */
  private async statuses(
    workspaceId: string,
    dashboardId: string,
    records: PanelRecord[],
  ): Promise<{ progress: RefreshProgress; statuses: Map<string, PanelStatus> }> {
    const savedQueryIds = [...new Set(records.flatMap((record) => readableQuery(record) ?? []))]
    const latest = await this.deps.executions.latestForSavedQueries(workspaceId, savedQueryIds)
    const progress = this.deps.refreshes?.refresher.progress(workspaceId, dashboardId, savedQueryIds) ?? IDLE
    const statuses = new Map<string, PanelStatus>()
    for (const record of records) {
      const savedQueryId = readableQuery(record)
      if (savedQueryId) statuses.set(record.id, panelStatus(latest.get(savedQueryId), progress, savedQueryId))
    }
    return { progress, statuses }
  }

  /** The dashboard with its panels: each query panel's latest stored result, cut to what it shows, and status. */
  private async detail(
    workspaceId: string,
    dashboard: Dashboard,
    viewerId: string,
  ): Promise<DashboardDetail> {
    const records = await this.deps.dashboards.panels(workspaceId, dashboard.id, viewerId)
    const [previews, { progress, statuses }] = await Promise.all([
      this.previews(workspaceId, records),
      this.statuses(workspaceId, dashboard.id, records),
    ])
    return {
      ...dashboard,
      panels: records.map((record) => toPanel(record, previews, statuses)),
      refresh: { active: progress.active, startedAt: progress.startedAt },
    }
  }

  private async panel(
    workspaceId: string,
    dashboardId: string,
    panelId: string,
    viewerId: string,
  ): Promise<DashboardPanel> {
    const record = await this.deps.dashboards.panel(workspaceId, dashboardId, panelId, viewerId)
    if (!record) throw AppError.notFound(PANEL_NOT_FOUND)
    const [previews, { statuses }] = await Promise.all([
      this.previews(workspaceId, [record]),
      this.statuses(workspaceId, dashboardId, [record]),
    ])
    return toPanel(record, previews, statuses)
  }

  /** Reads each latest result once, with as many leading rows as the panels showing it need. */
  private async previews(
    workspaceId: string,
    records: PanelRecord[],
  ): Promise<Map<string, ExecutionPreview>> {
    const rowsByRun = new Map<string, number>()
    for (const record of records) {
      const runId = record.query?.visible ? record.query.lastExecutionId : null
      if (runId) rowsByRun.set(runId, Math.max(rowsByRun.get(runId) ?? 0, panelRows(record.kind).rows))
    }
    const idsByRows = new Map<number, string[]>()
    for (const [runId, rows] of rowsByRun) idsByRows.set(rows, [...(idsByRows.get(rows) ?? []), runId])
    const previews = await Promise.all(
      [...idsByRows].map(([rows, ids]) => this.deps.executions.previews(workspaceId, ids, rows)),
    )
    return new Map(previews.flat().map((preview) => [preview.id, preview]))
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
