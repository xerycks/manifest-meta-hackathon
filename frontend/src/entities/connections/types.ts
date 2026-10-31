export type ConnectionEngine = "postgres" | "mongodb"
export type SslMode = "disable" | "require" | "verify-full"
export type ConnectionStatus = "untested" | "connected" | "failed"

/** Stable reasons the backend reports with SOURCE_CONNECTION_FAILED. */
export type ConnectionFailureReason =
  | "auth_failed"
  | "database_not_found"
  | "host_unreachable"
  | "timeout"
  | "tls_failed"
  | "unknown"

export interface PostgresConfig {
  host: string
  port: number
  database: string
  username: string
  sslMode: SslMode
}

/** MongoDB settings entered field by field; without a username Manifest does not sign in. */
export interface MongoFieldsConfig {
  mode: "fields"
  host: string
  port: number
  /** Offered when the user may not list databases. */
  database: string
  username: string | null
  /** Where the user is defined; null means "admin". */
  authSource: string | null
  tls: boolean
}

/** A saved connection string, as the API shows it: hosts and database, never credentials. */
export interface MongoUriSummary {
  mode: "uri"
  hosts: string[]
  srv: boolean
  database: string | null
}

export type MongoConfig = MongoFieldsConfig | MongoUriSummary

export type AnalysisOperation = "sql_select" | "find" | "aggregate"

/** What analysis can run against a source; everything is read-only. */
export interface SourceCapabilities {
  queryLanguage: "sql" | "mongodb"
  operations: AnalysisOperation[]
  readOnly: true
  joins: boolean
  aggregates: boolean
  allowedStages: string[] | null
  forbiddenStages: string[] | null
  forbiddenOperators: string[]
  summary: string
}

/**
 * A saved source as the API returns it. Secrets are never sent back:
 * `hasPassword` says one is saved (for connection-string sources, the string).
 */
export type Connection = (
  | { engine: "postgres"; config: PostgresConfig }
  | { engine: "mongodb"; config: MongoConfig }
) & {
  id: string
  workspaceId: string
  name: string
  hasPassword: boolean
  /** PostgreSQL schemas or MongoDB databases. */
  schemas: string[]
  status: ConnectionStatus
  lastTestedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  capabilities: SourceCapabilities
}

export interface ConnectionTestResult {
  serverVersion: string
  latencyMs: number
  /** Schemas, or databases for MongoDB. */
  schemas: string[]
  /** The user may not list databases, so only the configured one is offered. */
  schemaListLimited: boolean
}

/** Settings as sent: a connection string travels in `uri`, next to the password. */
export type ConnectionSettingsInput =
  | { engine: "postgres"; config: PostgresConfig; password?: string }
  | {
      engine: "mongodb"
      config: MongoFieldsConfig | { mode: "uri" }
      password?: string
      uri?: string
    }

/** While editing, omitted credentials reuse the saved ones where the backend allows it. */
export type TestConnectionInput = ConnectionSettingsInput & { connectionId?: string }

export type CreateConnectionInput = ConnectionSettingsInput & {
  name: string
  schemas: string[]
}

export interface UpdateConnectionInput {
  name?: string
  config?: PostgresConfig | MongoFieldsConfig | { mode: "uri" }
  /** Omitted keeps the saved password. */
  password?: string
  /** Omitted keeps the saved connection string. */
  uri?: string
  schemas?: string[]
}
