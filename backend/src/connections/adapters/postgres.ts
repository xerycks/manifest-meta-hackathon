import type { ConnectionOptions } from "node:tls"

import { Client, Pool, type ClientConfig } from "pg"

import type { PostgresConfig } from "../schemas.js"
import {
  SourceConnectionError,
  type SavedSource,
  type SourceAdapter,
  type SourceSecret,
} from "./types.js"

const APPLICATION_NAME = "manifest-source"
const CONNECT_TIMEOUT_MS = 5_000
const TEST_STATEMENT_TIMEOUT_MS = 10_000
const POOL_STATEMENT_TIMEOUT_MS = 30_000
const POOL_MAX_CLIENTS = 3
const POOL_IDLE_TIMEOUT_MS = 30_000
/** Pools kept per process; the least recently used one closes beyond this. */
const MAX_POOLS = 20
const MAX_SCHEMAS = 1_000

// pg_* covers pg_catalog, pg_toast, pg_temp_N, and pg_toast_temp_N.
const LIST_SCHEMAS_SQL = `
  SELECT nspname AS name
    FROM pg_catalog.pg_namespace
   WHERE nspname NOT LIKE 'pg\\_%'
     AND nspname <> 'information_schema'
     AND has_schema_privilege(oid, 'USAGE')
   ORDER BY nspname
   LIMIT ${MAX_SCHEMAS}`

function sslOptions(mode: PostgresConfig["sslMode"]): false | ConnectionOptions {
  switch (mode) {
    case "disable":
      return false
    case "require":
      // Encrypted without certificate checks, like libpq's sslmode=require.
      return { rejectUnauthorized: false }
    case "verify-full":
      // pg sets the TLS server name from the host, so the certificate must match it.
      return { rejectUnauthorized: true }
  }
}

function clientConfig(config: PostgresConfig, secret: SourceSecret): ClientConfig {
  const password = secret.password ?? ""
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    // A function stops pg from falling back to PGPASSWORD or this server's ~/.pgpass.
    password: () => password,
    ssl: sslOptions(config.sslMode),
    application_name: APPLICATION_NAME,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  }
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return ""
  const code = (error as { code?: unknown }).code
  if (typeof code === "string") return code
  // Happy-eyeballs connects report an AggregateError of per-address failures.
  const nested = (error as { errors?: unknown }).errors
  return Array.isArray(nested) ? errorCode(nested[0]) : ""
}

const TLS_CERT_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
])

const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"])

/**
 * Maps driver errors to a stable reason and a message written here — the
 * driver's own text is never passed through, so nothing it echoes can leak.
 */
export function mapPostgresError(error: unknown): SourceConnectionError {
  const code = errorCode(error)
  const message = error instanceof Error ? error.message : ""

  if (code === "28000" && /no encryption|SSL off/i.test(message)) {
    return new SourceConnectionError(
      "tls_failed",
      "The server requires an encrypted connection. Choose SSL mode “Require” or “Verify full”.",
    )
  }
  if (code === "28P01" || code === "28000") {
    return new SourceConnectionError("auth_failed", "PostgreSQL rejected the username or password.")
  }
  if (/client password must be/i.test(message)) {
    return new SourceConnectionError("auth_failed", "PostgreSQL requires a password for this user.")
  }
  if (code === "3D000") {
    return new SourceConnectionError(
      "database_not_found",
      "PostgreSQL has no database with that name. Check the database name.",
    )
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new SourceConnectionError(
      "host_unreachable",
      "The host name could not be resolved. Check the host.",
    )
  }
  if (UNREACHABLE_CODES.has(code)) {
    return new SourceConnectionError(
      "host_unreachable",
      "Could not reach PostgreSQL at that host and port. Check that the server is running and accepts connections from Manifest.",
    )
  }
  if (code === "57014" || code === "ETIMEDOUT" || /timeout/i.test(message)) {
    return new SourceConnectionError(
      "timeout",
      "The server did not respond in time. Check the host, port, and any firewall between Manifest and the database.",
    )
  }
  if (/does not support SSL/i.test(message)) {
    return new SourceConnectionError(
      "tls_failed",
      "The server does not accept SSL connections. Choose SSL mode “Disable” only for a trusted local or private network.",
    )
  }
  if (TLS_CERT_CODES.has(code) || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL")) {
    return new SourceConnectionError(
      "tls_failed",
      "The server's TLS certificate could not be verified. Check the host name, or use SSL mode “Require” for a private certificate.",
    )
  }
  return new SourceConnectionError(
    "unknown",
    "PostgreSQL connection failed. Check the connection details and try again.",
  )
}

export function createPostgresAdapter(): SourceAdapter<PostgresConfig> {
  // Insertion order doubles as recency: entries are re-inserted on use.
  const pools = new Map<string, { version: string; pool: Pool }>()

  async function endPool(pool: Pool): Promise<void> {
    await pool.end().catch(() => {})
  }

  function poolFor(source: SavedSource<PostgresConfig>): Pool {
    const existing = pools.get(source.id)
    if (existing) pools.delete(source.id)
    if (existing?.version === source.version) {
      pools.set(source.id, existing)
      return existing.pool
    }
    if (existing) void endPool(existing.pool)

    const pool = new Pool({
      ...clientConfig(source.config, source.secret),
      max: POOL_MAX_CLIENTS,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      statement_timeout: POOL_STATEMENT_TIMEOUT_MS,
      // Client-side bound too, in case a stalled server never answers.
      query_timeout: POOL_STATEMENT_TIMEOUT_MS + 2_000,
    })
    pool.on("error", (error) => {
      // Idle clients drop when a source restarts; log only the safe reason.
      console.warn(`Source ${source.id} lost an idle connection (${mapPostgresError(error).reason})`)
    })
    pools.set(source.id, { version: source.version, pool })

    for (const [id, entry] of pools) {
      if (pools.size <= MAX_POOLS) break
      pools.delete(id)
      void endPool(entry.pool)
    }
    return pool
  }

  return {
    async test(config, secret) {
      const client = new Client({
        ...clientConfig(config, secret),
        statement_timeout: TEST_STATEMENT_TIMEOUT_MS,
        query_timeout: TEST_STATEMENT_TIMEOUT_MS + 2_000,
      })
      // Late socket errors also reject the awaited call below; this keeps them from crashing.
      client.on("error", () => {})
      const started = performance.now()
      try {
        await client.connect()
        const version = await client.query<{ version: string }>(
          "SELECT current_setting('server_version') AS version",
        )
        const latencyMs = Math.round(performance.now() - started)
        const schemas = await client.query<{ name: string }>(LIST_SCHEMAS_SQL)
        return {
          serverVersion: version.rows[0]?.version ?? "unknown",
          latencyMs,
          schemas: schemas.rows.map((row) => row.name),
        }
      } catch (error) {
        throw mapPostgresError(error)
      } finally {
        await client.end().catch(() => {})
      }
    },

    async listSchemas(source) {
      try {
        const { rows } = await poolFor(source).query<{ name: string }>(LIST_SCHEMAS_SQL)
        return rows.map((row) => row.name)
      } catch (error) {
        throw mapPostgresError(error)
      }
    },

    async evict(connectionId) {
      const entry = pools.get(connectionId)
      if (!entry) return
      pools.delete(connectionId)
      await endPool(entry.pool)
    },

    async close() {
      const entries = [...pools.values()]
      pools.clear()
      await Promise.all(entries.map((entry) => endPool(entry.pool)))
    },
  }
}
