import type { Pool } from "pg"

import { versionedOutcome, type VersionedSave } from "../shared/postgres/versioned.js"
import {
  COLUMN_SELECT,
  OBJECT_SELECT,
  RELATIONSHIP_SELECT,
  toColumn,
  toObject,
  toRelationship,
  type ColumnRow,
  type ObjectRow,
  type RelationshipRow,
} from "./rows.js"
import type { ManifestColumn, ManifestObject, ManifestRelationship } from "./schemas.js"

/** Every edit is addressed through its workspace and source. */
export interface ManifestScope {
  workspaceId: string
  connectionId: string
}

/** A column as one end of a relationship. */
export interface ColumnEnd {
  columnId: string
  name: string
  dataType: string
  enumValues: string[] | null
  /** Both the column and its object are still in the source. */
  present: boolean
  objectId: string
  schema: string
  objectName: string
}

type Changes<K extends string> = { [P in K]?: string | null | undefined }

const OBJECT_FIELDS = {
  label: "label",
  description: "description",
  rowMeaning: "row_meaning",
} as const
const COLUMN_FIELDS = {
  label: "label",
  description: "description",
  unit: "unit",
  valueNotes: "value_notes",
} as const

/** `column = $n` for each provided field; column names only ever come from the maps above. */
function assignments<K extends string>(
  changes: Changes<K>,
  fields: Record<K, string>,
  firstParam: number,
): { sql: string[]; values: (string | null)[] } {
  const sql: string[] = []
  const values: (string | null)[] = []
  for (const key of Object.keys(fields) as K[]) {
    const value = changes[key]
    if (value === undefined) continue
    values.push(value)
    sql.push(`${fields[key]} = $${firstParam + values.length - 1}`)
  }
  return { sql, values }
}

/**
 * Authored meaning on manifest objects, columns, and relationships. Only
 * authored columns are written here, and discovery never writes them. Every
 * query is scoped by workspace and connection (columns through their object).
 */
export class ManifestEditsRepository {
  constructor(private readonly pool: Pool) {}

  async object(scope: ManifestScope, id: string): Promise<ManifestObject | null> {
    const { rows } = await this.pool.query<ObjectRow>(
      `${OBJECT_SELECT}
        WHERE o.workspace_id = $1 AND o.connection_id = $2 AND o.id = $3`,
      [scope.workspaceId, scope.connectionId, id],
    )
    return rows[0] ? toObject(rows[0]) : null
  }

  async column(scope: ManifestScope, id: string): Promise<ManifestColumn | null> {
    const { rows } = await this.pool.query<ColumnRow>(
      `${COLUMN_SELECT}
        WHERE o.workspace_id = $1 AND o.connection_id = $2 AND c.id = $3`,
      [scope.workspaceId, scope.connectionId, id],
    )
    return rows[0] ? toColumn(rows[0]) : null
  }

  async relationship(scope: ManifestScope, id: string): Promise<ManifestRelationship | null> {
    const { rows } = await this.pool.query<RelationshipRow>(
      `${RELATIONSHIP_SELECT}
        WHERE r.workspace_id = $1 AND r.connection_id = $2 AND r.id = $3`,
      [scope.workspaceId, scope.connectionId, id],
    )
    return rows[0] ? toRelationship(rows[0]) : null
  }

  async updateObject(
    scope: ManifestScope,
    id: string,
    version: number,
    changes: Changes<keyof typeof OBJECT_FIELDS>,
    userId: string,
  ): Promise<VersionedSave<ManifestObject>> {
    const set = assignments(changes, OBJECT_FIELDS, 6)
    set.sql.push("version = version + 1", "edited_by = $5", "edited_at = now()")
    const result = await this.pool.query(
      `UPDATE manifest_objects SET ${set.sql.join(", ")}
        WHERE workspace_id = $1 AND connection_id = $2 AND id = $3 AND version = $4`,
      [scope.workspaceId, scope.connectionId, id, version, userId, ...set.values],
    )
    return versionedOutcome((result.rowCount ?? 0) > 0, () => this.object(scope, id))
  }

  async updateColumn(
    scope: ManifestScope,
    id: string,
    version: number,
    changes: Changes<keyof typeof COLUMN_FIELDS>,
    userId: string,
  ): Promise<VersionedSave<ManifestColumn>> {
    const set = assignments(changes, COLUMN_FIELDS, 6)
    // Qualified: manifest_objects has a version column too.
    set.sql.push("version = c.version + 1", "edited_by = $5", "edited_at = now()")
    const result = await this.pool.query(
      `UPDATE manifest_columns c SET ${set.sql.join(", ")}
         FROM manifest_objects o
        WHERE c.object_id = o.id AND o.workspace_id = $1 AND o.connection_id = $2
          AND c.id = $3 AND c.version = $4`,
      [scope.workspaceId, scope.connectionId, id, version, userId, ...set.values],
    )
    return versionedOutcome((result.rowCount ?? 0) > 0, () => this.column(scope, id))
  }

  /** The given columns of this source that exist (in any order). */
  async columnEnds(scope: ManifestScope, columnIds: string[]): Promise<ColumnEnd[]> {
    const { rows } = await this.pool.query<{
      column_id: string
      name: string
      data_type: string
      enum_values: string[] | null
      present: boolean
      object_id: string
      schema_name: string
      object_name: string
    }>(
      `SELECT c.id AS column_id, c.name, c.data_type, c.enum_values, c.present AND o.present AS present,
              o.id AS object_id, o.schema_name, o.object_name
         FROM manifest_columns c
         JOIN manifest_objects o ON o.id = c.object_id
        WHERE o.workspace_id = $1 AND o.connection_id = $2 AND c.id = ANY ($3::uuid[])`,
      [scope.workspaceId, scope.connectionId, columnIds],
    )
    return rows.map((row) => ({
      columnId: row.column_id,
      name: row.name,
      dataType: row.data_type,
      enumValues: row.enum_values,
      present: row.present,
      objectId: row.object_id,
      schema: row.schema_name,
      objectName: row.object_name,
    }))
  }

  async countManualRelationships(scope: ManifestScope): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM manifest_relationships
        WHERE workspace_id = $1 AND connection_id = $2 AND origin = 'manual'`,
      [scope.workspaceId, scope.connectionId],
    )
    return rows[0]?.count ?? 0
  }

  /** Whether a discovered foreign key already links exactly these two columns. */
  async foreignKeyLinks(scope: ManifestScope, from: ColumnEnd, to: ColumnEnd): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM manifest_relationships
        WHERE workspace_id = $1 AND connection_id = $2 AND origin = 'foreign_key' AND present
          AND from_object_id = $3 AND from_columns = ARRAY[$4]::text[]
          AND to_object_id = $5 AND to_columns = ARRAY[$6]::text[]`,
      [scope.workspaceId, scope.connectionId, from.objectId, from.name, to.objectId, to.name],
    )
    return (rowCount ?? 0) > 0
  }

  /** Rejects with a unique violation (23505) when the same manual relationship exists. */
  async insertManualRelationship(
    scope: ManifestScope,
    input: { from: ColumnEnd; to: ColumnEnd; remark: string | null; userId: string },
  ): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO manifest_relationships
         (workspace_id, connection_id, origin, from_object_id, from_columns, to_object_id,
          to_columns, remark, created_by, edited_by, edited_at)
       VALUES ($1, $2, 'manual', $3, ARRAY[$4]::text[], $5, ARRAY[$6]::text[], $7, $8, $8, now())
       RETURNING id`,
      [
        scope.workspaceId,
        scope.connectionId,
        input.from.objectId,
        input.from.name,
        input.to.objectId,
        input.to.name,
        input.remark,
        input.userId,
      ],
    )
    const id = rows[0]?.id
    if (!id) throw new Error("Relationship insert returned no row")
    return id
  }

  /** New ends apply to manual relationships only; may reject with 23505 like the insert. */
  async updateRelationship(
    scope: ManifestScope,
    id: string,
    version: number,
    changes: { ends?: { from: ColumnEnd; to: ColumnEnd }; remark?: string | null | undefined },
    userId: string,
  ): Promise<VersionedSave<ManifestRelationship>> {
    const values: unknown[] = [scope.workspaceId, scope.connectionId, id, version, userId]
    const param = (value: unknown) => `$${values.push(value)}`
    const set = ["version = version + 1", "edited_by = $5", "edited_at = now()"]
    if (changes.ends) {
      const { from, to } = changes.ends
      set.push(
        `from_object_id = ${param(from.objectId)}`,
        `from_columns = ARRAY[${param(from.name)}]::text[]`,
        `to_object_id = ${param(to.objectId)}`,
        `to_columns = ARRAY[${param(to.name)}]::text[]`,
      )
    }
    if (changes.remark !== undefined) set.push(`remark = ${param(changes.remark)}`)
    const result = await this.pool.query(
      `UPDATE manifest_relationships SET ${set.join(", ")}
        WHERE workspace_id = $1 AND connection_id = $2 AND id = $3 AND version = $4
          ${changes.ends ? "AND origin = 'manual'" : ""}`,
      values,
    )
    return versionedOutcome((result.rowCount ?? 0) > 0, () => this.relationship(scope, id))
  }

  async deleteManualRelationship(scope: ManifestScope, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM manifest_relationships
        WHERE workspace_id = $1 AND connection_id = $2 AND id = $3 AND origin = 'manual'`,
      [scope.workspaceId, scope.connectionId, id],
    )
    return (rowCount ?? 0) > 0
  }
}
