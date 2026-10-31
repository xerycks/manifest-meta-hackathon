/** How a member is shown next to something they wrote. */
export interface Author {
  id: string
  name: string
}

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
  label: string | null
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
  label: string | null
  /** Markdown. */
  description: string | null
  /** What one row represents, e.g. "one row per order line". */
  rowMeaning: string | null
  /** Increases with every edit; saves send the version they started from. */
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
  outgoing: ManifestRelationship[]
  incoming: ManifestRelationship[]
}

/** Omitted fields are kept; null or an empty string clears a field. */
export interface ObjectPatch {
  version: number
  label?: string | null
  description?: string | null
  rowMeaning?: string | null
}

export interface ColumnPatch {
  version: number
  label?: string | null
  description?: string | null
  unit?: string | null
  valueNotes?: string | null
}

export interface CreateRelationshipInput {
  fromColumnId: string
  toColumnId: string
  remark?: string | null
}

/** Foreign keys only take a remark; manual relationships can move to two other columns. */
export interface UpdateRelationshipInput {
  version: number
  fromColumnId?: string
  toColumnId?: string
  remark?: string | null
}

export type SearchField =
  | "name"
  | "label"
  | "description"
  | "rowMeaning"
  | "valueNotes"
  | "title"
  | "body"

export interface ObjectHit {
  connectionId: string
  connectionName: string
  objectId: string
  schema: string
  name: string
  label: string | null
  kind: ManifestObjectKind
  present: boolean
  matched: SearchField
  snippet: string | null
}

export interface ColumnHit {
  connectionId: string
  connectionName: string
  objectId: string
  objectSchema: string
  objectName: string
  columnId: string
  name: string
  label: string | null
  dataType: string
  present: boolean
  matched: SearchField
  snippet: string | null
}

export interface KnowledgeHit {
  entryId: string
  title: string
  connection: { id: string; name: string } | null
  matched: SearchField
  snippet: string | null
}

/** Workspace-wide search over manifests and the knowledge base. */
export interface SearchResults {
  query: string
  objects: ObjectHit[]
  columns: ColumnHit[]
  knowledge: KnowledgeHit[]
  truncated: boolean
}
