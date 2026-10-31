import type { Pool } from "pg"

import { authorNameSql, toAuthor } from "../auth/repository.js"
import { likePattern } from "../shared/postgres/like.js"
import { versionedOutcome, type VersionedSave } from "../shared/postgres/versioned.js"
import { plainText, snippet } from "../shared/text.js"
import type { KnowledgeEntry, KnowledgeList, ListQuery } from "./schemas.js"

interface EntryRow {
  id: string
  workspace_id: string
  title: string
  body: string
  version: number
  created_at: Date
  updated_at: Date
  connection_id: string | null
  connection_name: string | null
  created_by: string | null
  created_by_name: string | null
  updated_by: string | null
  updated_by_name: string | null
}

/** Characters of the body read for a list excerpt. */
const EXCERPT_SOURCE = 1_000
const EXCERPT_LENGTH = 240

// The source link only resolves within the entry's own workspace.
const entrySelect = (body: string) => `
  SELECT e.id, e.workspace_id, e.title, ${body} AS body, e.version, e.created_at, e.updated_at,
         c.id AS connection_id, c.name AS connection_name,
         e.created_by, ${authorNameSql("cu")} AS created_by_name,
         e.updated_by, ${authorNameSql("uu")} AS updated_by_name
    FROM knowledge_entries e
    LEFT JOIN connections c ON c.id = e.connection_id AND c.workspace_id = e.workspace_id
    LEFT JOIN users cu ON cu.id = e.created_by
    LEFT JOIN users uu ON uu.id = e.updated_by`

function toEntry(row: EntryRow): KnowledgeEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    body: row.body,
    connection:
      row.connection_id && row.connection_name !== null
        ? { id: row.connection_id, name: row.connection_name }
        : null,
    version: row.version,
    createdBy: toAuthor(row.created_by, row.created_by_name),
    updatedBy: toAuthor(row.updated_by, row.updated_by_name),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

/** Workspace knowledge entries; every query filters on workspace_id. */
export class KnowledgeRepository {
  constructor(private readonly pool: Pool) {}

  /** Newest first; with a search, title matches come before body matches. */
  async list(workspaceId: string, query: ListQuery): Promise<KnowledgeList> {
    const { rows } = await this.pool.query<EntryRow>(
      `${entrySelect(`left(e.body, ${EXCERPT_SOURCE})`)}
        WHERE e.workspace_id = $1
          AND ($2::text IS NULL OR e.title ILIKE $2 OR e.body ILIKE $2)
          AND ($3::uuid IS NULL OR e.connection_id = $3)
        ORDER BY ($2::text IS NOT NULL AND e.title ILIKE $2) DESC, e.updated_at DESC, e.id
        LIMIT $4 OFFSET $5`,
      [
        workspaceId,
        query.search ? likePattern(query.search) : null,
        query.connectionId ?? null,
        query.limit + 1,
        query.offset,
      ],
    )
    const page = rows.slice(0, query.limit)
    return {
      entries: page.map((row) => {
        const { body, ...entry } = toEntry(row)
        return { ...entry, excerpt: snippet(plainText(body), null, EXCERPT_LENGTH) }
      }),
      nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
    }
  }

  async count(workspaceId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM knowledge_entries WHERE workspace_id = $1",
      [workspaceId],
    )
    return rows[0]?.count ?? 0
  }

  async get(workspaceId: string, id: string): Promise<KnowledgeEntry | null> {
    const { rows } = await this.pool.query<EntryRow>(
      `${entrySelect("e.body")} WHERE e.workspace_id = $1 AND e.id = $2`,
      [workspaceId, id],
    )
    return rows[0] ? toEntry(rows[0]) : null
  }

  /** Rejects with a unique violation (23505) when the title is taken in the workspace. */
  async insert(input: {
    workspaceId: string
    title: string
    body: string
    connectionId: string | null
    userId: string
  }): Promise<KnowledgeEntry> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO knowledge_entries (workspace_id, title, body, connection_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING id`,
      [input.workspaceId, input.title, input.body, input.connectionId, input.userId],
    )
    const id = rows[0]?.id
    const entry = id ? await this.get(input.workspaceId, id) : null
    if (!entry) throw new Error("A created knowledge entry could not be read back")
    return entry
  }

  /** May reject with a unique violation like insert. */
  async update(
    workspaceId: string,
    id: string,
    version: number,
    changes: {
      title?: string | undefined
      body?: string | undefined
      connectionId?: string | null | undefined
    },
    userId: string,
  ): Promise<VersionedSave<KnowledgeEntry>> {
    const values: unknown[] = [workspaceId, id, version, userId]
    const param = (value: unknown) => `$${values.push(value)}`
    const set = ["version = version + 1", "updated_by = $4", "updated_at = now()"]
    if (changes.title !== undefined) set.push(`title = ${param(changes.title)}`)
    if (changes.body !== undefined) set.push(`body = ${param(changes.body)}`)
    if (changes.connectionId !== undefined) set.push(`connection_id = ${param(changes.connectionId)}`)
    const result = await this.pool.query(
      `UPDATE knowledge_entries SET ${set.join(", ")}
        WHERE workspace_id = $1 AND id = $2 AND version = $3`,
      values,
    )
    return versionedOutcome((result.rowCount ?? 0) > 0, () => this.get(workspaceId, id))
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "DELETE FROM knowledge_entries WHERE workspace_id = $1 AND id = $2",
      [workspaceId, id],
    )
    return (rowCount ?? 0) > 0
  }
}
