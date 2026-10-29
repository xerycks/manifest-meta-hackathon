import type { Pool } from "pg"

export interface Workspace {
  id: string
  slug: string
  name: string
  createdAt: string
  updatedAt: string
}

interface WorkspaceRow {
  id: string
  slug: string
  name: string
  created_at: Date
  updated_at: Date
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export class WorkspacesRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<Workspace[]> {
    const { rows } = await this.pool.query<WorkspaceRow>(
      "SELECT id, slug, name, created_at, updated_at FROM workspaces ORDER BY created_at, name",
    )
    return rows.map(toWorkspace)
  }

  async getById(id: string): Promise<Workspace | null> {
    const { rows } = await this.pool.query<WorkspaceRow>(
      "SELECT id, slug, name, created_at, updated_at FROM workspaces WHERE id = $1",
      [id],
    )
    return rows[0] ? toWorkspace(rows[0]) : null
  }

  async create(input: { slug: string; name: string }): Promise<Workspace> {
    const { rows } = await this.pool.query<WorkspaceRow>(
      `INSERT INTO workspaces (slug, name) VALUES ($1, $2)
       RETURNING id, slug, name, created_at, updated_at`,
      [input.slug, input.name],
    )
    const row = rows[0]
    if (!row) throw new Error("Workspace insert returned no row")
    return toWorkspace(row)
  }
}

export interface WorkspaceSetting {
  key: string
  value: unknown
  updatedAt: string
}

/**
 * Workspace-scoped settings. Every method requires a workspace id, and every
 * query filters on it — there is deliberately no unscoped read or write.
 */
export class WorkspaceSettingsRepository {
  constructor(private readonly pool: Pool) {}

  async get(workspaceId: string, key: string): Promise<WorkspaceSetting | null> {
    const { rows } = await this.pool.query<{ key: string; value: unknown; updated_at: Date }>(
      "SELECT key, value, updated_at FROM workspace_settings WHERE workspace_id = $1 AND key = $2",
      [workspaceId, key],
    )
    const row = rows[0]
    return row ? { key: row.key, value: row.value, updatedAt: row.updated_at.toISOString() } : null
  }

  async list(workspaceId: string): Promise<WorkspaceSetting[]> {
    const { rows } = await this.pool.query<{ key: string; value: unknown; updated_at: Date }>(
      "SELECT key, value, updated_at FROM workspace_settings WHERE workspace_id = $1 ORDER BY key",
      [workspaceId],
    )
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at.toISOString(),
    }))
  }

  async set(workspaceId: string, key: string, value: unknown): Promise<WorkspaceSetting> {
    const { rows } = await this.pool.query<{ key: string; value: unknown; updated_at: Date }>(
      `INSERT INTO workspace_settings (workspace_id, key, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (workspace_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING key, value, updated_at`,
      [workspaceId, key, JSON.stringify(value)],
    )
    const row = rows[0]
    if (!row) throw new Error("Workspace setting upsert returned no row")
    return { key: row.key, value: row.value, updatedAt: row.updated_at.toISOString() }
  }
}
