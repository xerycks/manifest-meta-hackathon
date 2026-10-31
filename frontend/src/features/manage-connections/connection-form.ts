import type {
  Connection,
  ConnectionEngine,
  ConnectionFailureReason,
  ConnectionSettingsInput,
  CreateConnectionInput,
  SslMode,
  TestConnectionInput,
  UpdateConnectionInput,
} from "../../entities/connections/types.ts"
import { ApiError } from "../../shared/api/client.ts"

/** MongoDB settings come field by field or as one connection string. */
export type MongoMode = "fields" | "uri"

/** What the form edits. Everything stays a string until it is sent. */
export interface ConnectionDraft {
  engine: ConnectionEngine
  name: string
  host: string
  port: string
  database: string
  username: string
  password: string
  /** PostgreSQL only. */
  sslMode: SslMode
  // MongoDB only.
  mongoMode: MongoMode
  authSource: string
  tls: boolean
  uri: string
}

export type DraftErrors = Partial<Record<keyof ConnectionDraft, string>>

export const SSL_MODE_OPTIONS: { value: SslMode; label: string }[] = [
  { value: "require", label: "Require — encrypted" },
  { value: "verify-full", label: "Verify full — encrypted, certificate checked" },
  { value: "disable", label: "Disable — local or private networks only" },
]

export const DEFAULT_PORTS: Record<ConnectionEngine, string> = { postgres: "5432", mongodb: "27017" }

export function emptyDraft(engine: ConnectionEngine = "postgres"): ConnectionDraft {
  return {
    engine,
    name: "",
    host: "",
    port: DEFAULT_PORTS[engine],
    database: "",
    username: "",
    password: "",
    sslMode: "require",
    mongoMode: "fields",
    authSource: "",
    tls: true,
    uri: "",
  }
}

/** Switches a new source's engine, keeping what still applies. */
export function withEngine(draft: ConnectionDraft, engine: ConnectionEngine): ConnectionDraft {
  if (draft.engine === engine) return draft
  const port = draft.port === DEFAULT_PORTS[draft.engine] ? DEFAULT_PORTS[engine] : draft.port
  return { ...draft, engine, port }
}

/** Edit forms start from the saved settings; secrets always start empty. */
export function draftFromConnection(connection: Connection): ConnectionDraft {
  const base = { ...emptyDraft(connection.engine), name: connection.name }
  if (connection.engine === "postgres") {
    const { host, port, database, username, sslMode } = connection.config
    return { ...base, host, port: String(port), database, username, sslMode }
  }
  const config = connection.config
  if (config.mode === "uri") return { ...base, mongoMode: "uri", database: config.database ?? "" }
  return {
    ...base,
    host: config.host,
    port: String(config.port),
    database: config.database,
    username: config.username ?? "",
    authSource: config.authSource ?? "",
    tls: config.tls,
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

const MONGO_NAME_PROBLEM = /[/\\. "$*<>:|?]/

function mongoDatabaseProblem(name: string, label: string): string | undefined {
  return MONGO_NAME_PROBLEM.test(name)
    ? `The ${label} cannot contain spaces or any of / \\ . " $ * < > : | ?`
    : undefined
}

const usesUri = (draft: ConnectionDraft) => draft.engine === "mongodb" && draft.mongoMode === "uri"

/**
 * Problems to show next to each field. `savedUri` is true while editing a
 * source whose connection string is saved, so leaving it blank keeps it.
 */
export function draftErrors(draft: ConnectionDraft, savedUri = false): DraftErrors {
  const errors: DraftErrors = {}
  if (!draft.name.trim()) errors.name = "Enter a name"
  if (usesUri(draft)) {
    const uri = draft.uri.trim()
    if (!uri && !savedUri) errors.uri = "Paste the connection string"
    else if (uri && !/^mongodb(\+srv)?:\/\//.test(uri)) {
      errors.uri = "Start the connection string with mongodb:// or mongodb+srv://"
    }
    return errors
  }
  const host = hostProblem(draft.host.trim())
  if (host) errors.host = host
  if (parsePort(draft.port) === null) errors.port = "Enter a port from 1 to 65535"
  const database = draft.database.trim()
  if (!database) errors.database = "Enter a database name"
  if (draft.engine === "postgres") {
    if (!draft.username.trim()) errors.username = "Enter a username"
    return errors
  }
  const databaseProblem = database ? mongoDatabaseProblem(database, "database name") : undefined
  if (databaseProblem) errors.database = databaseProblem
  const authSource = mongoDatabaseProblem(draft.authSource.trim(), "authentication database")
  if (authSource) errors.authSource = authSource
  if (draft.password && !draft.username.trim()) errors.username = "Enter the username for this password"
  return errors
}

/** The settings to send, or null while any of them is invalid. */
export function configFromDraft(
  draft: ConnectionDraft,
  savedUri = false,
): ConnectionSettingsInput["config"] | null {
  if (Object.keys(draftErrors(draft, savedUri)).some((field) => field !== "name")) return null
  if (usesUri(draft)) return { mode: "uri" }
  const port = parsePort(draft.port) as number
  const common = { host: draft.host.trim(), port, database: draft.database.trim() }
  if (draft.engine === "postgres") {
    return { ...common, username: draft.username.trim(), sslMode: draft.sslMode }
  }
  return {
    mode: "fields",
    ...common,
    username: draft.username.trim() || null,
    authSource: draft.authSource.trim() || null,
    tls: draft.tls,
  }
}

/** True when two drafts would connect the same way, so an earlier test still applies. */
export function sameConnectionSettings(a: ConnectionDraft, b: ConnectionDraft): boolean {
  if (a.engine !== b.engine) return false
  if (usesUri(a) || usesUri(b)) return usesUri(a) && usesUri(b) && a.uri.trim() === b.uri.trim()
  return (
    a.host.trim() === b.host.trim() &&
    parsePort(a.port) === parsePort(b.port) &&
    a.database.trim() === b.database.trim() &&
    a.username.trim() === b.username.trim() &&
    a.password === b.password &&
    (a.engine === "postgres"
      ? a.sslMode === b.sslMode
      : a.authSource.trim() === b.authSource.trim() && a.tls === b.tls)
  )
}

/**
 * The backend only reuses a saved password for the same server identity
 * (host, port, username, and SSL mode, or for MongoDB also the authentication
 * database and TLS), and never turns a saved connection string into a password.
 */
export function needsPasswordReentry(connection: Connection, draft: ConnectionDraft): boolean {
  if (!connection.hasPassword || draft.password || usesUri(draft)) return false
  if (connection.engine === "postgres") {
    const saved = connection.config
    return (
      draft.host.trim() !== saved.host ||
      parsePort(draft.port) !== saved.port ||
      draft.username.trim() !== saved.username ||
      draft.sslMode !== saved.sslMode
    )
  }
  const saved = connection.config
  // Without a username Manifest does not sign in, so no password is needed.
  if (!draft.username.trim()) return false
  // A saved connection string holds no reusable password; signing in needs one typed.
  if (saved.mode === "uri") return true
  return (
    draft.host.trim() !== saved.host ||
    parsePort(draft.port) !== saved.port ||
    draft.username.trim() !== saved.username ||
    (draft.authSource.trim() || null) !== saved.authSource ||
    draft.tls !== saved.tls
  )
}

const savedUriOf = (connection: Connection | undefined) =>
  connection?.engine === "mongodb" && connection.config.mode === "uri"

function settingsInput(draft: ConnectionDraft, savedUri: boolean): ConnectionSettingsInput | null {
  const config = configFromDraft(draft, savedUri)
  if (!config) return null
  const password = draft.password && !usesUri(draft) ? { password: draft.password } : {}
  if ("sslMode" in config) return { engine: "postgres", config, ...password }
  const uri = usesUri(draft) && draft.uri.trim() ? { uri: draft.uri.trim() } : {}
  return { engine: "mongodb", config, ...password, ...uri }
}

export function toTestInput(draft: ConnectionDraft, connection?: Connection): TestConnectionInput | null {
  const input = settingsInput(draft, savedUriOf(connection))
  if (!input) return null
  return connection ? { ...input, connectionId: connection.id } : input
}

export function toCreateInput(draft: ConnectionDraft, schemas: string[]): CreateConnectionInput | null {
  const input = settingsInput(draft, false)
  if (!input || !draft.name.trim() || schemas.length === 0) return null
  return { ...input, name: draft.name.trim(), schemas: [...schemas].sort() }
}

const POSTGRES_KEYS = ["host", "port", "database", "username", "sslMode"] as const
const MONGO_KEYS = ["host", "port", "database", "username", "authSource", "tls"] as const

function configChanged(
  saved: Connection["config"],
  next: NonNullable<UpdateConnectionInput["config"]>,
): boolean {
  if ("sslMode" in next) {
    return !("sslMode" in saved) || POSTGRES_KEYS.some((key) => saved[key] !== next[key])
  }
  if (!("mode" in saved) || saved.mode !== next.mode) return true
  if (saved.mode === "uri" || next.mode === "uri") return false
  return MONGO_KEYS.some((key) => saved[key] !== next[key])
}

/** Only the fields that changed; empty secrets keep the saved ones. */
export function toUpdateInput(
  connection: Connection,
  draft: ConnectionDraft,
  schemas: string[],
): UpdateConnectionInput | null {
  const input = settingsInput(draft, savedUriOf(connection))
  if (!input || !draft.name.trim() || schemas.length === 0) return null
  const changes: UpdateConnectionInput = {}
  if (draft.name.trim() !== connection.name) changes.name = draft.name.trim()
  if (configChanged(connection.config, input.config)) changes.config = input.config
  if (input.password) changes.password = input.password
  if ("uri" in input && input.uri) changes.uri = input.uri
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
    if (error.code === "VALIDATION_FAILED") return { title: "Check the form", message: error.message }
    if (error.code === "CONFLICT") return { title: "Could not save", message: error.message }
    return { title: "Request failed", message: error.message }
  }
  return {
    title: "Request failed",
    message: error instanceof Error ? error.message : "Something went wrong. Please try again.",
  }
}
