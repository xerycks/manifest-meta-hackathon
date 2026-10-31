import type {
  ManifestObjectKind,
  ManifestRelationship,
} from "../../entities/manifests/types.ts"
import { ApiError } from "../../shared/api/client.ts"

export const KIND_LABELS: Record<ManifestObjectKind, string> = {
  table: "Table",
  view: "View",
  materialized_view: "Materialized view",
  partitioned_table: "Partitioned table",
  foreign_table: "Foreign table",
}

/** The planner's estimate, so it is labelled as approximate. */
export function formatRowEstimate(rows: number | null): string | null {
  if (rows === null) return null
  return `≈ ${rows.toLocaleString("en-US")} ${rows === 1 ? "row" : "rows"}`
}

export interface ColumnReference {
  objectId: string
  schema: string
  name: string
  /** The referenced column for this one. */
  column: string
  present: boolean
}

/** For each column of an object, the columns its foreign keys point at. */
export function columnReferences(outgoing: ManifestRelationship[]): Map<string, ColumnReference[]> {
  const references = new Map<string, ColumnReference[]>()
  for (const relationship of outgoing) {
    if (!relationship.present) continue
    relationship.from.columns.forEach((column, index) => {
      const target = relationship.to.columns[index]
      if (target === undefined) return
      const list = references.get(column) ?? []
      list.push({
        objectId: relationship.to.objectId,
        schema: relationship.to.schema,
        name: relationship.to.name,
        column: target,
        present: relationship.to.present,
      })
      references.set(column, list)
    })
  }
  return references
}

/** Malformed ids fail validation; either way the item does not exist here. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 422)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again."
}
