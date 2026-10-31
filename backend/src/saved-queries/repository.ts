import type { Pool, PoolClient } from "pg"

import { authorNameSql, toAuthor } from "../auth/repository.js"
import type { Engine } from "../connections/schemas.js"
import type { ReadQuery } from "../queries/schemas.js"
import { likePattern } from "../shared/postgres/like.js"
import { versionedOutcome, type VersionedSave } from "../shared/postgres/versioned.js"
import { plainText, snippet } from "../shared/text.js"
import type {
  ListSavedQueriesQuery,
  ParameterDefinition,
  SavedQuery,
  SavedQueryList,
  SavedQueryOrigin,
  Visibility,
} from "./schemas.js"

interface SavedQueryRow {
  id: string
  connection_id: string
  connection_name: string
  engine: Engine
  name: string
  description: string
  query: ReadQuery
  parameters: ParameterDefinition[]
  visibility: Visibility
  origin: SavedQueryOrigin | null
  version: number
  last_execution_id: string | null
  last_run_at: Date | null
  created_by: string | null
  created_by_name: string | null
  updated_by: string | null
  updated_by_name: string | null
  created_at: Date
  updated_at: Date
}

/** Characters of the description read for a list excerpt. */
const EXCERPT_SOURCE = 1_000
const EXCERPT_LENGTH = 200

// The source always resolves: removing a source removes its saved queries.
const savedQuerySelect = (description: string) => `
  SELECT s.id, s.connection_id, c.name AS connection_name, c.engine, s.name,
         ${description} AS description, s.query, s.parameters, s.visibility, s.origin, s.version,
         s.last_execution_id, s.last_run_at, s.created_at, s.updated_at,
         s.created_by, ${authorNameSql("cu")} AS created_by_name,
         s.updated_by, ${authorNameSql("uu")} AS updated_by_name
    FROM saved_queries s
    JOIN connections c ON c.workspace_id = s.workspace_id AND c.id = s.connection_id
    LEFT JOIN users cu ON cu.id = s.created_by
    LEFT JOIN users uu ON uu.id = s.updated_by`

/** Workspace-visible saved queries, and the viewer's own private ones. */
const VISIBLE = "(s.visibility = 'workspace' OR s.created_by = $2)"

function toSavedQuery(row: SavedQueryRow): SavedQuery {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: { id: row.connection_id, name: row.connection_name, engine: row.engine },
    language: row.query.language,
    query: row.query,
    parameters: row.parameters,
    visibility: row.visibility,
    origin: row.origin,
    version: row.version,
    lastExecutionId: row.last_execution_id,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    createdBy: toAuthor(row.created_by, row.created_by_name),
    updatedBy: toAuthor(row.updated_by, row.updated_by_name),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export interface NewSavedQuery {
  workspaceId: string
  connectionId: string
  name: string
  description: string
  query: ReadQuery
  parameters: ParameterDefinition[]
  visibility: Visibility
  origin: SavedQueryOrigin | null
  userId: string
}

export interface SavedQueryChanges {
  name?: string | undefined
  description?: string | undefined
  query?: ReadQuery | undefined
  parameters?: ParameterDefinition[] | undefined
  visibility?: Visibility | undefined
}

/** Saved queries; every query filters on workspace_id, and reads on what the viewer may see. */
export class SavedQueriesRepository {
  constructor(private readonly pool: Pool) {}

  /** Recently updated first; with a search, name matches come before description matches. */
  async list(workspaceId: string, viewerId: string, query: ListSavedQueriesQuery): Promise<SavedQueryList> {
    const { rows } = await this.pool.query<SavedQueryRow>(
      `${savedQuerySelect(`left(s.description, ${EXCERPT_SOURCE})`)}
        WHERE s.workspace_id = $1 AND ${VISIBLE}
          AND ($3::text IS NULL OR s.name ILIKE $3 OR s.description ILIKE $3)
          AND ($4::uuid IS NULL OR s.connection_id = $4)
        ORDER BY ($3::text IS NOT NULL AND s.name ILIKE $3) DESC, s.updated_at DESC, s.id
        LIMIT $5 OFFSET $6`,
      [
        workspaceId,
        viewerId,
        query.search ? likePattern(query.search) : null,
        query.connectionId ?? null,
        query.limit + 1,
        query.offset,
      ],
    )
    const page = rows.slice(0, query.limit)
    return {
      savedQueries: page.map((row) => {
        const { query: _query, description, ...summary } = toSavedQuery(row)
        return { ...summary, excerpt: snippet(plainText(description), null, EXCERPT_LENGTH) }
      }),
      nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
    }
  }

  async count(workspaceId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM saved_queries WHERE workspace_id = $1",
      [workspaceId],
    )
    return rows[0]?.count ?? 0
  }

  /** A saved query the viewer may see; with a null viewer, whatever its visibility. */
  async get(workspaceId: string, viewerId: string | null, id: string): Promise<SavedQuery | null> {
    const { rows } = await this.pool.query<SavedQueryRow>(
      `${savedQuerySelect("s.description")}
        WHERE s.workspace_id = $1 AND ($2::uuid IS NULL OR ${VISIBLE}) AND s.id = $3`,
      [workspaceId, viewerId, id],
    )
    return rows[0] ? toSavedQuery(rows[0]) : null
  }

  /** Rejects with a unique violation (23505) when the name is taken in the workspace. */
  async insert(input: NewSavedQuery): Promise<SavedQuery> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO saved_queries
         (workspace_id, connection_id, name, description, query, parameters, visibility, origin,
          created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::json, $6::jsonb, $7, $8::jsonb, $9, $9)
       RETURNING id`,
      [
        input.workspaceId,
        input.connectionId,
        input.name,
        input.description,
        JSON.stringify(input.query),
        JSON.stringify(input.parameters),
        input.visibility,
        input.origin ? JSON.stringify(input.origin) : null,
        input.userId,
      ],
    )
    const id = rows[0]?.id
    const saved = id ? await this.get(input.workspaceId, null, id) : null
    if (!saved) throw new Error("A created saved query could not be read back")
    return saved
  }

  /** May reject with a unique violation like insert. */
  async update(
    workspaceId: string,
    id: string,
    version: number,
    changes: SavedQueryChanges,
    userId: string,
  ): Promise<VersionedSave<SavedQuery>> {
    const values: unknown[] = [workspaceId, id, version, userId]
    const param = (value: unknown) => `$${values.push(value)}`
    const set = ["version = version + 1", "updated_by = $4", "updated_at = now()"]
    if (changes.name !== undefined) set.push(`name = ${param(changes.name)}`)
    if (changes.description !== undefined) set.push(`description = ${param(changes.description)}`)
    if (changes.query !== undefined) set.push(`query = ${param(JSON.stringify(changes.query))}::json`)
    if (changes.parameters !== undefined) {
      set.push(`parameters = ${param(JSON.stringify(changes.parameters))}::jsonb`)
    }
    if (changes.visibility !== undefined) set.push(`visibility = ${param(changes.visibility)}`)
    const result = await this.pool.query(
      `UPDATE saved_queries SET ${set.join(", ")}
        WHERE workspace_id = $1 AND id = $2 AND version = $3`,
      values,
    )
    return versionedOutcome((result.rowCount ?? 0) > 0, () => this.get(workspaceId, null, id))
  }

  /** Deletes it; its runs stay in history (no longer pinned) until pruning removes them. */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    const deleted = await this.transaction(async (client) => {
      await client.query(
        "UPDATE query_executions SET pinned = false WHERE workspace_id = $1 AND saved_query_id = $2",
        [workspaceId, id],
      )
      const { rowCount } = await client.query(
        "DELETE FROM saved_queries WHERE workspace_id = $1 AND id = $2",
        [workspaceId, id],
      )
      return (rowCount ?? 0) > 0 ? true : null
    })
    return deleted === true
  }

  /**
   * Records that a run ended. A succeeded run newer than the current latest
   * one becomes the latest result: it is pinned and the previous one, if this
   * saved query ran it, is unpinned so history pruning may remove it.
   */
  async recordRun(workspaceId: string, id: string, run: { executionId: string; succeeded: boolean }) {
    await this.transaction(async (client) => {
      const { rows } = await client.query<{ previous: string | null; newer: boolean }>(
        `SELECT s.last_execution_id AS previous,
                (p.created_at IS NULL OR p.created_at <= n.created_at) AS newer
           FROM saved_queries s
           JOIN query_executions n ON n.workspace_id = s.workspace_id AND n.id = $3
           LEFT JOIN query_executions p ON p.workspace_id = s.workspace_id AND p.id = s.last_execution_id
          WHERE s.workspace_id = $1 AND s.id = $2
            FOR UPDATE OF s`,
        [workspaceId, id, run.executionId],
      )
      const current = rows[0]
      if (!current) return null
      const latest = run.succeeded && current.newer
      await client.query(
        `UPDATE saved_queries
            SET last_run_at = now(), last_execution_id = CASE WHEN $3 THEN $4::uuid ELSE last_execution_id END
          WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, id, latest, run.executionId],
      )
      if (!latest) return true
      await client.query(
        `UPDATE query_executions SET pinned = true
          WHERE workspace_id = $1 AND id = $2 AND status = 'succeeded'`,
        [workspaceId, run.executionId],
      )
      if (current.previous && current.previous !== run.executionId) {
        await client.query(
          `UPDATE query_executions SET pinned = false
            WHERE workspace_id = $1 AND id = $2 AND saved_query_id = $3`,
          [workspaceId, current.previous, id],
        )
      }
      return true
    })
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
