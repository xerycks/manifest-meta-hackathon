import { randomUUID } from "node:crypto"

import { AppError } from "../shared/http/errors.js"
import { isUniqueViolation } from "../shared/postgres/errors.js"
import {
  SourceConnectionError,
  type DiscoveredMetadata,
  type DiscoveryRequest,
  type SavedSource,
  type SourceAdapter,
  type SourceAdapters,
  type SourceSecret,
  type SourceTestResult,
} from "./adapters/types.js"
import { CredentialSealer, CredentialsUnreadable, type SealBinding } from "./credentials.js"
import type { Connection, ConnectionsRepository } from "./repository.js"
import type {
  CreateConnectionInput,
  Engine,
  PostgresConfig,
  TestConnectionInput,
  UpdateConnectionInput,
} from "./schemas.js"

export const MAX_CONNECTIONS_PER_WORKSPACE = 50

function secretFrom(password: string | undefined): SourceSecret {
  return password ? { password } : {}
}

/**
 * A saved password is only reused against the same server identity, so an
 * edit cannot redirect it to a different host or weaken how it is sent.
 */
export function savedPasswordReusable(saved: PostgresConfig, next: PostgresConfig): boolean {
  return (
    saved.host === next.host &&
    saved.port === next.port &&
    saved.username === next.username &&
    saved.sslMode === next.sslMode
  )
}

/** Settings changes bump updatedAt, which retires the source's pooled connections. */
function savedSource(connection: Connection, secret: SourceSecret): SavedSource<PostgresConfig> {
  return { id: connection.id, version: connection.updatedAt, config: connection.config, secret }
}

function assertSchemasAvailable(selected: string[], available: string[]): void {
  const missing = selected.filter((name) => !available.includes(name))
  if (missing.length > 0) {
    throw AppError.validation(
      `These schemas were not found or are not readable: ${missing.join(", ")}`,
      { missingSchemas: missing },
    )
  }
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
    let secret = secretFrom(input.password)
    if (!input.password && input.connectionId) {
      secret = await this.reusableSecret(workspaceId, input.connectionId, input.config)
    }
    return this.runTest(input.engine, input.config, secret)
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
    const secret = secretFrom(input.password)
    const test = await this.runTest(input.engine, input.config, secret)
    assertSchemasAvailable(input.schemas, test.schemas)

    const id = randomUUID()
    const sealedSecret = secret.password
      ? this.sealer.seal(secret, { workspaceId, connectionId: id })
      : null
    try {
      return await this.connections.insert({
        id,
        workspaceId,
        name: input.name,
        engine: input.engine,
        config: input.config,
        sealedSecret,
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
    const config = input.config ?? saved.config
    const needsTest =
      input.config !== undefined || Boolean(input.password) || input.schemas !== undefined

    let sealedSecret: string | undefined
    if (needsTest) {
      const secret = input.password
        ? secretFrom(input.password)
        : await this.reusableSecret(workspaceId, id, config)
      const test = await this.runTest(saved.engine, config, secret)
      assertSchemasAvailable(input.schemas ?? saved.schemas, test.schemas)
      if (input.password) sealedSecret = this.sealer.seal(secret, { workspaceId, connectionId: id })
    }

    let updated: Connection | null
    try {
      updated = await this.connections.update(workspaceId, id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.config !== undefined ? { config: input.config } : {}),
        ...(sealedSecret !== undefined ? { sealedSecret } : {}),
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
      const test = await this.adapterFor(connection.engine).test(connection.config, secret)
      const recorded = await this.connections.recordTest(workspaceId, id, {
        status: "connected",
        error: null,
      })
      return { connection: recorded ?? connection, test }
    } catch (error) {
      if (!(error instanceof SourceConnectionError)) throw error
      await this.connections.recordTest(workspaceId, id, { status: "failed", error: error.message })
      throw AppError.sourceConnectionFailed(error.reason, error.message)
    }
  }

  /** Live schema list for a saved source, read through its pooled connection. */
  async listSchemas(workspaceId: string, id: string): Promise<string[]> {
    const { connection, secret } = await this.resolve(workspaceId, id)
    try {
      return await this.adapterFor(connection.engine).listSchemas(savedSource(connection, secret))
    } catch (error) {
      if (error instanceof SourceConnectionError) {
        throw AppError.sourceConnectionFailed(error.reason, error.message)
      }
      throw error
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
    return this.adapterFor(connection.engine).discover(savedSource(connection, secret), {
      ...options,
      schemas: connection.schemas,
    })
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    if (!(await this.connections.delete(workspaceId, id))) throw AppError.notFound("Source not found")
    await this.evict(id)
  }

  private adapterFor(engine: Engine): SourceAdapter<PostgresConfig> {
    if (engine !== "postgres") throw AppError.badRequest(`The ${engine} engine is not supported yet`)
    return this.adapters.postgres
  }

  /** Closes any pooled connections for a source whose settings changed or that was removed. */
  private async evict(id: string): Promise<void> {
    await Promise.all(Object.values(this.adapters).map((adapter) => adapter.evict(id)))
  }

  private async runTest(
    engine: Engine,
    config: PostgresConfig,
    secret: SourceSecret,
  ): Promise<SourceTestResult> {
    try {
      return await this.adapterFor(engine).test(config, secret)
    } catch (error) {
      if (error instanceof SourceConnectionError) {
        throw AppError.sourceConnectionFailed(error.reason, error.message)
      }
      throw error
    }
  }

  private async resolve(
    workspaceId: string,
    id: string,
  ): Promise<{ connection: Connection; secret: SourceSecret }> {
    const stored = await this.connections.getWithSecret(workspaceId, id)
    if (!stored) throw AppError.notFound("Source not found")
    return {
      connection: stored.connection,
      secret: this.open(stored.sealedSecret, { workspaceId, connectionId: id }),
    }
  }

  private async reusableSecret(
    workspaceId: string,
    id: string,
    next: PostgresConfig,
  ): Promise<SourceSecret> {
    const { connection, secret } = await this.resolve(workspaceId, id)
    if (secret.password && !savedPasswordReusable(connection.config, next)) {
      throw AppError.validation(
        "Re-enter the password: the saved one is only reused with the same host, port, username, and SSL mode.",
        { field: "password" },
      )
    }
    return secret
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
