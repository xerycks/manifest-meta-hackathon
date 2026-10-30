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

export type WorkspaceRole = "owner" | "admin" | "member"

export interface WorkspaceMembership extends Workspace {
  role: WorkspaceRole
}

export class WorkspacesRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<Workspace[]> {
    const { rows } = await this.pool.query<WorkspaceRow>(
      "SELECT id, slug, name, created_at, updated_at FROM workspaces ORDER BY created_at, name",
    )
    return rows.map(toWorkspace)
  }

  /** Workspaces a user belongs to, with their role in each. */
  async listForUser(userId: string): Promise<WorkspaceMembership[]> {
    const { rows } = await this.pool.query<WorkspaceRow & { role: WorkspaceRole }>(
      `SELECT w.id, w.slug, w.name, w.created_at, w.updated_at, m.role
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1
        ORDER BY w.created_at, w.name`,
      [userId],
    )
    return rows.map((row) => ({ ...toWorkspace(row), role: row.role }))
  }

  async roleFor(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const { rows } = await this.pool.query<{ role: WorkspaceRole }>(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    )
    return rows[0]?.role ?? null
  }

  async addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    await this.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [workspaceId, userId, role],
    )
  }

  /** Creates a workspace and its initial owner membership in one transaction. */
  async createWithOwner(
    input: { slug: string; name: string },
    ownerUserId: string,
  ): Promise<WorkspaceMembership> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const { rows } = await client.query<WorkspaceRow>(
        `INSERT INTO workspaces (slug, name) VALUES ($1, $2)
         RETURNING id, slug, name, created_at, updated_at`,
        [input.slug, input.name],
      )
      const row = rows[0]
      if (!row) throw new Error("Workspace insert returned no row")
      await client.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
        [row.id, ownerUserId],
      )
      await client.query("COMMIT")
      return { ...toWorkspace(row), role: "owner" }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
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
