import type { PostgresConfig } from "../schemas.js"

/** Decrypted credentials, held only in memory for the duration of a source call. */
export interface SourceSecret {
  password?: string
}

export interface SourceTestResult {
  serverVersion: string
  latencyMs: number
  /** Non-system schemas the user may select, sorted by name. */
  schemas: string[]
}

/** A saved connection resolved for use; `version` changes whenever its settings change. */
export interface SavedSource<Config> {
  id: string
  version: string
  config: Config
  secret: SourceSecret
}

export type SourceFailureReason =
  | "auth_failed"
  | "database_not_found"
  | "host_unreachable"
  | "timeout"
  | "tls_failed"
  | "unknown"

/** A safe, user-facing connection failure. Never carries driver messages or credentials. */
export class SourceConnectionError extends Error {
  readonly reason: SourceFailureReason

  constructor(reason: SourceFailureReason, message: string) {
    super(message)
    this.name = "SourceConnectionError"
    this.reason = reason
  }
}

export type ManifestObjectKind =
  | "table"
  | "view"
  | "materialized_view"
  | "partitioned_table"
  | "foreign_table"

export interface DiscoveredColumn {
  name: string
  /** 1-based position in the object. */
  ordinal: number
  dataType: string
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  /** Labels of an enum-typed column, in their declared order. */
  enumValues: string[] | null
  comment: string | null
}

export interface DiscoveredObject {
  schema: string
  name: string
  kind: ManifestObjectKind
  comment: string | null
  estimatedRows: number | null
  viewDefinition: string | null
  columns: DiscoveredColumn[]
}

export interface DiscoveredRelationship {
  constraintName: string
  from: { schema: string; name: string; columns: string[] }
  to: { schema: string; name: string; columns: string[] }
}

/** Everything one discovery read, from a single consistent snapshot of the source catalog. */
export interface DiscoveredMetadata {
  objects: DiscoveredObject[]
  relationships: DiscoveredRelationship[]
}

export type DiscoveryPhase = "reading_objects" | "reading_columns" | "reading_relationships"

export interface DiscoveryProgress {
  phase: DiscoveryPhase
  objectsDone: number
  objectsTotal: number | null
}

export interface DiscoveryRequest {
  /** Only these schemas are read. */
  schemas: string[]
  /** Aborting stops discovery and cancels the query running on the source. */
  signal: AbortSignal
  /** Awaited, so progress writes never overlap or arrive out of order. */
  onProgress(progress: DiscoveryProgress): Promise<void>
}

/** The source has more metadata than one refresh may read; the message says which limit. */
export class DiscoveryLimitExceeded extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DiscoveryLimitExceeded"
  }
}

/**
 * One adapter per engine. `test` uses a short-lived connection for unsaved or
 * changed settings; saved sources run through a bounded per-connection pool
 * that is evicted on update/delete and closed on shutdown.
 */
export interface SourceAdapter<Config> {
  test(config: Config, secret: SourceSecret): Promise<SourceTestResult>
  listSchemas(source: SavedSource<Config>): Promise<string[]>
  /** Reads metadata for the requested schemas through the saved source's pool. */
  discover(source: SavedSource<Config>, request: DiscoveryRequest): Promise<DiscoveredMetadata>
  evict(connectionId: string): Promise<void>
  close(): Promise<void>
}

/** Engines implemented so far; MongoDB joins in Cycle 08. */
export interface SourceAdapters {
  postgres: SourceAdapter<PostgresConfig>
}
