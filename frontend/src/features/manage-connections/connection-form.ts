import type {
  Connection,
  ConnectionFailureReason,
  CreateConnectionInput,
  PostgresConfig,
  SslMode,
  TestConnectionInput,
  UpdateConnectionInput,
} from "../../entities/connections/types.ts"
import { ApiError } from "../../shared/api/client.ts"

/** What the form edits. Everything stays a string until it is sent. */
export interface ConnectionDraft {
  name: string
  host: string
  port: string
  database: string
  username: string
  password: string
  sslMode: SslMode
}

export type DraftErrors = Partial<Record<keyof ConnectionDraft, string>>

export const SSL_MODE_OPTIONS: { value: SslMode; label: string }[] = [
  { value: "require", label: "Require — encrypted" },
  { value: "verify-full", label: "Verify full — encrypted, certificate checked" },
  { value: "disable", label: "Disable — local or private networks only" },
]

export function emptyDraft(): ConnectionDraft {
  return {
    name: "",
    host: "",
    port: "5432",
    database: "",
    username: "",
    password: "",
    sslMode: "require",
  }
}

/** Edit forms start from the saved settings; the password field always starts empty. */
export function draftFromConnection(connection: Connection): ConnectionDraft {
  return {
    name: connection.name,
    host: connection.config.host,
    port: String(connection.config.port),
    database: connection.config.database,
    username: connection.config.username,
    password: "",
    sslMode: connection.config.sslMode,
  }
}

export function parsePort(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d{1,5}$/.test(trimmed)) return null
  const port = Number(trimmed)
  return port >= 1 && port <= 65_535 ? port : null
}

function hostProblem(host: string): string | undefined {
  if (!host) return "Enter a host"
  if (host.includes("://")) return "Enter only the host name, without a scheme such as postgres://"
  if (/^[^:\s]+:\d+$/.test(host)) return "Put the port in the Port field"
  if (/[\s/@?#]/.test(host)) return "Enter only a host name or IP address"
  return undefined
}

export function draftErrors(draft: ConnectionDraft): DraftErrors {
  const errors: DraftErrors = {}
  if (!draft.name.trim()) errors.name = "Enter a name"
  const host = hostProblem(draft.host.trim())
  if (host) errors.host = host
  if (parsePort(draft.port) === null) errors.port = "Enter a port from 1 to 65535"
  if (!draft.database.trim()) errors.database = "Enter a database name"
  if (!draft.username.trim()) errors.username = "Enter a username"
  return errors
}

/** The connection settings, or null while any of them is invalid. */
export function configFromDraft(draft: ConnectionDraft): PostgresConfig | null {
  const port = parsePort(draft.port)
  const errors = draftErrors(draft)
  if (port === null || errors.host || errors.database || errors.username) return null
  return {
    host: draft.host.trim(),
    port,
    database: draft.database.trim(),
    username: draft.username.trim(),
    sslMode: draft.sslMode,
  }
}

/** True when two drafts would connect the same way, so an earlier test still applies. */
export function sameConnectionSettings(a: ConnectionDraft, b: ConnectionDraft): boolean {
  return (
    a.host.trim() === b.host.trim() &&
    parsePort(a.port) === parsePort(b.port) &&
    a.database.trim() === b.database.trim() &&
    a.username.trim() === b.username.trim() &&
    a.sslMode === b.sslMode &&
    a.password === b.password
  )
}

/**
 * The backend only reuses a saved password for the same host, port, username,
 * and SSL mode; anything else needs the password typed again.
 */
export function needsPasswordReentry(connection: Connection, draft: ConnectionDraft): boolean {
  if (!connection.hasPassword || draft.password) return false
  const saved = connection.config
  return (
    draft.host.trim() !== saved.host ||
    parsePort(draft.port) !== saved.port ||
    draft.username.trim() !== saved.username ||
    draft.sslMode !== saved.sslMode
  )
}

export function toTestInput(draft: ConnectionDraft, connectionId?: string): TestConnectionInput | null {
  const config = configFromDraft(draft)
  if (!config) return null
  return {
    engine: "postgres",
    config,
    ...(draft.password ? { password: draft.password } : {}),
    ...(connectionId ? { connectionId } : {}),
  }
}

export function toCreateInput(draft: ConnectionDraft, schemas: string[]): CreateConnectionInput | null {
  const config = configFromDraft(draft)
  if (!config || !draft.name.trim() || schemas.length === 0) return null
  return {
    name: draft.name.trim(),
    engine: "postgres",
    config,
    ...(draft.password ? { password: draft.password } : {}),
    schemas: [...schemas].sort(),
  }
}

/** Only the fields that changed; an empty password keeps the saved one. */
export function toUpdateInput(
  connection: Connection,
  draft: ConnectionDraft,
  schemas: string[],
): UpdateConnectionInput | null {
  const config = configFromDraft(draft)
  if (!config || !draft.name.trim() || schemas.length === 0) return null
  const changes: UpdateConnectionInput = {}
  if (draft.name.trim() !== connection.name) changes.name = draft.name.trim()
  const saved = connection.config
  if (
    config.host !== saved.host ||
    config.port !== saved.port ||
    config.database !== saved.database ||
    config.username !== saved.username ||
    config.sslMode !== saved.sslMode
  ) {
    changes.config = config
  }
  if (draft.password) changes.password = draft.password
  const sorted = [...schemas].sort()
  if (sorted.join("\n") !== [...connection.schemas].sort().join("\n")) changes.schemas = sorted
  return changes
}

export interface SchemaOption {
  name: string
  /** Selected earlier but not on the server now (renamed, dropped, or no longer readable). */
  missing: boolean
}

/** Schemas to offer: what the server lists, plus any selected ones it no longer has. */
export function schemaOptions(available: string[] | null, selected: string[]): SchemaOption[] {
  const names = new Set([...(available ?? []), ...selected])
  return [...names]
    .sort()
    .map((name) => ({ name, missing: available !== null && !available.includes(name) }))
}

const FAILURE_TITLES: Record<ConnectionFailureReason, string> = {
  auth_failed: "Sign-in rejected",
  database_not_found: "Database not found",
  host_unreachable: "Server unreachable",
  timeout: "Connection timed out",
  tls_failed: "SSL/TLS problem",
  unknown: "Connection failed",
}

function detailsOf(error: ApiError): Record<string, unknown> {
  return typeof error.details === "object" && error.details !== null
    ? (error.details as Record<string, unknown>)
    : {}
}

/** A short title and a readable message for any error from the connection endpoints. */
export function describeConnectionError(error: unknown): { title: string; message: string } {
  if (error instanceof ApiError) {
    const details = detailsOf(error)
    if (error.code === "SOURCE_CONNECTION_FAILED") {
      const reason = details.reason as ConnectionFailureReason | undefined
      return { title: (reason && FAILURE_TITLES[reason]) ?? FAILURE_TITLES.unknown, message: error.message }
    }
    if (error.code === "VALIDATION_FAILED" && Array.isArray(details.issues)) {
      const messages = details.issues
        .map((issue: unknown) =>
          typeof issue === "object" && issue !== null ? (issue as { message?: unknown }).message : null,
        )
        .filter((message): message is string => typeof message === "string")
      if (messages.length > 0) return { title: "Check the form", message: messages.join(" ") }
    }
    if (error.code === "CONFLICT") return { title: "Could not save", message: error.message }
    return { title: "Request failed", message: error.message }
  }
  return {
    title: "Request failed",
    message: error instanceof Error ? error.message : "Something went wrong. Please try again.",
  }
}
