import type { Pool } from "pg"

import type { ManifestObjectKind } from "../connections/adapters/types.js"
import { likePattern } from "../shared/postgres/like.js"
import {
  describeMatch,
  type ColumnHit,
  type KnowledgeHit,
  type ObjectHit,
  type SearchQuery,
  type SearchResults,
} from "./schemas.js"

// Each group ranks exact name (or label/title) matches first, then partial
// ones, then matches in descriptions. $1 workspace, $2 pattern, $3 lowercased
// text, $4 limit, $5 the sources to search (null: all; knowledge entries not
// about a source always match). Objects in schemas a source no longer reads
// are left out, as in browsing.

const OBJECTS_SQL = `
  SELECT o.id, o.connection_id, c.name AS connection_name, o.schema_name, o.object_name, o.label,
         o.kind, o.present, o.description, o.row_meaning
    FROM manifest_objects o
    JOIN connections c ON c.workspace_id = o.workspace_id AND c.id = o.connection_id
   WHERE o.workspace_id = $1 AND o.schema_name = ANY (c.selected_schemas)
     AND ($5::uuid[] IS NULL OR o.connection_id = ANY ($5::uuid[]))
     AND (o.object_name ILIKE $2 OR o.label ILIKE $2 OR o.description ILIKE $2
          OR o.row_meaning ILIKE $2)
   ORDER BY o.present DESC,
            CASE WHEN lower(o.object_name) = $3 OR lower(o.label) = $3 THEN 0
                 WHEN o.object_name ILIKE $2 OR o.label ILIKE $2 THEN 1
                 ELSE 2 END,
            o.object_name, c.name, o.id
   LIMIT $4`

const COLUMNS_SQL = `
  SELECT col.id, col.name, col.label, col.data_type, col.description, col.value_notes,
         col.present AND o.present AS present, o.id AS object_id, o.schema_name, o.object_name,
         o.connection_id, c.name AS connection_name
    FROM manifest_columns col
    JOIN manifest_objects o ON o.id = col.object_id
    JOIN connections c ON c.workspace_id = o.workspace_id AND c.id = o.connection_id
   WHERE o.workspace_id = $1 AND o.schema_name = ANY (c.selected_schemas)
     AND ($5::uuid[] IS NULL OR o.connection_id = ANY ($5::uuid[]))
     AND (col.name ILIKE $2 OR col.label ILIKE $2 OR col.description ILIKE $2
          OR col.value_notes ILIKE $2)
   ORDER BY col.present AND o.present DESC,
            CASE WHEN lower(col.name) = $3 OR lower(col.label) = $3 THEN 0
                 WHEN col.name ILIKE $2 OR col.label ILIKE $2 THEN 1
                 ELSE 2 END,
            o.schema_name, o.object_name, col.ordinal, col.id
   LIMIT $4`

const KNOWLEDGE_SQL = `
  SELECT e.id, e.title, e.body, c.id AS connection_id, c.name AS connection_name
    FROM knowledge_entries e
    LEFT JOIN connections c ON c.id = e.connection_id AND c.workspace_id = e.workspace_id
   WHERE e.workspace_id = $1 AND (e.title ILIKE $2 OR e.body ILIKE $2)
     AND ($5::uuid[] IS NULL OR e.connection_id IS NULL OR e.connection_id = ANY ($5::uuid[]))
   ORDER BY CASE WHEN lower(e.title) = $3 THEN 0 WHEN e.title ILIKE $2 THEN 1 ELSE 2 END,
            e.updated_at DESC, e.id
   LIMIT $4`

/** Workspace-wide search over manifest names, authored meaning, and knowledge entries. */
export class SearchRepository {
  constructor(private readonly pool: Pool) {}

  /** `connectionIds` limits hits to those sources before the limit applies (null: every source). */
  async search(
    workspaceId: string,
    query: SearchQuery,
    connectionIds: string[] | null = null,
  ): Promise<SearchResults> {
    const params = [workspaceId, likePattern(query.q), query.q.toLowerCase(), query.limit + 1, connectionIds]
    const [objects, columns, knowledge] = await Promise.all([
      this.pool.query<{
        id: string
        connection_id: string
        connection_name: string
        schema_name: string
        object_name: string
        label: string | null
        kind: ManifestObjectKind
        present: boolean
        description: string | null
        row_meaning: string | null
      }>(OBJECTS_SQL, params),
      this.pool.query<{
        id: string
        name: string
        label: string | null
        data_type: string
        description: string | null
        value_notes: string | null
        present: boolean
        object_id: string
        schema_name: string
        object_name: string
        connection_id: string
        connection_name: string
      }>(COLUMNS_SQL, params),
      this.pool.query<{
        id: string
        title: string
        body: string
        connection_id: string | null
        connection_name: string | null
      }>(KNOWLEDGE_SQL, params),
    ])

    const objectHits: ObjectHit[] = objects.rows.slice(0, query.limit).map((row) => ({
      connectionId: row.connection_id,
      connectionName: row.connection_name,
      objectId: row.id,
      schema: row.schema_name,
      name: row.object_name,
      label: row.label,
      kind: row.kind,
      present: row.present,
      ...describeMatch(
        [
          ["name", row.object_name],
          ["label", row.label],
          ["description", row.description],
          ["rowMeaning", row.row_meaning],
        ],
        query.q,
        row.description,
      ),
    }))
    const columnHits: ColumnHit[] = columns.rows.slice(0, query.limit).map((row) => ({
      connectionId: row.connection_id,
      connectionName: row.connection_name,
      objectId: row.object_id,
      objectSchema: row.schema_name,
      objectName: row.object_name,
      columnId: row.id,
      name: row.name,
      label: row.label,
      dataType: row.data_type,
      present: row.present,
      ...describeMatch(
        [
          ["name", row.name],
          ["label", row.label],
          ["description", row.description],
          ["valueNotes", row.value_notes],
        ],
        query.q,
        row.description,
      ),
    }))
    const knowledgeHits: KnowledgeHit[] = knowledge.rows.slice(0, query.limit).map((row) => ({
      entryId: row.id,
      title: row.title,
      connection:
        row.connection_id && row.connection_name !== null
          ? { id: row.connection_id, name: row.connection_name }
          : null,
      ...describeMatch(
        [
          ["title", row.title],
          ["body", row.body],
        ],
        query.q,
        row.body,
      ),
    }))

    return {
      query: query.q,
      objects: objectHits,
      columns: columnHits,
      knowledge: knowledgeHits,
      truncated: [objects, columns, knowledge].some((result) => result.rows.length > query.limit),
    }
  }
}
