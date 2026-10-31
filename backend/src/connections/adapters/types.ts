import type { ValidatedMongoQuery } from "../../queries/mongodb-validator.js"
import type { QueryLimits, QueryResult, SqlQuery } from "../../queries/schemas.js"
import type { MongoConfig, PostgresConfig } from "../schemas.js"

/** Decrypted credentials, held only in memory for the duration of a source call. */
export interface SourceSecret {
  password?: string
  /** A MongoDB connection string, which may carry credentials of its own. */
  uri?: string
}

export interface SourceTestResult {
  serverVersion: string
  latencyMs: number
  /** Non-system schemas (MongoDB: databases) the user may select, sorted by name. */
  schemas: string[]
  /** The user may not list databases, so only the configured one is offered (MongoDB). */
  schemaListLimited: boolean
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

const MAX_SERVER_MESSAGE_CHARS = 500

/**
 * The source refused or failed a query (bad SQL, a missing field, a server
 * timeout). The message is written here or is the server's own description
 * of the query's problem, which never carries credentials.
 */
export class SourceQueryError extends Error {
  readonly timedOut: boolean

  constructor(message: string, options: { timedOut?: boolean } = {}) {
    super(message)
    this.name = "SourceQueryError"
    this.timedOut = options.timedOut ?? false
  }

  /** The server's description of what is wrong with a query, tidied and bounded. */
  static fromServer(text: string): SourceQueryError {
    const message = text.replaceAll("\u0000", "").trim().replace(/\.$/, "") || "The query failed"
    const sentence = `${message.charAt(0).toUpperCase()}${message.slice(1)}`
    return new SourceQueryError(
      sentence.length > MAX_SERVER_MESSAGE_CHARS
        ? `${sentence.slice(0, MAX_SERVER_MESSAGE_CHARS - 1)}…`
        : `${sentence}.`,
    )
  }
}

export type ManifestObjectKind =
  | "table"
  | "view"
  | "materialized_view"
  | "partitioned_table"
  | "foreign_table"
  | "collection"

/** How often something was seen among the sampled documents, e.g. the "string" type in 184 of 200. */
export interface TypeCount {
  /** A BSON type as MongoDB's $type operator names it: "string", "int", "objectId", ... */
  type: string
  documents: number
}

/**
 * What sampling saw of one MongoDB field. Every type counts the documents in
 * which the field held it, so a mix is never collapsed into one type.
 */
export interface MongoFieldDetails {
  engine: "mongodb"
  /** Documents sampled from the collection. */
  sampleSize: number
  /** Most common first. A document whose array holds several types counts once for each. */
  types: TypeCount[]
  /** Sampled documents without the field. */
  missing: number
  /** For array values: the types of their elements, counted per document. */
  arrayElementTypes: TypeCount[] | null
  /** 0 for top-level fields; dotted paths reach into nested documents and arrays of documents. */
  depth: number
}

export interface MongoCollectionDetails {
  engine: "mongodb"
  /** Time series collections are listed as collections. */
  collectionType: "collection" | "timeseries" | "view"
  capped: boolean
  sampleSize: number
  /** "random" uses $sample; "first" reads in natural order where $sample is unavailable. */
  sampleMethod: "random" | "first"
  /** Sampling stopped early at the byte budget. */
  sampleBytesLimited: boolean
  /** More distinct fields than one collection records; later ones are left out. */
  fieldsTruncated: boolean
  /** Fields nested deeper than the limit are left out. */
  depthTruncated: boolean
  /** Why this collection could not be sampled; its fields from the last sample are kept. */
  sampleFailure: string | null
}

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
  /** Engine-specific detail (MongoDB: the sampled type mix and presence). */
  details: MongoFieldDetails | null
}

export interface DiscoveredObject {
  schema: string
  name: string
  kind: ManifestObjectKind
  comment: string | null
  /** PostgreSQL: the planner's row estimate. MongoDB: the estimated document count. */
  estimatedRows: number | null
  viewDefinition: string | null
  columns: DiscoveredColumn[]
  /** Its columns could not be read this time, so the published ones stay as they are. */
  keepColumns: boolean
  details: MongoCollectionDetails | null
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
  /** Only these schemas (MongoDB: databases) are read. */
  schemas: string[]
  /** Aborting stops discovery and cancels the query running on the source. */
  signal: AbortSignal
  /** Awaited, so progress writes never overlap or arrive out of order. */
  onProgress(progress: DiscoveryProgress): Promise<void>
}

/** Caps per refresh: beyond them a refresh fails with a clear message instead of publishing part. */
export const DISCOVERY_LIMITS = { objects: 2_000, columns: 50_000, relationships: 10_000 } as const

/** The source has more metadata than one refresh may read; the message says which limit. */
export class DiscoveryLimitExceeded extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DiscoveryLimitExceeded"
  }
}

/** A query that passed validation, ready to run on its engine. */
export type ValidatedQuery = SqlQuery | ValidatedMongoQuery

export interface QueryRunRequest {
  query: ValidatedQuery
  limits: QueryLimits
  /** The source's selected schemas (MongoDB: databases), e.g. for PostgreSQL's search_path. */
  schemas: string[]
  /** Tags the query's server operations so they can be found and stopped. */
  executionId: string
  /** Aborting stops the query on the source, not just the wait for it. */
  signal: AbortSignal
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
  /**
   * Runs a validated read through the saved source's pool, bounded by the
   * request's limits. Failures reject with SourceQueryError or
   * SourceConnectionError; an abort rejects with the signal's reason.
   */
  runQuery(source: SavedSource<Config>, request: QueryRunRequest): Promise<QueryResult>
  evict(connectionId: string): Promise<void>
  close(): Promise<void>
}

export interface SourceAdapters {
  postgres: SourceAdapter<PostgresConfig>
  mongodb: SourceAdapter<MongoConfig>
}
