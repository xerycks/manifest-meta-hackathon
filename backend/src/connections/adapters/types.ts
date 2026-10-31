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

/**
 * One adapter per engine. `test` uses a short-lived connection for unsaved or
 * changed settings; saved sources run through a bounded per-connection pool
 * that is evicted on update/delete and closed on shutdown.
 */
export interface SourceAdapter<Config> {
  test(config: Config, secret: SourceSecret): Promise<SourceTestResult>
  listSchemas(source: SavedSource<Config>): Promise<string[]>
  evict(connectionId: string): Promise<void>
  close(): Promise<void>
}

/** Engines implemented so far; MongoDB joins in Cycle 08. */
export interface SourceAdapters {
  postgres: SourceAdapter<PostgresConfig>
}
