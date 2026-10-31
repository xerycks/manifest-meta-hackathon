import type { Pool, PoolClient } from "pg"

import { authorNameSql, toAuthor } from "../auth/repository.js"
import type { Engine } from "../connections/schemas.js"
import type { ParameterDefinition } from "../saved-queries/schemas.js"
import { versionedOutcome, type VersionedSave } from "../shared/postgres/versioned.js"
import { plainText, snippet } from "../shared/text.js"
import { bottom, fitKind, layoutProblem, PANEL_SIZES, type PlacedBox } from "./layout.js"
import {
  DASHBOARD_LIMITS,
  type Dashboard,
  type DashboardList,
  type PanelBox,
  type PanelConfig,
  type PanelDefinition,
  type PanelKind,
  type PanelSavedQuery,
  type Visibility,
} from "./schemas.js"

interface DashboardRow {
  id: string
  name: string
  description: string
  visibility: Visibility
  version: number
  layout_version: number
  panel_count: number
  created_by: string | null
  created_by_name: string | null
  updated_by: string | null
  updated_by_name: string | null
  created_at: Date
  updated_at: Date
}

interface PanelRow {
  id: string
  kind: PanelKind
  title: string
  saved_query_id: string | null
  config: PanelConfig
  grid_x: number
  grid_y: number
  grid_w: number
  grid_h: number
  version: number
  created_at: Date
  updated_at: Date
  query_visible: boolean | null
  query_name: string | null
  query_visibility: Visibility | null
  query_parameters: ParameterDefinition[] | null
  last_execution_id: string | null
  last_run_at: Date | null
  connection_id: string | null
  connection_name: string | null
  engine: Engine | null
}

/** Characters of the description read for a list excerpt. */
const EXCERPT_SOURCE = 1_000
const EXCERPT_LENGTH = 200

const dashboardSelect = (description: string) => `
  SELECT d.id, d.name, ${description} AS description, d.visibility, d.version, d.layout_version,
         d.created_at, d.updated_at,
         (SELECT count(*)::int FROM dashboard_panels p
           WHERE p.workspace_id = d.workspace_id AND p.dashboard_id = d.id) AS panel_count,
         d.created_by, ${authorNameSql("cu")} AS created_by_name,
         d.updated_by, ${authorNameSql("uu")} AS updated_by_name
    FROM dashboards d
    LEFT JOIN users cu ON cu.id = d.created_by
    LEFT JOIN users uu ON uu.id = d.updated_by`

/** Workspace-visible dashboards, and the viewer's own private ones. */
const VISIBLE = "(d.visibility = 'workspace' OR d.created_by = $2)"

// A panel's saved query only resolves within the panel's workspace; whether the
// viewer ($3) may see it decides what the panel shows.
const panelSelect = `
  SELECT p.id, p.kind, p.title, p.saved_query_id, p.config, p.grid_x, p.grid_y, p.grid_w, p.grid_h,
         p.version, p.created_at, p.updated_at,
         CASE WHEN s.id IS NOT NULL
              THEN s.visibility = 'workspace' OR s.created_by IS NOT DISTINCT FROM $3 END AS query_visible,
         s.name AS query_name, s.visibility AS query_visibility, s.parameters AS query_parameters,
         s.last_execution_id, s.last_run_at, c.id AS connection_id, c.name AS connection_name, c.engine
    FROM dashboard_panels p
    LEFT JOIN saved_queries s ON s.workspace_id = p.workspace_id AND s.id = p.saved_query_id
    LEFT JOIN connections c ON c.workspace_id = s.workspace_id AND c.id = s.connection_id`

const PANEL_ORDER = "ORDER BY p.grid_y, p.grid_x, p.created_at, p.id"

function toDashboard(row: DashboardRow): Dashboard {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    version: row.version,
    layoutVersion: row.layout_version,
    createdBy: toAuthor(row.created_by, row.created_by_name),
    updatedBy: toAuthor(row.updated_by, row.updated_by_name),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

/** The saved query behind a panel as stored, before deciding what the viewer gets. */
export type PanelQuery =
  { visible: false } | { visible: true; savedQuery: PanelSavedQuery; lastExecutionId: string | null }

export type PanelRecord = PanelDefinition & {
  id: string
  title: string
  savedQueryId: string | null
  layout: PanelBox
  version: number
  createdAt: string
  updatedAt: string
  /** Null for Markdown panels and once the saved query is deleted. */
  query: PanelQuery | null
}

function toPanelQuery(row: PanelRow): PanelQuery | null {
  if (row.query_visible === null) return null
  if (!row.query_visible) return { visible: false }
  return {
    visible: true,
    savedQuery: {
      id: row.saved_query_id as string,
      name: row.query_name as string,
      source: {
        id: row.connection_id as string,
        name: row.connection_name as string,
        engine: row.engine as Engine,
      },
      visibility: row.query_visibility as Visibility,
      lastRunAt: row.last_run_at?.toISOString() ?? null,
      needsValues: (row.query_parameters ?? []).some((parameter) => parameter.required && !parameter.default),
    },
    lastExecutionId: row.last_execution_id,
  }
}

function toPanel(row: PanelRow): PanelRecord {
  return {
    ...({ kind: row.kind, config: row.config } as PanelDefinition),
    id: row.id,
    title: row.title,
    savedQueryId: row.saved_query_id,
    layout: { x: row.grid_x, y: row.grid_y, w: row.grid_w, h: row.grid_h },
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    query: toPanelQuery(row),
  }
}

export interface DashboardChanges {
  name?: string | undefined
  description?: string | undefined
  visibility?: Visibility | undefined
}

/** A panel as saved: its definition, title, and (for query panels) its saved query. */
export type PanelValues = PanelDefinition & { title: string; savedQueryId: string | null }

/** Dashboards and their panels; every query filters on workspace_id, and reads on what the viewer may see. */
export class DashboardsRepository {
  constructor(private readonly pool: Pool) {}

  /** Recently updated first; bounded by the per-workspace limit. */
  async list(workspaceId: string, viewerId: string): Promise<DashboardList> {
    const { rows } = await this.pool.query<DashboardRow>(
      `${dashboardSelect(`left(d.description, ${EXCERPT_SOURCE})`)}
        WHERE d.workspace_id = $1 AND ${VISIBLE}
        ORDER BY d.updated_at DESC, d.id
        LIMIT ${DASHBOARD_LIMITS.perWorkspace}`,
      [workspaceId, viewerId],
    )
    return {
      dashboards: rows.map((row) => {
        const { description, ...summary } = toDashboard(row)
        return {
          ...summary,
          excerpt: snippet(plainText(description), null, EXCERPT_LENGTH),
          panelCount: row.panel_count,
        }
      }),
    }
  }

  /** A dashboard the viewer may see; with a null viewer, whatever its visibility. */
  async get(workspaceId: string, viewerId: string | null, id: string): Promise<Dashboard | null> {
    const { rows } = await this.pool.query<DashboardRow>(
      `${dashboardSelect("d.description")}
        WHERE d.workspace_id = $1 AND ($2::uuid IS NULL OR ${VISIBLE}) AND d.id = $3`,
      [workspaceId, viewerId, id],
    )
    return rows[0] ? toDashboard(rows[0]) : null
  }

  /**
   * Null when the workspace already has as many dashboards as allowed. Rejects
   * with a unique violation (23505) when the name is taken in the workspace.
   */
  async insert(input: {
    workspaceId: string
    userId: string
    name: string
    description: string
    visibility: Visibility
  }): Promise<Dashboard | null> {
    const id = await this.transaction(async (client) => {
      // Creations in one workspace take turns, so the count cannot be passed.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('dashboards:' || $1, 0))", [
        input.workspaceId,
      ])
      const { rows: counted } = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM dashboards WHERE workspace_id = $1",
        [input.workspaceId],
      )
      if ((counted[0]?.count ?? 0) >= DASHBOARD_LIMITS.perWorkspace) return null
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO dashboards (workspace_id, name, description, visibility, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5)
         RETURNING id`,
        [input.workspaceId, input.name, input.description, input.visibility, input.userId],
      )
      return rows[0]?.id ?? null
    })
    if (!id) return null
    const created = await this.get(input.workspaceId, null, id)
    if (!created) throw new Error("A created dashboard could not be read back")
    return created
  }

  /** May reject with a unique violation like insert. */
  async update(
    workspaceId: string,
    id: string,
    version: number,
    changes: DashboardChanges,
    userId: string,
  ): Promise<VersionedSave<Dashboard>> {
    const values: unknown[] = [workspaceId, id, version, userId]
    const param = (value: unknown) => `$${values.push(value)}`
    const set = ["version = version + 1", "updated_by = $4", "updated_at = now()"]
    if (changes.name !== undefined) set.push(`name = ${param(changes.name)}`)
    if (changes.description !== undefined) set.push(`description = ${param(changes.description)}`)
    if (changes.visibility !== undefined) set.push(`visibility = ${param(changes.visibility)}`)
    const result = await this.pool.query(
      `UPDATE dashboards SET ${set.join(", ")}
        WHERE workspace_id = $1 AND id = $2 AND version = $3`,
      values,
    )
    return versionedOutcome((result.rowCount ?? 0) > 0, () => this.get(workspaceId, null, id))
  }

  /** Deletes the dashboard with its panels; the saved queries they showed stay. */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM dashboards WHERE workspace_id = $1 AND id = $2", [
      workspaceId,
      id,
    ])
    return (rowCount ?? 0) > 0
  }

  /** The dashboard's panels in order, with their saved queries as `viewerId` may see them. */
  async panels(workspaceId: string, dashboardId: string, viewerId: string): Promise<PanelRecord[]> {
    const { rows } = await this.pool.query<PanelRow>(
      `${panelSelect} WHERE p.workspace_id = $1 AND p.dashboard_id = $2 ${PANEL_ORDER}`,
      [workspaceId, dashboardId, viewerId],
    )
    return rows.map(toPanel)
  }

  async panel(
    workspaceId: string,
    dashboardId: string,
    panelId: string,
    viewerId: string,
  ): Promise<PanelRecord | null> {
    const { rows } = await this.pool.query<PanelRow>(
      `${panelSelect} WHERE p.workspace_id = $1 AND p.dashboard_id = $2 AND p.id = $4`,
      [workspaceId, dashboardId, viewerId, panelId],
    )
    return rows[0] ? toPanel(rows[0]) : null
  }

  /** Names of `userId`'s private saved queries that the dashboard's panels show. */
  async privateQueryNames(workspaceId: string, dashboardId: string, userId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ name: string }>(
      `SELECT DISTINCT s.name FROM dashboard_panels p
         JOIN saved_queries s ON s.workspace_id = p.workspace_id AND s.id = p.saved_query_id
        WHERE p.workspace_id = $1 AND p.dashboard_id = $2 AND s.visibility = 'private' AND s.created_by = $3
        ORDER BY s.name`,
      [workspaceId, dashboardId, userId],
    )
    return rows.map((row) => row.name)
  }

  /** Adds a panel below the others at its kind's default size; "limit" when the dashboard is full, null when it is gone. */
  async insertPanel(
    workspaceId: string,
    dashboardId: string,
    values: PanelValues,
    userId: string,
  ): Promise<{ id: string } | "limit" | null> {
    return this.panelChange<{ id: string } | "limit">(workspaceId, dashboardId, userId, async (client) => {
      const boxes = await this.boxes(client, workspaceId, dashboardId)
      if (boxes.length >= DASHBOARD_LIMITS.panelsPerDashboard)
        return { changed: false, result: "limit" as const }
      const size = PANEL_SIZES[values.kind].default
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO dashboard_panels
           (workspace_id, dashboard_id, kind, title, saved_query_id, config, grid_x, grid_y, grid_w, grid_h)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 0, $7, $8, $9)
         RETURNING id`,
        [
          workspaceId,
          dashboardId,
          values.kind,
          values.title,
          values.savedQueryId,
          JSON.stringify(values.config),
          bottom(boxes),
          size.w,
          size.h,
        ],
      )
      const id = rows[0]?.id
      if (!id) throw new Error("Panel insert returned no row")
      return { changed: true, result: { id } }
    })
  }

  /**
   * Replaces a panel's definition if it is still at `version`. A panel too
   * small for its new kind grows to the kind's minimum, pushing others down.
   */
  async updatePanel(
    workspaceId: string,
    dashboardId: string,
    panelId: string,
    version: number,
    values: PanelValues,
    userId: string,
  ): Promise<"saved" | "stale" | "missing"> {
    const outcome = await this.panelChange(workspaceId, dashboardId, userId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE dashboard_panels
            SET kind = $5, title = $6, saved_query_id = $7, config = $8::jsonb, version = version + 1,
                updated_at = now()
          WHERE workspace_id = $1 AND dashboard_id = $2 AND id = $3 AND version = $4`,
        [
          workspaceId,
          dashboardId,
          panelId,
          version,
          values.kind,
          values.title,
          values.savedQueryId,
          JSON.stringify(values.config),
        ],
      )
      if ((rowCount ?? 0) > 0) {
        const fitted = fitKind(await this.boxes(client, workspaceId, dashboardId), panelId, values.kind)
        if (fitted) await this.writeLayout(client, workspaceId, dashboardId, fitted)
        return { changed: true, result: "saved" as const }
      }
      const { rowCount: exists } = await client.query(
        "SELECT 1 FROM dashboard_panels WHERE workspace_id = $1 AND dashboard_id = $2 AND id = $3",
        [workspaceId, dashboardId, panelId],
      )
      return { changed: false, result: exists ? ("stale" as const) : ("missing" as const) }
    })
    return outcome ?? "missing"
  }

  async deletePanel(
    workspaceId: string,
    dashboardId: string,
    panelId: string,
    userId: string,
  ): Promise<boolean> {
    const deleted = await this.panelChange(workspaceId, dashboardId, userId, async (client) => {
      const { rowCount } = await client.query(
        "DELETE FROM dashboard_panels WHERE workspace_id = $1 AND dashboard_id = $2 AND id = $3",
        [workspaceId, dashboardId, panelId],
      )
      const changed = (rowCount ?? 0) > 0
      return { changed, result: changed }
    })
    return deleted === true
  }

  /**
   * Saves every panel's box if the layout is still at `version`. "mismatch"
   * (nothing changed) when the boxes do not name exactly the dashboard's
   * panels, e.g. because someone added or removed one since; a problem when
   * the boxes do not fit the grid or the panels' kinds, or overlap.
   */
  async saveLayout(
    workspaceId: string,
    dashboardId: string,
    version: number,
    boxes: PlacedBox[],
    userId: string,
  ): Promise<"saved" | "stale" | "mismatch" | { panelId: string; message: string } | "missing"> {
    type Outcome = "saved" | "stale" | "mismatch" | { panelId: string; message: string }
    const outcome = await this.panelChange<Outcome>(workspaceId, dashboardId, userId, async (client) => {
      const { rows: current } = await client.query<{ layout_version: number }>(
        "SELECT layout_version FROM dashboards WHERE workspace_id = $1 AND id = $2",
        [workspaceId, dashboardId],
      )
      if (current[0]?.layout_version !== version) return { changed: false, result: "stale" }
      const { rows } = await client.query<{ id: string; kind: PanelKind }>(
        "SELECT id, kind FROM dashboard_panels WHERE workspace_id = $1 AND dashboard_id = $2",
        [workspaceId, dashboardId],
      )
      const kinds = new Map(rows.map((row) => [row.id, row.kind]))
      if (kinds.size !== boxes.length || !boxes.every((box) => kinds.has(box.id))) {
        return { changed: false, result: "mismatch" }
      }
      const problem = layoutProblem(boxes, kinds)
      if (problem) return { changed: false, result: problem }
      await this.writeLayout(client, workspaceId, dashboardId, boxes)
      return { changed: true, result: "saved" }
    })
    return outcome ?? "missing"
  }

  /** The dashboard's panels' boxes, read inside a panel change. */
  private async boxes(client: PoolClient, workspaceId: string, dashboardId: string): Promise<PlacedBox[]> {
    const { rows } = await client.query<PlacedBox>(
      `SELECT id, grid_x AS x, grid_y AS y, grid_w AS w, grid_h AS h
         FROM dashboard_panels WHERE workspace_id = $1 AND dashboard_id = $2`,
      [workspaceId, dashboardId],
    )
    return rows
  }

  /** Writes the boxes and moves the layout to its next version. */
  private async writeLayout(
    client: PoolClient,
    workspaceId: string,
    dashboardId: string,
    boxes: PlacedBox[],
  ): Promise<void> {
    await client.query(
      `UPDATE dashboard_panels p SET grid_x = b.x, grid_y = b.y, grid_w = b.w, grid_h = b.h
         FROM unnest($3::uuid[], $4::int[], $5::int[], $6::int[], $7::int[]) AS b (id, x, y, w, h)
        WHERE p.workspace_id = $1 AND p.dashboard_id = $2 AND p.id = b.id`,
      [
        workspaceId,
        dashboardId,
        boxes.map((box) => box.id),
        boxes.map((box) => box.x),
        boxes.map((box) => box.y),
        boxes.map((box) => box.w),
        boxes.map((box) => box.h),
      ],
    )
    await client.query(
      "UPDATE dashboards SET layout_version = layout_version + 1 WHERE workspace_id = $1 AND id = $2",
      [workspaceId, dashboardId],
    )
  }

  /**
   * Runs a change to a dashboard's panels in a transaction that holds the
   * dashboard's row, so changes to one dashboard's panels take turns, and
   * marks the dashboard updated when something changed. Null when the
   * dashboard does not exist (any more).
   */
  private async panelChange<R>(
    workspaceId: string,
    dashboardId: string,
    userId: string,
    work: (client: PoolClient) => Promise<{ changed: boolean; result: R }>,
  ): Promise<R | null> {
    const outcome = await this.transaction(async (client) => {
      const { rowCount } = await client.query(
        "SELECT 1 FROM dashboards WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        [workspaceId, dashboardId],
      )
      if (!rowCount) return null
      const { changed, result } = await work(client)
      if (changed) {
        await client.query(
          "UPDATE dashboards SET updated_at = now(), updated_by = $3 WHERE workspace_id = $1 AND id = $2",
          [workspaceId, dashboardId, userId],
        )
      }
      return { result }
    })
    return outcome ? outcome.result : null
  }

  /** Runs `work` in a transaction; a null result rolls it back. */
  private async transaction<T>(work: (client: PoolClient) => Promise<T | null>): Promise<T | null> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await work(client)
      await client.query(result === null ? "ROLLBACK" : "COMMIT")
      return result
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }
}
