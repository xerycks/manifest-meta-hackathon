import { authorNameSql, toAuthor } from "../auth/repository.js"
import type { ManifestObjectKind } from "../connections/adapters/types.js"
import type { ManifestColumn, ManifestObject, ManifestRelationship } from "./schemas.js"

// Row shapes and SELECTs shared by the browse and edit repositories. Each
// SELECT ends at its FROM clause; callers add the workspace-scoped WHERE.

export interface ObjectRow {
  id: string
  connection_id: string
  schema_name: string
  object_name: string
  kind: ManifestObjectKind
  source_comment: string | null
  estimated_rows: string | null
  view_definition: string | null
  present: boolean
  removed_at: Date | null
  first_seen_at: Date
  last_seen_at: Date
  label: string | null
  description: string | null
  row_meaning: string | null
  version: number
  edited_at: Date | null
  edited_by: string | null
  edited_by_name: string | null
}

/** Alias `o`. */
export const OBJECT_SELECT = `
  SELECT o.id, o.connection_id, o.schema_name, o.object_name, o.kind, o.source_comment,
         o.estimated_rows, o.view_definition, o.present, o.removed_at, o.first_seen_at,
         o.last_seen_at, o.label, o.description, o.row_meaning, o.version, o.edited_at,
         o.edited_by, ${authorNameSql("ou")} AS edited_by_name
    FROM manifest_objects o
    LEFT JOIN users ou ON ou.id = o.edited_by`

/** bigint arrives as a string; row estimates fit comfortably in a number. */
export const estimate = (value: string | null) => (value === null ? null : Number(value))

export function toObject(row: ObjectRow): ManifestObject {
  return {
    id: row.id,
    connectionId: row.connection_id,
    schema: row.schema_name,
    name: row.object_name,
    kind: row.kind,
    comment: row.source_comment,
    estimatedRows: estimate(row.estimated_rows),
    viewDefinition: row.view_definition,
    present: row.present,
    removedAt: row.removed_at?.toISOString() ?? null,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    label: row.label,
    description: row.description,
    rowMeaning: row.row_meaning,
    version: row.version,
    editedAt: row.edited_at?.toISOString() ?? null,
    editedBy: toAuthor(row.edited_by, row.edited_by_name),
  }
}

export interface ColumnRow {
  id: string
  object_id: string
  name: string
  ordinal: number
  data_type: string
  is_nullable: boolean
  default_value: string | null
  is_primary_key: boolean
  enum_values: string[] | null
  source_comment: string | null
  present: boolean
  removed_at: Date | null
  label: string | null
  description: string | null
  unit: string | null
  value_notes: string | null
  version: number
  edited_at: Date | null
  edited_by: string | null
  edited_by_name: string | null
}

/** Alias `c`, joined to its object as `o` so callers can scope by workspace and connection. */
export const COLUMN_SELECT = `
  SELECT c.id, c.object_id, c.name, c.ordinal, c.data_type, c.is_nullable, c.default_value,
         c.is_primary_key, c.enum_values, c.source_comment, c.present, c.removed_at, c.label,
         c.description, c.unit, c.value_notes, c.version, c.edited_at, c.edited_by,
         ${authorNameSql("cu")} AS edited_by_name
    FROM manifest_columns c
    JOIN manifest_objects o ON o.id = c.object_id
    LEFT JOIN users cu ON cu.id = c.edited_by`

export function toColumn(row: ColumnRow): ManifestColumn {
  return {
    id: row.id,
    objectId: row.object_id,
    name: row.name,
    ordinal: row.ordinal,
    dataType: row.data_type,
    nullable: row.is_nullable,
    defaultValue: row.default_value,
    isPrimaryKey: row.is_primary_key,
    enumValues: row.enum_values,
    comment: row.source_comment,
    present: row.present,
    removedAt: row.removed_at?.toISOString() ?? null,
    label: row.label,
    description: row.description,
    unit: row.unit,
    valueNotes: row.value_notes,
    version: row.version,
    editedAt: row.edited_at?.toISOString() ?? null,
    editedBy: toAuthor(row.edited_by, row.edited_by_name),
  }
}

export interface RelationshipRow {
  id: string
  origin: "foreign_key" | "manual"
  constraint_name: string | null
  present: boolean
  from_columns: string[]
  to_columns: string[]
  remark: string | null
  version: number
  needs_review: boolean
  from_id: string
  from_schema: string
  from_name: string
  from_present: boolean
  to_id: string
  to_schema: string
  to_name: string
  to_present: boolean
}

/** True when every named column of the object is still in the source. */
const columnsPresent = (objectId: string, columns: string) => `
  (SELECT count(*) FROM manifest_columns mc
    WHERE mc.object_id = ${objectId} AND mc.present AND mc.name = ANY (${columns})
  ) = cardinality(${columns})`

/**
 * Alias `r`, with its ends as `f` and `t`. A manual relationship needs review
 * when either object or any of its columns is no longer in the source; it is
 * computed on read, so publishing never has to touch authored rows.
 */
export const RELATIONSHIP_SELECT = `
  SELECT r.id, r.origin, r.constraint_name, r.present, r.from_columns, r.to_columns, r.remark,
         r.version,
         f.id AS from_id, f.schema_name AS from_schema, f.object_name AS from_name,
         f.present AS from_present,
         t.id AS to_id, t.schema_name AS to_schema, t.object_name AS to_name,
         t.present AS to_present,
         r.origin = 'manual' AND NOT (
           f.present AND t.present
           AND ${columnsPresent("f.id", "r.from_columns")}
           AND ${columnsPresent("t.id", "r.to_columns")}
         ) AS needs_review
    FROM manifest_relationships r
    JOIN manifest_objects f ON f.id = r.from_object_id
    JOIN manifest_objects t ON t.id = r.to_object_id`

export function toRelationship(row: RelationshipRow): ManifestRelationship {
  return {
    id: row.id,
    origin: row.origin,
    constraintName: row.constraint_name,
    present: row.present,
    from: {
      objectId: row.from_id,
      schema: row.from_schema,
      name: row.from_name,
      present: row.from_present,
      columns: row.from_columns,
    },
    to: {
      objectId: row.to_id,
      schema: row.to_schema,
      name: row.to_name,
      present: row.to_present,
      columns: row.to_columns,
    },
    remark: row.remark,
    version: row.version,
    needsReview: row.needs_review,
  }
}
