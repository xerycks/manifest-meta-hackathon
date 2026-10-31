import { randomUUID } from "node:crypto"

import { AppError } from "../shared/http/errors.js"
import { isUniqueViolation } from "../shared/postgres/errors.js"
import { withAdapter } from "./adapters/index.js"
import { inspectMongoUri, UnusableConnectionString } from "./adapters/mongodb-uri.js"
import {
  SourceConnectionError,
  type DiscoveredMetadata,
  type DiscoveryRequest,
  type SourceAdapters,
  type SourceSecret,
  type SourceTestResult,
} from "./adapters/types.js"
import { CredentialSealer, CredentialsUnreadable, type SealBinding } from "./credentials.js"
import type { Connection, ConnectionsRepository } from "./repository.js"
import type {
  CreateConnectionInput,
  MongoConfig,
  MongoConfigInput,
  PostgresConfig,
  SourceSettings,
  TestConnectionInput,
  UpdateConnectionInput,
} from "./schemas.js"

export const MAX_CONNECTIONS_PER_WORKSPACE = 50

/** Settings as submitted: a MongoDB connection string is summarized once it has been read. */
type SettingsInput =
  | { engine: "postgres"; config: PostgresConfig }
  | { engine: "mongodb"; config: MongoConfigInput | MongoConfig }

interface CredentialsInput {
  password?: string | undefined
  uri?: string | undefined
}

interface Resolved {
  connection: Connection
  secret: SourceSecret
}

/**
 * A saved password is only reused against the same server identity, so an
 * edit cannot redirect it to a different host or weaken how it is sent.
 */
export function savedPasswordReusable(saved: SourceSettings, next: SourceSettings): boolean {
  if (saved.engine === "postgres" && next.engine === "postgres") {
    const [a, b] = [saved.config, next.config]
    return a.host === b.host && a.port === b.port && a.username === b.username && a.sslMode === b.sslMode
  }
  if (saved.engine === "mongodb" && next.engine === "mongodb") {
    const [a, b] = [saved.config, next.config]
    return (
      a.mode === "fields" &&
      b.mode === "fields" &&
      a.host === b.host &&
      a.port === b.port &&
      a.username === b.username &&
      a.authSource === b.authSource &&
      a.tls === b.tls
    )
  }
  return false
}

/**
 * The settings and secret to connect with. Omitted credentials fall back to
 * the saved source's: a connection string is kept while the source stays in
 * connection-string mode, a password only for the same server identity.
 */
export function resolveCredentials(
  next: SettingsInput,
  given: CredentialsInput,
  saved: { settings: SourceSettings; secret: SourceSecret } | null,
): { settings: SourceSettings; secret: SourceSecret } {
  if (next.engine === "mongodb" && next.config.mode === "uri") {
    if (given.password) {
      throw AppError.validation("Put the password in the connection string.", { field: "password" })
    }
    const savedUri =
      saved?.settings.engine === "mongodb" && saved.settings.config.mode === "uri"
        ? saved.secret.uri
        : undefined
    const uri = given.uri ?? savedUri
    if (!uri) throw AppError.validation("Enter the connection string.", { field: "uri" })
    try {
      return { settings: { engine: "mongodb", config: inspectMongoUri(uri) }, secret: { uri } }
    } catch (error) {
      if (error instanceof UnusableConnectionString) {
        throw AppError.validation(error.message, { field: "uri" })
      }
      throw error
    }
  }
  if (given.uri) {
    throw AppError.validation("A connection string is only used in connection-string mode.", {
      field: "uri",
    })
  }
  // Only a connection string needs reading; any other settings are used as given.
  const settings = next as SourceSettings
  // Without a username Manifest does not sign in to MongoDB, so no saved password is needed.
  const signsIn =
    settings.engine === "postgres" ||
    settings.config.mode !== "fields" ||
    settings.config.username !== null
  let secret: SourceSecret = {}
  if (given.password) {
    secret = { password: given.password }
  } else if (saved?.secret.password && signsIn) {
    if (!savedPasswordReusable(saved.settings, settings)) {
      throw AppError.validation(
        "Re-enter the password: the saved one is only reused with the same host, port, username, and SSL or TLS setting.",
        { field: "password" },
      )
    }
    secret = { password: saved.secret.password }
  }
  if (settings.engine === "mongodb" && settings.config.mode === "fields") {
    if (secret.password && !settings.config.username) {
      throw AppError.validation("Enter the username for this password.", { field: "username" })
    }
  }
  return { settings, secret }
}

/** Settings changes bump updatedAt, which retires the source's pooled connections. */
const savedSource = <Config>(connection: Connection, config: Config, secret: SourceSecret) => ({
  id: connection.id,
  version: connection.updatedAt,
  config,
  secret,
})

function assertSchemasAvailable(selected: string[], available: string[]): void {
  const missing = selected.filter((name) => !available.includes(name))
  if (missing.length > 0) {
    throw AppError.validation(
      `These schemas or databases were not found or are not readable: ${missing.join(", ")}`,
      { missingSchemas: missing },
    )
  }
}

function sourceFailure(error: unknown): unknown {
  return error instanceof SourceConnectionError
    ? AppError.sourceConnectionFailed(error.reason, error.message)
    : error
}

/** A source keeps its engine: settings for another engine are refused. */
function settingsInput(saved: Connection, config: UpdateConnectionInput["config"]): SettingsInput {
  if (config === undefined) return saved
  if ("sslMode" in config && saved.engine === "postgres") return { engine: "postgres", config }
  if ("mode" in config && saved.engine === "mongodb") return { engine: "mongodb", config }
  throw AppError.validation(
    "These settings are for another kind of database. Add a new source to connect it.",
    { field: "config" },
  )
}

export class ConnectionsService {
  constructor(
    private readonly connections: ConnectionsRepository,
    private readonly sealer: CredentialSealer,
    private readonly adapters: SourceAdapters,
  ) {}

  list(workspaceId: string): Promise<Connection[]> {
    return this.connections.list(workspaceId)
  }

  async get(workspaceId: string, id: string): Promise<Connection> {
    const connection = await this.connections.get(workspaceId, id)
    if (!connection) throw AppError.notFound("Source not found")
    return connection
  }

  async testDraft(workspaceId: string, input: TestConnectionInput): Promise<SourceTestResult> {
    const credentials = { password: input.password, uri: "uri" in input ? input.uri : undefined }
    const saved =
      input.connectionId && !credentials.password && !credentials.uri
        ? await this.resolve(workspaceId, input.connectionId)
        : null
    const { settings, secret } = resolveCredentials(input, credentials, this.savedCredentials(saved))
    return this.runTest(settings, secret)
  }

  async create(
    workspaceId: string,
    userId: string,
    input: CreateConnectionInput,
  ): Promise<Connection> {
    if ((await this.connections.count(workspaceId)) >= MAX_CONNECTIONS_PER_WORKSPACE) {
      throw AppError.conflict(
        `A workspace can have at most ${MAX_CONNECTIONS_PER_WORKSPACE} sources. Remove one first.`,
      )
    }
    const { settings, secret } = resolveCredentials(
      input,
      { password: input.password, uri: "uri" in input ? input.uri : undefined },
      null,
    )
    const test = await this.runTest(settings, secret)
    assertSchemasAvailable(input.schemas, test.schemas)

    const id = randomUUID()
    try {
      return await this.connections.insert({
        id,
        workspaceId,
        name: input.name,
        ...settings,
        sealedSecret: this.seal(secret, { workspaceId, connectionId: id }),
        schemas: input.schemas,
        createdBy: userId,
      })
    } catch (error) {
      throw isUniqueViolation(error) ? this.nameTaken(input.name) : error
    }
  }

  /** Renames apply directly; any other change must pass a connection test before it is saved. */
  async update(workspaceId: string, id: string, input: UpdateConnectionInput): Promise<Connection> {
    const saved = await this.get(workspaceId, id)
    const needsTest =
      input.config !== undefined ||
      Boolean(input.password) ||
      Boolean(input.uri) ||
      input.schemas !== undefined

    let changes: { config?: PostgresConfig | MongoConfig; sealedSecret?: string | null } = {}
    if (needsTest) {
      const next = settingsInput(saved, input.config)
      const given = { password: input.password, uri: input.uri }
      const stored = given.password || given.uri ? null : await this.resolve(workspaceId, id)
      const { settings, secret } = resolveCredentials(next, given, this.savedCredentials(stored))
      const test = await this.runTest(settings, secret)
      assertSchemasAvailable(input.schemas ?? saved.schemas, test.schemas)
      changes = {
        // A new connection string also changes its stored summary.
        ...(input.config !== undefined || input.uri ? { config: settings.config } : {}),
        sealedSecret: this.seal(secret, { workspaceId, connectionId: id }),
      }
    }

    let updated: Connection | null
    try {
      updated = await this.connections.update(workspaceId, id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...changes,
        ...(input.schemas !== undefined ? { schemas: input.schemas } : {}),
        tested: needsTest,
      })
    } catch (error) {
      throw isUniqueViolation(error) ? this.nameTaken(input.name ?? saved.name) : error
    }
    if (!updated) throw AppError.notFound("Source not found")
    await this.evict(id)
    return updated
  }

  /** Retests saved settings and records the outcome, including a failure, before answering. */
  async retest(
    workspaceId: string,
    id: string,
  ): Promise<{ connection: Connection; test: SourceTestResult }> {
    const { connection, secret } = await this.resolve(workspaceId, id)
    try {
      const test = await withAdapter(this.adapters, connection, (adapter, config) =>
        adapter.test(config, secret),
      )
      const recorded = await this.connections.recordTest(workspaceId, id, {
        status: "connected",
        error: null,
      })
      return { connection: recorded ?? connection, test }
    } catch (error) {
      if (!(error instanceof SourceConnectionError)) throw error
      await this.connections.recordTest(workspaceId, id, { status: "failed", error: error.message })
      throw sourceFailure(error)
    }
  }

  /** Live schema (MongoDB: database) list for a saved source, read through its pooled connection. */
  async listSchemas(workspaceId: string, id: string): Promise<string[]> {
    const { connection, secret } = await this.resolve(workspaceId, id)
    try {
      return await withAdapter(this.adapters, connection, (adapter, config) =>
        adapter.listSchemas(savedSource(connection, config, secret)),
      )
    } catch (error) {
      throw sourceFailure(error)
    }
  }

  /**
   * Reads the metadata of the source's currently selected schemas through its
   * pool. Source problems reject with SourceConnectionError or DiscoveryLimitExceeded.
   */
  async discoverMetadata(
    workspaceId: string,
    id: string,
    options: Omit<DiscoveryRequest, "schemas">,
  ): Promise<DiscoveredMetadata> {
    const { connection, secret } = await this.resolve(workspaceId, id)
    return withAdapter(this.adapters, connection, (adapter, config) =>
      adapter.discover(savedSource(connection, config, secret), {
        ...options,
        schemas: connection.schemas,
      }),
    )
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    if (!(await this.connections.delete(workspaceId, id))) throw AppError.notFound("Source not found")
    await this.evict(id)
  }

  /** Closes any pooled connections for a source whose settings changed or that was removed. */
  private async evict(id: string): Promise<void> {
    await Promise.all(Object.values(this.adapters).map((adapter) => adapter.evict(id)))
  }

  private async runTest(settings: SourceSettings, secret: SourceSecret): Promise<SourceTestResult> {
    try {
      return await withAdapter(this.adapters, settings, (adapter, config) =>
        adapter.test(config, secret),
      )
    } catch (error) {
      throw sourceFailure(error)
    }
  }

  private async resolve(workspaceId: string, id: string): Promise<Resolved> {
    const stored = await this.connections.getWithSecret(workspaceId, id)
    if (!stored) throw AppError.notFound("Source not found")
    return {
      connection: stored.connection,
      secret: this.open(stored.sealedSecret, { workspaceId, connectionId: id }),
    }
  }

  private savedCredentials(
    saved: Resolved | null,
  ): { settings: SourceSettings; secret: SourceSecret } | null {
    return saved ? { settings: saved.connection, secret: saved.secret } : null
  }

  /** Null when there is nothing to keep secret. */
  private seal(secret: SourceSecret, binding: SealBinding): string | null {
    return secret.password || secret.uri ? this.sealer.seal(secret, binding) : null
  }

  private open(sealedSecret: string | null, binding: SealBinding): SourceSecret {
    if (!sealedSecret) return {}
    try {
      return this.sealer.open(sealedSecret, binding)
    } catch (error) {
      if (error instanceof CredentialsUnreadable) {
        throw AppError.conflict(
          "The saved password for this source cannot be decrypted (was CONNECTION_ENCRYPTION_KEY changed?). Edit the source and re-enter its password.",
        )
      }
      throw error
    }
  }

  private nameTaken(name: string): AppError {
    return AppError.conflict(`A source named "${name}" already exists in this workspace`)
  }
}
