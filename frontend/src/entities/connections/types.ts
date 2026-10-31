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

/** A saved source as the API returns it. The password itself is never sent back. */
export interface Connection {
  id: string
  workspaceId: string
  name: string
  engine: ConnectionEngine
  config: PostgresConfig
  hasPassword: boolean
  schemas: string[]
  status: ConnectionStatus
  lastTestedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface ConnectionTestResult {
  serverVersion: string
  latencyMs: number
  schemas: string[]
}

export interface TestConnectionInput {
  engine: "postgres"
  config: PostgresConfig
  password?: string
  /** While editing: an omitted password reuses the saved one for the same server. */
  connectionId?: string
}

export interface CreateConnectionInput {
  name: string
  engine: "postgres"
  config: PostgresConfig
  password?: string
  schemas: string[]
}

export interface UpdateConnectionInput {
  name?: string
  config?: PostgresConfig
  /** Omitted keeps the saved password. */
  password?: string
  schemas?: string[]
}
