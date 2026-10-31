import type { Pool } from "pg"

import { capabilitiesFor, type SourceCapabilities } from "./capabilities.js"
import type { ConnectionStatus, Engine, MongoConfig, PostgresConfig, SourceSettings } from "./schemas.js"

/**
 * The public shape of a saved connection. It never includes the sealed
 * secret: `hasPassword` says one is saved (for MongoDB connection-string
 * sources, the connection string), and a connection string's config holds
 * only its hosts and database.
 */
export type Connection = SourceSettings & {
  id: string
  workspaceId: string
  name: string
  hasPassword: boolean
  /** PostgreSQL schemas or MongoDB databases. */
  schemas: string[]
  status: ConnectionStatus
  lastTestedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  capabilities: SourceCapabilities
}

interface ConnectionRow {
  id: string
  workspace_id: string
  name: string
  engine: Engine
  config: PostgresConfig | MongoConfig
  has_password: boolean
  selected_schemas: string[]
  status: ConnectionStatus
  last_tested_at: Date | null
  last_error: string | null
  created_at: Date
  updated_at: Date
}

const COLUMNS = `id, workspace_id, name, engine, config, sealed_secret IS NOT NULL AS has_password,
  selected_schemas, status, last_tested_at, last_error, created_at, updated_at`

function toConnection(row: ConnectionRow): Connection {
  // The engine CHECK and the service keep each row's config in its engine's shape.
  const settings = { engine: row.engine, config: row.config } as SourceSettings
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    ...settings,
    hasPassword: row.has_password,
    schemas: row.selected_schemas,
    status: row.status,
    lastTestedAt: row.last_tested_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    capabilities: capabilitiesFor(row.engine),
  }
}

function firstRow(rows: ConnectionRow[]): Connection | null {
  return rows[0] ? toConnection(rows[0]) : null
}

/**
 * Workspace-scoped connections. Every query filters on workspace_id, and the
 * sealed secret is only read by the one method that needs it.
 */
export class ConnectionsRepository {
  constructor(private readonly pool: Pool) {}

  async list(workspaceId: string): Promise<Connection[]> {
    const { rows } = await this.pool.query<ConnectionRow>(
      `SELECT ${COLUMNS} FROM connections WHERE workspace_id = $1 ORDER BY lower(name), id`,
      [workspaceId],
    )
    return rows.map(toConnection)
  }

  async count(workspaceId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM connections WHERE workspace_id = $1",
      [workspaceId],
    )
    return rows[0]?.count ?? 0
  }

  async get(workspaceId: string, id: string): Promise<Connection | null> {
    const { rows } = await this.pool.query<ConnectionRow>(
      `SELECT ${COLUMNS} FROM connections WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id],
    )
    return firstRow(rows)
  }

  async getWithSecret(
    workspaceId: string,
    id: string,
  ): Promise<{ connection: Connection; sealedSecret: string | null } | null> {
    const { rows } = await this.pool.query<ConnectionRow & { sealed_secret: string | null }>(
      `SELECT ${COLUMNS}, sealed_secret FROM connections WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id],
    )
    const row = rows[0]
    return row ? { connection: toConnection(row), sealedSecret: row.sealed_secret } : null
  }

  /** Inserts a connection that has just passed a connection test. */
  async insert(
    input: SourceSettings & {
      id: string
      workspaceId: string
      name: string
      sealedSecret: string | null
      schemas: string[]
      createdBy: string
    },
  ): Promise<Connection> {
    const { rows } = await this.pool.query<ConnectionRow>(
      `INSERT INTO connections
         (id, workspace_id, name, engine, config, sealed_secret, selected_schemas,
          status, last_tested_at, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'connected', now(), $8)
       RETURNING ${COLUMNS}`,
      [
        input.id,
        input.workspaceId,
        input.name,
        input.engine,
        JSON.stringify(input.config),
        input.sealedSecret,
        input.schemas,
        input.createdBy,
      ],
    )
    const connection = firstRow(rows)
    if (!connection) throw new Error("Connection insert returned no row")
    return connection
  }

  /**
   * Applies the given changes; `tested` records the successful test that
   * preceded them. A `sealedSecret` of null removes the saved one.
   */
  async update(
    workspaceId: string,
    id: string,
    changes: {
      name?: string
      config?: PostgresConfig | MongoConfig
      sealedSecret?: string | null
      schemas?: string[]
      tested: boolean
    },
  ): Promise<Connection | null> {
    const { rows } = await this.pool.query<ConnectionRow>(
      `UPDATE connections SET
         name = COALESCE($3, name),
         config = COALESCE($4::jsonb, config),
         sealed_secret = CASE WHEN $8 THEN $5 ELSE sealed_secret END,
         selected_schemas = COALESCE($6::text[], selected_schemas),
         status = CASE WHEN $7 THEN 'connected' ELSE status END,
         last_error = CASE WHEN $7 THEN NULL ELSE last_error END,
         last_tested_at = CASE WHEN $7 THEN now() ELSE last_tested_at END,
         updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      [
        workspaceId,
        id,
        changes.name ?? null,
        changes.config ? JSON.stringify(changes.config) : null,
        changes.sealedSecret ?? null,
        changes.schemas ?? null,
        changes.tested,
        changes.sealedSecret !== undefined,
      ],
    )
    return firstRow(rows)
  }

  /** Records a retest outcome. Settings are unchanged, so updated_at stays put. */
  async recordTest(
    workspaceId: string,
    id: string,
    outcome: { status: "connected"; error: null } | { status: "failed"; error: string },
  ): Promise<Connection | null> {
    const { rows } = await this.pool.query<ConnectionRow>(
      `UPDATE connections SET status = $3, last_error = $4, last_tested_at = now()
        WHERE workspace_id = $1 AND id = $2
        RETURNING ${COLUMNS}`,
      [workspaceId, id, outcome.status, outcome.error],
    )
    return firstRow(rows)
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM connections WHERE workspace_id = $1 AND id = $2",
      [workspaceId, id],
    )
    return (result.rowCount ?? 0) > 0
  }
}
