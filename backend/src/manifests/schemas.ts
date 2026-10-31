import { z } from "zod"

import type { Author } from "../auth/repository.js"
import type { DiscoveryPhase, ManifestObjectKind } from "../connections/adapters/types.js"

export type RefreshStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"
export type RefreshTrigger = "manual" | "source_created" | "source_changed"
export type RefreshPhase = "connecting" | DiscoveryPhase | "publishing"

/** What a successful refresh published. "Added" includes objects and columns that came back. */
export interface RefreshCounts {
  objects: number
  columns: number
  relationships: number
  objectsAdded: number
  objectsRemoved: number
  columnsAdded: number
  columnsRemoved: number
}

export interface ManifestRefresh {
  id: string
  connectionId: string
  status: RefreshStatus
  trigger: RefreshTrigger
  /** Last phase reached; kept after the run ends so a failure shows where it stopped. */
  phase: RefreshPhase | null
  objectsDone: number
  objectsTotal: number | null
  counts: RefreshCounts | null
  error: string | null
  triggeredBy: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface ManifestObjectSummary {
  id: string
  schema: string
  name: string
  label: string | null
  kind: ManifestObjectKind
  columnCount: number
  estimatedRows: number | null
  present: boolean
  lastSeenAt: string
}

export interface ConnectionManifest {
  connectionId: string
  /** The connection's selected schemas, each with its objects (present ones first). */
  schemas: { name: string; objects: ManifestObjectSummary[] }[]
  /** The refresh whose results are published, or null before the first one succeeds. */
  lastPublished: ManifestRefresh | null
  /** True when the listing hit its cap; narrow it with a search. */
  truncated: boolean
}

export interface ManifestObject {
  id: string
  connectionId: string
  schema: string
  name: string
  kind: ManifestObjectKind
  comment: string | null
  estimatedRows: number | null
  viewDefinition: string | null
  present: boolean
  removedAt: string | null
  firstSeenAt: string
  lastSeenAt: string
  // Authored meaning; refreshes never change it.
  label: string | null
  /** Markdown. */
  description: string | null
  /** What one row represents, e.g. "one row per order line". */
  rowMeaning: string | null
  /** Increases with every edit; a save names the version it started from. */
  version: number
  editedAt: string | null
  editedBy: Author | null
}

export interface ManifestColumn {
  id: string
  objectId: string
  name: string
  ordinal: number
  dataType: string
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  enumValues: string[] | null
  comment: string | null
  present: boolean
  removedAt: string | null
  // Authored meaning; refreshes never change it.
  label: string | null
  /** Markdown. */
  description: string | null
  unit: string | null
  /** Allowed or example values. */
  valueNotes: string | null
  version: number
  editedAt: string | null
  editedBy: Author | null
}

export interface RelationshipEnd {
  objectId: string
  schema: string
  name: string
  present: boolean
  columns: string[]
}

export interface ManifestRelationship {
  id: string
  origin: "foreign_key" | "manual"
  constraintName: string | null
  /** Discovered foreign keys only; manual relationships are never marked missing. */
  present: boolean
  from: RelationshipEnd
  to: RelationshipEnd
  remark: string | null
  version: number
  /** A manual relationship whose objects or columns are no longer in the source. */
  needsReview: boolean
}

export interface ManifestObjectDetail {
  object: ManifestObject
  columns: ManifestColumn[]
  /** Relationships from this object's columns to other objects. */
  outgoing: ManifestRelationship[]
  /** Relationships from other objects (or itself) that point at this object. */
  incoming: ManifestRelationship[]
}

export const connectionParamsSchema = z.object({ workspaceId: z.uuid(), connectionId: z.uuid() })
export const refreshParamsSchema = connectionParamsSchema.extend({ refreshId: z.uuid() })
export const objectParamsSchema = connectionParamsSchema.extend({ objectId: z.uuid() })

export const browseQuerySchema = z.strictObject({
  search: z
    .string()
    .trim()
    .max(100, "Search for at most 100 characters")
    .optional()
    .transform((value) => value || undefined),
})

export type BrowseQuery = z.infer<typeof browseQuerySchema>
