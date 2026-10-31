export type ManifestObjectKind =
  | "table"
  | "view"
  | "materialized_view"
  | "partitioned_table"
  | "foreign_table"

export type RefreshStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"
export type RefreshTrigger = "manual" | "source_created" | "source_changed"
export type RefreshPhase =
  | "connecting"
  | "reading_objects"
  | "reading_columns"
  | "reading_relationships"
  | "publishing"

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
  kind: ManifestObjectKind
  columnCount: number
  estimatedRows: number | null
  present: boolean
  lastSeenAt: string
}

export interface ManifestSchema {
  name: string
  objects: ManifestObjectSummary[]
}

export interface ConnectionManifest {
  connectionId: string
  schemas: ManifestSchema[]
  /** The refresh whose results are shown, or null before the first one succeeds. */
  lastPublished: ManifestRefresh | null
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
}

export interface ManifestColumn {
  id: string
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
  present: boolean
  from: RelationshipEnd
  to: RelationshipEnd
}

export interface ManifestObjectDetail {
  object: ManifestObject
  columns: ManifestColumn[]
  outgoing: ManifestRelationship[]
  incoming: ManifestRelationship[]
}
