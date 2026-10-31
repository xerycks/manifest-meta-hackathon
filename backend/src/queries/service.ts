import { randomUUID } from "node:crypto"

import {
  SourceConnectionError,
  SourceQueryError,
  type ValidatedQuery,
} from "../connections/adapters/types.js"
import type { Connection } from "../connections/repository.js"
import type { ConnectionsService } from "../connections/service.js"
import type { ManifestsRepository } from "../manifests/repository.js"
import { AppError } from "../shared/http/errors.js"
import { isUniqueViolation } from "../shared/postgres/errors.js"
import { MANAGER_ROLES } from "../workspaces/access.js"
import type { WorkspaceRole } from "../workspaces/repository.js"
import { validateMongoQuery } from "./mongodb-validator.js"
import type {
  ExecutionOutcome,
  ExecutionStart,
  QueryExecutionsRepository,
} from "./repository.js"
import type { QueryRunner, QueryStopReason } from "./runner.js"
import {
  resolveLimits,
  type ExecutionError,
  type ExecutionRecord,
  type ExecutionSummary,
  type QueryLimits,
  type QueryOrigin,
  type ReadQuery,
  type Rejection,
} from "./schemas.js"
import { validateSql } from "./sql-validator.js"

/** The executor's own deadline trails the server-side timeout, so the source normally stops first. */
const DEADLINE_GRACE_MS = 1_000
const BUSY_RETRY_AFTER_SECONDS = 5

export interface ExecuteInput {
  workspaceId: string
  /** Who started it; null for unattended runs. */
  userId: string | null
  connectionId: string
  origin: QueryOrigin
  /** Chosen by the caller so a cancel can name the run while it is in flight; generated when omitted. */
  id?: string
  query: ReadQuery
  limits?: Partial<QueryLimits>
  /** Aborting it (for example, the HTTP client went away) cancels the query. */
  signal?: AbortSignal
  /** A saved query's run: which one, and its parameter values as they resolved. */
  savedQueryId?: string
  parameters?: Record<string, string | null>
}

export interface CancelInput {
  workspaceId: string
  connectionId: string
  executionId: string
  userId: string
  role: WorkspaceRole
}

const seconds = (ms: number) => `${ms / 1000} second${ms === 1000 ? "" : "s"}`

/**
 * Validates and runs read queries on sources for every caller (the console
 * now; the agent, saved queries, dashboards, and routines later) and records
 * each execution, including rejected ones.
 */
export class QueryExecutor {
  constructor(
    private readonly executions: QueryExecutionsRepository,
    private readonly connections: ConnectionsService,
    private readonly manifests: ManifestsRepository,
    private readonly runner: QueryRunner,
  ) {}

  /**
   * Resolves to the execution record whatever the query's outcome: succeeded
   * (with every returned row), rejected, failed, timed out, or cancelled.
   * Throws only when the run cannot start: unknown source (404), an id already
   * used (409), or too many queries running (429 QUERY_BUSY).
   */
  async execute(input: ExecuteInput): Promise<ExecutionRecord> {
    const start: ExecutionStart = {
      id: input.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      userId: input.userId,
      origin: input.origin,
      query: input.query,
      limits: resolveLimits(input.limits),
      ...(input.savedQueryId ? { savedQueryId: input.savedQueryId } : {}),
      ...(input.parameters ? { parameters: input.parameters } : {}),
    }
    if (this.runner.find(start.workspaceId, start.id)) throw this.idTaken()
    const connection = await this.connections.get(start.workspaceId, start.connectionId)
    const validated = await this.validate(connection, input.query)
    if ("rejection" in validated) {
      const { reason, message, name } = validated.rejection
      const error = { code: "QUERY_REJECTED", message, reason, name }
      return this.insert(start, { status: "rejected", error })
    }
    const job = {
      id: start.id,
      workspaceId: start.workspaceId,
      connectionId: start.connectionId,
      userId: start.userId,
    }
    const running = this.runner.run(job, (stop) => this.run(start, validated.query, stop, input.signal))
    if (!running) {
      throw AppError.queryBusy(
        "Too many queries are running on this source or in this workspace. Try again in a few seconds.",
        BUSY_RETRY_AFTER_SECONDS,
      )
    }
    return running
  }

  /**
   * Checks a query against the source's current schemas and validators
   * without running or recording it: null when it may run, otherwise why not.
   * Throws 404 for an unknown source.
   */
  async check(workspaceId: string, connectionId: string, query: ReadQuery): Promise<Rejection | null> {
    const connection = await this.connections.get(workspaceId, connectionId)
    const validated = await this.validate(connection, query)
    return "rejection" in validated ? validated.rejection : null
  }

  /**
   * Cancels a running query (its starter, or a workspace owner or admin) and
   * resolves to its record once the cancellation is recorded.
   */
  async cancel(input: CancelInput): Promise<ExecutionRecord> {
    const { workspaceId, connectionId, executionId } = input
    const running = this.runner.find(workspaceId, executionId)
    if (running && running.connectionId === connectionId) {
      this.assertMayCancel(running.userId, input)
      await this.runner.cancel(workspaceId, executionId)
      return this.get(workspaceId, connectionId, executionId)
    }
    const record = await this.get(workspaceId, connectionId, executionId)
    this.assertMayCancel(record.userId, input)
    throw AppError.conflict(
      record.status === "running"
        ? "This query is not running in this backend process, so it cannot be cancelled here."
        : "This query has already finished.",
      { status: record.status },
    )
  }

  async get(workspaceId: string, connectionId: string, id: string): Promise<ExecutionRecord> {
    const record = await this.executions.get(workspaceId, connectionId, id)
    if (!record) throw AppError.notFound("Query not found")
    return record
  }

  async history(workspaceId: string, connectionId: string, limit: number): Promise<ExecutionSummary[]> {
    await this.connections.get(workspaceId, connectionId)
    return this.executions.list(workspaceId, connectionId, limit)
  }

  private async validate(
    connection: Connection,
    query: ReadQuery,
  ): Promise<{ query: ValidatedQuery } | { rejection: Rejection }> {
    if (query.language !== connection.capabilities.queryLanguage) {
      const message =
        connection.engine === "postgres"
          ? "This is a PostgreSQL source: send a SQL query."
          : "This is a MongoDB source: send a find or aggregate query, not SQL."
      return { rejection: { reason: "language_not_supported", message, name: query.language } }
    }
    if (query.language === "sql") {
      const objects = await this.manifests.presentObjectNames(
        connection.workspaceId,
        connection.id,
        connection.schemas,
      )
      const scope = { schemas: connection.schemas, objects }
      const rejection = await validateSql(query.sql, scope, query.params?.length ?? 0)
      return rejection ? { rejection } : { query }
    }
    return validateMongoQuery(query, connection.schemas)
  }

  private async run(
    start: ExecutionStart,
    query: ValidatedQuery,
    stop: AbortSignal,
    request: AbortSignal | undefined,
  ): Promise<ExecutionRecord> {
    await this.insert(start, { status: "running" })
    const deadline = AbortSignal.timeout(start.limits.timeoutMs + DEADLINE_GRACE_MS)
    const signal = AbortSignal.any(request ? [stop, deadline, request] : [stop, deadline])
    const started = performance.now()
    let outcome: ExecutionOutcome
    try {
      const result = await this.connections.runQuery(start.workspaceId, start.connectionId, {
        query,
        limits: start.limits,
        executionId: start.id,
        signal,
      })
      outcome = { status: "succeeded", result }
    } catch (error) {
      const durationMs = Math.round(performance.now() - started)
      outcome = { ...this.failure(start, error, { signal, stop, deadline }), durationMs }
    }
    const record =
      (await this.executions.finish(start, outcome)) ??
      (await this.get(start.workspaceId, start.connectionId, start.id))
    // The response carries every row; the stored record keeps a bounded snapshot.
    return outcome.status === "succeeded" && record.status === "succeeded"
      ? { ...record, result: outcome.result, partialResult: false }
      : record
  }

  /** How a run ended, from which signal stopped it or what the source said. */
  private failure(
    start: ExecutionStart,
    error: unknown,
    signals: { signal: AbortSignal; stop: AbortSignal; deadline: AbortSignal },
  ): { status: "failed" | "cancelled" | "timed_out"; error: ExecutionError } {
    const ended = (
      status: "failed" | "cancelled" | "timed_out",
      code: string,
      message: string,
      reason: string | null = null,
    ) => ({ status, error: { code, message, reason, name: null } })
    const { signal, stop, deadline } = signals
    const cause: unknown = signal.aborted ? signal.reason : undefined
    const timedOut = error instanceof SourceQueryError && error.timedOut

    if ((signal.aborted && cause === deadline.reason) || timedOut) {
      return ended(
        "timed_out",
        "QUERY_TIMEOUT",
        `The query ran longer than ${seconds(start.limits.timeoutMs)} and was stopped on the source.`,
      )
    }
    if (signal.aborted && stop.aborted && cause === stop.reason) {
      if ((stop.reason as QueryStopReason) === "shutdown") {
        const message = "The backend stopped while this query was running. Run it again."
        return ended("failed", "QUERY_INTERRUPTED", message)
      }
      return ended("cancelled", "QUERY_CANCELLED", "The query was cancelled and stopped on the source.")
    }
    if (signal.aborted) {
      return ended(
        "cancelled",
        "QUERY_CANCELLED",
        "The request ended before the query finished, so the query was stopped on the source.",
      )
    }
    if (error instanceof SourceQueryError) return ended("failed", "QUERY_FAILED", error.message)
    if (error instanceof SourceConnectionError) {
      return ended("failed", "SOURCE_CONNECTION_FAILED", error.message, error.reason)
    }
    if (error instanceof AppError) return ended("failed", error.code, error.message)
    // Source errors are mapped above, so this is Manifest's own storage or code.
    console.error(`Query execution ${start.id} failed unexpectedly`, error)
    return ended(
      "failed",
      "INTERNAL_ERROR",
      "The query failed unexpectedly. Try again; if it keeps failing, check the backend logs.",
    )
  }

  private async insert(
    start: ExecutionStart,
    initial: Parameters<QueryExecutionsRepository["insert"]>[1],
  ): Promise<ExecutionRecord> {
    try {
      return await this.executions.insert(start, initial)
    } catch (error) {
      throw isUniqueViolation(error) ? this.idTaken() : error
    }
  }

  private assertMayCancel(startedBy: string | null, input: CancelInput): void {
    if (startedBy !== input.userId && !MANAGER_ROLES.includes(input.role)) {
      throw AppError.forbidden(
        "Only the person who started this query, or a workspace owner or admin, can cancel it",
      )
    }
  }

  private idTaken(): AppError {
    return AppError.conflict("A query with this id already exists. Use a new id for each run.")
  }
}
