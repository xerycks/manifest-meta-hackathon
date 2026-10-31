import { MongoClient, type MongoClientOptions } from "mongodb"

import { QUERY_LIMITS } from "../../queries/schemas.js"
import { isSystemDatabase, type MongoConfig } from "../schemas.js"
import { OPERATION_MAX_TIME_MS, readMongoMetadata } from "./mongodb-discovery.js"
import { readMongoRows } from "./mongodb-query.js"
import {
  DiscoveryLimitExceeded,
  SourceConnectionError,
  SourceQueryError,
  type SavedSource,
  type SourceAdapter,
  type SourceSecret,
} from "./types.js"

const APP_NAME = "manifest-source"
const CONNECT_TIMEOUT_MS = 5_000
const SERVER_SELECTION_TIMEOUT_MS = 5_000
/** A client-side bound above the longest maxTimeMS (a query's), in case a server never answers. */
const SOCKET_TIMEOUT_MS = Math.max(OPERATION_MAX_TIME_MS, QUERY_LIMITS.maxTimeoutMs) + 5_000
const MAX_POOL_SIZE = 3
const MAX_IDLE_TIME_MS = 30_000
/** Clients kept per process; the least recently used one closes beyond this. */
const MAX_CLIENTS = 20
const MAX_DATABASES = 1_000

const UNAUTHORIZED = 13
const AUTHENTICATION_FAILED = 18
const MAX_TIME_EXPIRED = 50

/** Shared by test and saved-source clients; these override anything a connection string sets. */
const BASE_OPTIONS: MongoClientOptions = {
  appName: APP_NAME,
  connectTimeoutMS: CONNECT_TIMEOUT_MS,
  serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  socketTimeoutMS: SOCKET_TIMEOUT_MS,
  maxPoolSize: MAX_POOL_SIZE,
  minPoolSize: 0,
  maxIdleTimeMS: MAX_IDLE_TIME_MS,
  retryWrites: false,
}

function createClient(config: MongoConfig, secret: SourceSecret): MongoClient {
  if (config.mode === "uri") {
    if (!secret.uri) {
      throw new SourceConnectionError(
        "unknown",
        "The saved connection string is missing. Edit the source and enter it again.",
      )
    }
    try {
      return new MongoClient(secret.uri, BASE_OPTIONS)
    } catch {
      throw new SourceConnectionError(
        "unknown",
        "MongoDB cannot use this connection string. Check its format, hosts, and options.",
      )
    }
  }
  const host = config.host.includes(":") ? `[${config.host}]` : config.host
  return new MongoClient(`mongodb://${host}:${config.port}/`, {
    ...BASE_OPTIONS,
    tls: config.tls,
    // Credentials go in as options, never into the connection string.
    ...(config.username
      ? {
          auth: { username: config.username, password: secret.password ?? "" },
          authSource: config.authSource ?? "admin",
        }
      : {}),
  })
}

interface ErrorFacts {
  names: Set<string>
  codes: Set<string | number>
  messages: string[]
}

/** Error names, codes, and messages from an error and everything it wraps (causes, per-server errors). */
function collectFacts(
  error: unknown,
  facts: ErrorFacts = { names: new Set(), codes: new Set(), messages: [] },
  depth = 0,
): ErrorFacts {
  if (typeof error !== "object" || error === null || depth > 4) return facts
  const { name, code, message, cause, errors, reason } = error as {
    name?: unknown
    code?: unknown
    message?: unknown
    cause?: unknown
    errors?: unknown
    reason?: { servers?: unknown }
  }
  if (typeof name === "string") facts.names.add(name)
  if (typeof code === "string" || typeof code === "number") facts.codes.add(code)
  if (typeof message === "string") facts.messages.push(message)
  collectFacts(cause, facts, depth + 1)
  if (Array.isArray(errors)) for (const nested of errors) collectFacts(nested, facts, depth + 1)
  if (reason?.servers instanceof Map) {
    for (const server of reason.servers.values()) {
      collectFacts((server as { error?: unknown }).error, facts, depth + 1)
    }
  }
  return facts
}

const UNREACHABLE_CODES = ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EPIPE"]
const UNRESOLVED_CODES = ["ENOTFOUND", "EAI_AGAIN", "ENODATA", "ESERVFAIL", "ETIMEOUT"]
const TLS_CERT_CODES = [
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]

/**
 * Maps driver errors to a stable reason and a message written here — the
 * driver's own text is never passed through, so nothing it echoes can leak.
 */
export function mapMongoError(error: unknown): SourceConnectionError {
  const { names, codes, messages } = collectFacts(error)
  const has = (list: (string | number)[]) => list.some((code) => codes.has(code))
  const said = (pattern: RegExp) => messages.some((message) => pattern.test(message))

  if (codes.has(AUTHENTICATION_FAILED) || said(/authentication failed/i)) {
    return new SourceConnectionError(
      "auth_failed",
      "MongoDB rejected the username or password. Check them and the authentication database.",
    )
  }
  if (names.has("MongoMissingCredentialsError")) {
    return new SourceConnectionError("auth_failed", "MongoDB needs a password for this user.")
  }
  if (codes.has(UNAUTHORIZED)) {
    return new SourceConnectionError(
      "unknown",
      "MongoDB accepted the sign-in, but this user may not run the commands Manifest needs. Grant it read access.",
    )
  }
  if (has(TLS_CERT_CODES) || [...codes].some((code) => /^ERR_(TLS|SSL)/.test(String(code)))) {
    return new SourceConnectionError(
      "tls_failed",
      "The server's TLS certificate could not be verified. Check the host name, or use a connection string with your certificate settings.",
    )
  }
  if (said(/secure TLS connection|SSL routines|wrong version number/i)) {
    return new SourceConnectionError(
      "tls_failed",
      "The TLS handshake failed. Turn TLS off if this server does not use it, or on if it requires it.",
    )
  }
  if (has(UNRESOLVED_CODES)) {
    return new SourceConnectionError(
      "host_unreachable",
      "The host name (or its mongodb+srv DNS record) could not be resolved. Check the host.",
    )
  }
  if (has(UNREACHABLE_CODES)) {
    return new SourceConnectionError(
      "host_unreachable",
      "Could not reach MongoDB at that host and port. Check that the server is running and accepts connections from Manifest.",
    )
  }
  if (
    names.has("MongoNetworkTimeoutError") ||
    names.has("MongoServerSelectionError") ||
    names.has("MongoOperationTimeoutError") ||
    codes.has(50) ||
    codes.has("ETIMEDOUT")
  ) {
    return new SourceConnectionError(
      "timeout",
      "The server did not respond in time. Check the host, port, TLS setting, and any firewall between Manifest and the database.",
    )
  }
  return new SourceConnectionError(
    "unknown",
    "MongoDB connection failed. Check the connection details and try again.",
  )
}

/** Discovery reads fail for their own reasons; connection-level failures keep the shared mapping. */
export function mapMongoDiscoveryError(error: unknown): SourceConnectionError {
  const { codes } = collectFacts(error)
  if (codes.has(50)) {
    return new SourceConnectionError(
      "timeout",
      "Listing the collections took too long. Try again, or select fewer databases.",
    )
  }
  if (codes.has(UNAUTHORIZED)) {
    return new SourceConnectionError(
      "unknown",
      "The source user may not list the collections of the selected databases.",
    )
  }
  return mapMongoError(error)
}

/**
 * A query's own problems (unknown operator, bad expression) keep the server's
 * description of them; connection failures keep the shared mapping.
 */
export function mapMongoQueryError(error: unknown): SourceQueryError | SourceConnectionError {
  if (!(error instanceof Error) || error.name !== "MongoServerError") return mapMongoError(error)
  const code = Number((error as { code?: unknown }).code)
  if (code === MAX_TIME_EXPIRED) {
    return new SourceQueryError("The query ran past its time limit.", { timedOut: true })
  }
  if (code === UNAUTHORIZED) {
    return new SourceQueryError("The source user may not read this collection or run this query.")
  }
  if (code === AUTHENTICATION_FAILED) return mapMongoError(error)
  return SourceQueryError.fromServer(error.message)
}

/** A driver-level admin client, so tests can stand in for it. */
export interface DatabaseLister {
  db(name: string): { command(command: Record<string, unknown>): Promise<Record<string, unknown>> }
}

/**
 * Databases the user may select. Users without the listDatabases privilege
 * see the databases they hold privileges on; where even that is refused, the
 * configured database (the one in the settings or connection string) is
 * offered on its own.
 */
export async function listDatabases(
  client: DatabaseLister,
  configured: string | null,
): Promise<{ names: string[]; limited: boolean }> {
  try {
    const result = await client.db("admin").command({
      listDatabases: 1,
      nameOnly: true,
      authorizedDatabases: true,
      maxTimeMS: OPERATION_MAX_TIME_MS,
    })
    const databases = Array.isArray(result.databases) ? (result.databases as { name?: unknown }[]) : []
    const names = databases
      .map((database) => database.name)
      .filter((name): name is string => typeof name === "string" && !isSystemDatabase(name))
      .sort()
      .slice(0, MAX_DATABASES)
    return { names, limited: false }
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== UNAUTHORIZED) throw error
    return {
      names: configured && !isSystemDatabase(configured) ? [configured] : [],
      limited: true,
    }
  }
}

async function serverVersion(client: MongoClient): Promise<string> {
  try {
    const info = await client
      .db("admin")
      .command({ buildInfo: 1, maxTimeMS: OPERATION_MAX_TIME_MS })
    return typeof info.version === "string" ? info.version : "unknown"
  } catch (error) {
    if ((error as { name?: unknown }).name !== "MongoServerError") throw error
    return "unknown"
  }
}

export function createMongoAdapter(): SourceAdapter<MongoConfig> {
  // Insertion order doubles as recency: entries are re-inserted on use.
  const clients = new Map<string, { version: string; client: MongoClient }>()

  async function closeClient(client: MongoClient): Promise<void> {
    await client.close().catch(() => {})
  }

  function clientFor(source: SavedSource<MongoConfig>): MongoClient {
    const existing = clients.get(source.id)
    if (existing) clients.delete(source.id)
    if (existing?.version === source.version) {
      clients.set(source.id, existing)
      return existing.client
    }
    if (existing) void closeClient(existing.client)

    const client = createClient(source.config, source.secret)
    clients.set(source.id, { version: source.version, client })
    for (const [id, entry] of clients) {
      if (clients.size <= MAX_CLIENTS) break
      clients.delete(id)
      void closeClient(entry.client)
    }
    return client
  }

  return {
    async test(config, secret) {
      const client = createClient(config, secret)
      const started = performance.now()
      try {
        await client.connect()
        await client.db("admin").command({ ping: 1, maxTimeMS: OPERATION_MAX_TIME_MS })
        const latencyMs = Math.round(performance.now() - started)
        const version = await serverVersion(client)
        const databases = await listDatabases(client, config.database)
        return {
          serverVersion: version,
          latencyMs,
          schemas: databases.names,
          schemaListLimited: databases.limited,
        }
      } catch (error) {
        throw error instanceof SourceConnectionError ? error : mapMongoError(error)
      } finally {
        await closeClient(client)
      }
    },

    async listSchemas(source) {
      try {
        const databases = await listDatabases(clientFor(source), source.config.database)
        return databases.names
      } catch (error) {
        throw error instanceof SourceConnectionError ? error : mapMongoError(error)
      }
    },

    async discover(source, request) {
      request.signal.throwIfAborted()
      try {
        return await readMongoMetadata(clientFor(source), request)
      } catch (error) {
        request.signal.throwIfAborted()
        if (error instanceof DiscoveryLimitExceeded || error instanceof SourceConnectionError) {
          throw error
        }
        throw mapMongoDiscoveryError(error)
      }
    },

    async runQuery(source, request) {
      const { query, signal } = request
      if (query.language !== "mongodb") throw new Error("MongoDB sources run find and aggregate only")
      signal.throwIfAborted()
      try {
        return await readMongoRows(clientFor(source), query, request)
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof SourceQueryError || error instanceof SourceConnectionError) throw error
        throw mapMongoQueryError(error)
      }
    },

    async evict(connectionId) {
      const entry = clients.get(connectionId)
      if (!entry) return
      clients.delete(connectionId)
      await closeClient(entry.client)
    },

    async close() {
      const entries = [...clients.values()]
      clients.clear()
      await Promise.all(entries.map((entry) => closeClient(entry.client)))
    },
  }
}
