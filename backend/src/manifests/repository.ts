import type { Pool, PoolClient } from "pg"

import type { DiscoveredMetadata, ManifestObjectKind } from "../connections/adapters/types.js"
import { likePattern } from "../shared/postgres/like.js"
import {
  COLUMN_SELECT,
  estimate,
  OBJECT_SELECT,
  RELATIONSHIP_SELECT,
  toColumn,
  toObject,
  toRelationship,
  type ColumnRow,
  type ObjectRow,
  type RelationshipRow,
} from "./rows.js"
import type {
  ManifestObjectDetail,
  ManifestObjectSummary,
  ManifestRefresh,
  RefreshCounts,
  RefreshPhase,
  RefreshStatus,
  RefreshTrigger,
} from "./schemas.js"

/** A refresh run as its runner addresses it: always together with its workspace. */
export interface RunRef {
  id: string
  workspaceId: string
  connectionId: string
}

/** Finished runs kept per connection (plus the last published one), so history stays bounded. */
const KEPT_REFRESHES = 20
/** Rows per upsert statement while publishing (view definitions make object rows large). */
const PUBLISH_CHUNK = 500
const MAX_RELATIONSHIPS_PER_OBJECT = 1_000

interface RefreshRow {
  id: string
  connection_id: string
  status: RefreshStatus
  trigger: RefreshTrigger
  phase: RefreshPhase | null
  objects_done: number
  objects_total: number | null
  counts: RefreshCounts | null
  error: string | null
  triggered_by: string | null
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

const REFRESH_COLUMNS = `id, connection_id, status, trigger, phase, objects_done, objects_total,
  counts, error, triggered_by, created_at, started_at, finished_at`

function toRefresh(row: RefreshRow): ManifestRefresh {
  return {
    id: row.id,
    connectionId: row.connection_id,
    status: row.status,
    trigger: row.trigger,
    phase: row.phase,
    objectsDone: row.objects_done,
    objectsTotal: row.objects_total,
    counts: row.counts,
    error: row.error,
    triggeredBy: row.triggered_by,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  }
}

function firstRefresh(rows: RefreshRow[]): ManifestRefresh | null {
  return rows[0] ? toRefresh(rows[0]) : null
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size))
  }
  return result
}

const objectKey = (schema: string, name: string) => `${schema}\u0000${name}`

// Publishing marks rows "seen" by setting last_seen_at = now(), which is fixed
// for the whole transaction; anything this refresh did not touch therefore has
// a different last_seen_at and is marked not present (never deleted).

const UPSERT_OBJECTS_SQL = `
  WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($3::jsonb) AS o(
      schema_name text, object_name text, kind text, source_comment text,
      estimated_rows bigint, view_definition text)
  ),
  previous AS (
    SELECT m.id, m.present
      FROM manifest_objects m
      JOIN incoming i ON i.schema_name = m.schema_name AND i.object_name = m.object_name
     WHERE m.workspace_id = $1 AND m.connection_id = $2
  ),
  upserted AS (
    INSERT INTO manifest_objects AS m
      (workspace_id, connection_id, schema_name, object_name, kind, source_comment,
       estimated_rows, view_definition)
    SELECT $1, $2, schema_name, object_name, kind, source_comment, estimated_rows, view_definition
      FROM incoming
    ON CONFLICT (connection_id, schema_name, object_name) DO UPDATE SET
      kind = EXCLUDED.kind,
      source_comment = EXCLUDED.source_comment,
      estimated_rows = EXCLUDED.estimated_rows,
      view_definition = EXCLUDED.view_definition,
      present = true,
      removed_at = NULL,
      last_seen_at = now()
    RETURNING m.id, m.schema_name, m.object_name
  )
  SELECT u.id, u.schema_name, u.object_name, NOT coalesce(p.present, false) AS added
    FROM upserted u
    LEFT JOIN previous p ON p.id = u.id`

const UPSERT_COLUMNS_SQL = `
  WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS c(
      object_id uuid, name text, ordinal integer, data_type text, is_nullable boolean,
      default_value text, is_primary_key boolean, enum_values text[], source_comment text)
  ),
  previous AS (
    SELECT m.id, m.present
      FROM manifest_columns m
      JOIN incoming i ON i.object_id = m.object_id AND i.name = m.name
  ),
  upserted AS (
    INSERT INTO manifest_columns AS m
      (object_id, name, ordinal, data_type, is_nullable, default_value, is_primary_key,
       enum_values, source_comment)
    SELECT object_id, name, ordinal, data_type, is_nullable, default_value, is_primary_key,
           enum_values, source_comment
      FROM incoming
    ON CONFLICT (object_id, name) DO UPDATE SET
      ordinal = EXCLUDED.ordinal,
      data_type = EXCLUDED.data_type,
      is_nullable = EXCLUDED.is_nullable,
      default_value = EXCLUDED.default_value,
      is_primary_key = EXCLUDED.is_primary_key,
      enum_values = EXCLUDED.enum_values,
      source_comment = EXCLUDED.source_comment,
      present = true,
      removed_at = NULL,
      last_seen_at = now()
    RETURNING m.id
  )
  SELECT count(*) FILTER (WHERE NOT coalesce(p.present, false))::int AS added
    FROM upserted u
    LEFT JOIN previous p ON p.id = u.id`

const UPSERT_RELATIONSHIPS_SQL = `
  INSERT INTO manifest_relationships AS r
    (workspace_id, connection_id, origin, constraint_name, from_object_id, from_columns,
     to_object_id, to_columns)
  SELECT $1, $2, 'foreign_key', constraint_name, from_object_id, from_columns, to_object_id, to_columns
    FROM jsonb_to_recordset($3::jsonb) AS f(
      constraint_name text, from_object_id uuid, from_columns text[],
      to_object_id uuid, to_columns text[])
  ON CONFLICT (from_object_id, constraint_name) WHERE origin = 'foreign_key' DO UPDATE SET
    from_columns = EXCLUDED.from_columns,
    to_object_id = EXCLUDED.to_object_id,
    to_columns = EXCLUDED.to_columns,
    present = true,
    removed_at = NULL,
    last_seen_at = now()`

const MARK_MISSING_OBJECTS_SQL = `
  UPDATE manifest_objects SET present = false, removed_at = now()
   WHERE workspace_id = $1 AND connection_id = $2
     AND present AND last_seen_at IS DISTINCT FROM now()`

const MARK_MISSING_COLUMNS_SQL = `
  UPDATE manifest_columns c SET present = false, removed_at = now()
    FROM manifest_objects o
   WHERE c.object_id = o.id AND o.workspace_id = $1 AND o.connection_id = $2
     AND c.present AND c.last_seen_at IS DISTINCT FROM now()`

// Manual relationships are user-authored and never marked missing by discovery.
const MARK_MISSING_RELATIONSHIPS_SQL = `
  UPDATE manifest_relationships SET present = false, removed_at = now()
   WHERE workspace_id = $1 AND connection_id = $2 AND origin = 'foreign_key'
     AND present AND last_seen_at IS DISTINCT FROM now()`

/**
 * Manifest metadata and refresh runs. Every query is scoped by workspace_id
 * and connection_id; columns are reached through their workspace-scoped object.
 */
export class ManifestsRepository {
  constructor(private readonly pool: Pool) {}

  // Refresh runs ------------------------------------------------------------

  /**
   * Queues a run; rejects with a unique violation (23505) while another one is
   * active. Old runs are pruned first, so a failed prune never strands a queued run.
   */
  async createRefresh(input: {
    workspaceId: string
    connectionId: string
    trigger: RefreshTrigger
    triggeredBy: string | null
  }): Promise<ManifestRefresh> {
    await this.pool.query(
      `DELETE FROM manifest_refreshes
        WHERE workspace_id = $1 AND connection_id = $2
          AND status NOT IN ('queued', 'running')
          AND id NOT IN (
            SELECT id FROM manifest_refreshes
             WHERE workspace_id = $1 AND connection_id = $2
             ORDER BY created_at DESC LIMIT ${KEPT_REFRESHES})
          AND id IS DISTINCT FROM (
            SELECT id FROM manifest_refreshes
             WHERE workspace_id = $1 AND connection_id = $2 AND status = 'succeeded'
             ORDER BY finished_at DESC LIMIT 1)`,
      [input.workspaceId, input.connectionId],
    )
    const { rows } = await this.pool.query<RefreshRow>(
      `INSERT INTO manifest_refreshes (workspace_id, connection_id, trigger, triggered_by)
       VALUES ($1, $2, $3, $4)
       RETURNING ${REFRESH_COLUMNS}`,
      [input.workspaceId, input.connectionId, input.trigger, input.triggeredBy],
    )
    const refresh = firstRefresh(rows)
    if (!refresh) throw new Error("Refresh insert returned no row")
    return refresh
  }

  async getRefresh(
    workspaceId: string,
    connectionId: string,
    id: string,
  ): Promise<ManifestRefresh | null> {
    const { rows } = await this.pool.query<RefreshRow>(
      `SELECT ${REFRESH_COLUMNS} FROM manifest_refreshes
        WHERE workspace_id = $1 AND connection_id = $2 AND id = $3`,
      [workspaceId, connectionId, id],
    )
    return firstRefresh(rows)
  }

  async latestRefresh(workspaceId: string, connectionId: string): Promise<ManifestRefresh | null> {
    const { rows } = await this.pool.query<RefreshRow>(
      `SELECT ${REFRESH_COLUMNS} FROM manifest_refreshes
        WHERE workspace_id = $1 AND connection_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, connectionId],
    )
    return firstRefresh(rows)
  }

  async activeRefresh(workspaceId: string, connectionId: string): Promise<ManifestRefresh | null> {
    const { rows } = await this.pool.query<RefreshRow>(
      `SELECT ${REFRESH_COLUMNS} FROM manifest_refreshes
        WHERE workspace_id = $1 AND connection_id = $2 AND status IN ('queued', 'running')`,
      [workspaceId, connectionId],
    )
    return firstRefresh(rows)
  }

  /** The refresh whose results are currently published. */
  async lastPublished(workspaceId: string, connectionId: string): Promise<ManifestRefresh | null> {
    const { rows } = await this.pool.query<RefreshRow>(
      `SELECT ${REFRESH_COLUMNS} FROM manifest_refreshes
        WHERE workspace_id = $1 AND connection_id = $2 AND status = 'succeeded'
        ORDER BY finished_at DESC LIMIT 1`,
      [workspaceId, connectionId],
    )
    return firstRefresh(rows)
  }

  /** Moves a queued run to running; false when it was cancelled while it waited. */
  async markRunning(run: RunRef): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE manifest_refreshes SET status = 'running', phase = 'connecting', started_at = now()
        WHERE workspace_id = $1 AND id = $2 AND status = 'queued'`,
      [run.workspaceId, run.id],
    )
    return (result.rowCount ?? 0) > 0
  }

  async recordProgress(
    run: RunRef,
    progress: { phase: RefreshPhase; objectsDone: number; objectsTotal: number | null },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE manifest_refreshes SET phase = $3, objects_done = $4, objects_total = $5
        WHERE workspace_id = $1 AND id = $2 AND status = 'running'`,
      [run.workspaceId, run.id, progress.phase, progress.objectsDone, progress.objectsTotal],
    )
  }

  /** Ends an active run without publishing. A run that already ended is left as it is. */
  async finish(
    run: RunRef,
    outcome: { status: "failed" | "cancelled"; error: string | null },
  ): Promise<ManifestRefresh | null> {
    const { rows } = await this.pool.query<RefreshRow>(
      `UPDATE manifest_refreshes SET status = $3, error = $4, finished_at = now()
        WHERE workspace_id = $1 AND connection_id = $2 AND id = $5
          AND status IN ('queued', 'running')
        RETURNING ${REFRESH_COLUMNS}`,
      [run.workspaceId, run.connectionId, outcome.status, outcome.error, run.id],
    )
    return firstRefresh(rows)
  }

  /**
   * Startup maintenance across all workspaces: no run survives a restart, so
   * anything still active was interrupted.
   */
  async failInterruptedRefreshes(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE manifest_refreshes
          SET status = 'failed', finished_at = now(),
              error = 'Interrupted by a restart of the backend. Start the refresh again.'
        WHERE status IN ('queued', 'running')`,
    )
    return result.rowCount ?? 0
  }

  /**
   * Publishes discovered metadata in one transaction and marks the run
   * succeeded. Returns null, publishing nothing, if the run is no longer
   * running (it was cancelled, or its source was removed).
   */
  async publish(run: RunRef, metadata: DiscoveredMetadata): Promise<RefreshCounts | null> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      // The row lock orders publishing against a concurrent cancel.
      const locked = await client.query(
        `SELECT 1 FROM manifest_refreshes
          WHERE workspace_id = $1 AND connection_id = $2 AND id = $3 AND status = 'running'
          FOR UPDATE`,
        [run.workspaceId, run.connectionId, run.id],
      )
      if (locked.rowCount === 0) {
        await client.query("ROLLBACK")
        return null
      }
      const counts = await this.writeMetadata(client, run, metadata)
      await client.query(
        `UPDATE manifest_refreshes
            SET status = 'succeeded', counts = $3::jsonb, error = NULL, finished_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [run.workspaceId, run.id, JSON.stringify(counts)],
      )
      await client.query("COMMIT")
      return counts
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  private async writeMetadata(
    client: PoolClient,
    run: RunRef,
    metadata: DiscoveredMetadata,
  ): Promise<RefreshCounts> {
    const scope = [run.workspaceId, run.connectionId]
    const objectIds = new Map<string, string>()
    let objectsAdded = 0
    for (const chunk of chunks(metadata.objects, PUBLISH_CHUNK)) {
      const payload = chunk.map((object) => ({
        schema_name: object.schema,
        object_name: object.name,
        kind: object.kind,
        source_comment: object.comment,
        estimated_rows: object.estimatedRows,
        view_definition: object.viewDefinition,
      }))
      const { rows } = await client.query<{
        id: string
        schema_name: string
        object_name: string
        added: boolean
      }>(UPSERT_OBJECTS_SQL, [...scope, JSON.stringify(payload)])
      for (const row of rows) {
        objectIds.set(objectKey(row.schema_name, row.object_name), row.id)
        if (row.added) objectsAdded += 1
      }
    }
    const objectsRemoved = (await client.query(MARK_MISSING_OBJECTS_SQL, scope)).rowCount ?? 0

    const columns = metadata.objects.flatMap((object) => {
      const objectId = objectIds.get(objectKey(object.schema, object.name))
      return object.columns.map((column) => ({
        object_id: objectId,
        name: column.name,
        ordinal: column.ordinal,
        data_type: column.dataType,
        is_nullable: column.nullable,
        default_value: column.defaultValue,
        is_primary_key: column.isPrimaryKey,
        enum_values: column.enumValues,
        source_comment: column.comment,
      }))
    })
    let columnsAdded = 0
    for (const chunk of chunks(columns, PUBLISH_CHUNK)) {
      const { rows } = await client.query<{ added: number }>(UPSERT_COLUMNS_SQL, [
        JSON.stringify(chunk),
      ])
      columnsAdded += rows[0]?.added ?? 0
    }
    const columnsRemoved = (await client.query(MARK_MISSING_COLUMNS_SQL, scope)).rowCount ?? 0

    const relationships = metadata.relationships.flatMap((relationship) => {
      const from = objectIds.get(objectKey(relationship.from.schema, relationship.from.name))
      const to = objectIds.get(objectKey(relationship.to.schema, relationship.to.name))
      if (!from || !to) return []
      return [
        {
          constraint_name: relationship.constraintName,
          from_object_id: from,
          from_columns: relationship.from.columns,
          to_object_id: to,
          to_columns: relationship.to.columns,
        },
      ]
    })
    for (const chunk of chunks(relationships, PUBLISH_CHUNK)) {
      await client.query(UPSERT_RELATIONSHIPS_SQL, [...scope, JSON.stringify(chunk)])
    }
    await client.query(MARK_MISSING_RELATIONSHIPS_SQL, scope)

    return {
      objects: metadata.objects.length,
      columns: columns.length,
      relationships: relationships.length,
      objectsAdded,
      objectsRemoved,
      columnsAdded,
      columnsRemoved,
    }
  }

  // Published metadata ------------------------------------------------------

  /** Objects in the given schemas, present ones first; `limit` bounds the listing. */
  async listObjects(
    workspaceId: string,
    connectionId: string,
    filter: { schemas: string[]; search: string | undefined; limit: number },
  ): Promise<ManifestObjectSummary[]> {
    const { rows } = await this.pool.query<{
      id: string
      schema_name: string
      object_name: string
      label: string | null
      kind: ManifestObjectKind
      column_count: number
      estimated_rows: string | null
      present: boolean
      last_seen_at: Date
    }>(
      `SELECT o.id, o.schema_name, o.object_name, o.label, o.kind, o.estimated_rows, o.present,
              o.last_seen_at,
              (SELECT count(*)::int FROM manifest_columns c
                WHERE c.object_id = o.id AND c.present) AS column_count
         FROM manifest_objects o
        WHERE o.workspace_id = $1 AND o.connection_id = $2
          AND o.schema_name = ANY ($3::text[])
          AND ($4::text IS NULL OR o.object_name ILIKE $4 OR o.label ILIKE $4)
        ORDER BY o.schema_name, o.present DESC, o.object_name
        LIMIT $5`,
      [
        workspaceId,
        connectionId,
        filter.schemas,
        filter.search ? likePattern(filter.search) : null,
        filter.limit,
      ],
    )
    return rows.map((row) => ({
      id: row.id,
      schema: row.schema_name,
      name: row.object_name,
      label: row.label,
      kind: row.kind,
      columnCount: row.column_count,
      estimatedRows: estimate(row.estimated_rows),
      present: row.present,
      lastSeenAt: row.last_seen_at.toISOString(),
    }))
  }

  async getObject(
    workspaceId: string,
    connectionId: string,
    objectId: string,
  ): Promise<ManifestObjectDetail | null> {
    const objects = await this.pool.query<ObjectRow>(
      `${OBJECT_SELECT}
        WHERE o.workspace_id = $1 AND o.connection_id = $2 AND o.id = $3`,
      [workspaceId, connectionId, objectId],
    )
    const objectRow = objects.rows[0]
    if (!objectRow) return null

    const [columns, relationships] = await Promise.all([
      this.pool.query<ColumnRow>(
        `${COLUMN_SELECT}
          WHERE o.workspace_id = $1 AND o.connection_id = $2 AND c.object_id = $3
          ORDER BY c.present DESC, c.ordinal, c.name`,
        [workspaceId, connectionId, objectId],
      ),
      this.pool.query<RelationshipRow>(
        `${RELATIONSHIP_SELECT}
          WHERE r.workspace_id = $1 AND r.connection_id = $2
            AND (r.from_object_id = $3 OR r.to_object_id = $3)
          ORDER BY r.present DESC, f.schema_name, f.object_name, r.constraint_name, r.id
          LIMIT ${MAX_RELATIONSHIPS_PER_OBJECT}`,
        [workspaceId, connectionId, objectId],
      ),
    ])
    const all = relationships.rows.map(toRelationship)
    return {
      object: toObject(objectRow),
      columns: columns.rows.map(toColumn),
      outgoing: all.filter((relationship) => relationship.from.objectId === objectId),
      incoming: all.filter((relationship) => relationship.to.objectId === objectId),
    }
  }
}
