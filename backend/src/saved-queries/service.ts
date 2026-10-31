import type { AgentRunsRepository } from "../agent/repository.js"
import type { QueryExecutionsRepository } from "../queries/repository.js"
import type { ExecutionRecord, ReadQuery } from "../queries/schemas.js"
import type { QueryExecutor } from "../queries/service.js"
import { AppError } from "../shared/http/errors.js"
import { isUniqueViolation } from "../shared/postgres/errors.js"
import { MANAGER_ROLES } from "../workspaces/access.js"
import type { WorkspaceRole, WorkspaceSettingsRepository } from "../workspaces/repository.js"
import { workspaceTimeZone } from "../workspaces/time-zone.js"
import { checkPlaceholders, clockWarnings, compileQuery, type BoundValue } from "./compile.js"
import { resolvedValues, resolveParameters, type RunValues } from "./parameters.js"
import type { SavedQueriesRepository } from "./repository.js"
import {
  SAVED_QUERY_LIMITS,
  type CreateSavedQueryInput,
  type ListRunsQuery,
  type ListSavedQueriesQuery,
  type ParameterDefinition,
  type SavedQuery,
  type SavedQueryDetail,
  type SavedQueryList,
  type SavedQueryOrigin,
  type SavedQueryRun,
  type SavedQueryRunPage,
  type UpdateSavedQueryInput,
} from "./schemas.js"

const NOT_FOUND = "Saved query not found"

export interface Actor {
  userId: string
  role: WorkspaceRole
}

export interface SavedQueriesServiceDeps {
  savedQueries: SavedQueriesRepository
  executions: QueryExecutionsRepository
  executor: QueryExecutor
  settings: WorkspaceSettingsRepository
  runs: AgentRunsRepository
  /** The current time; tests fix it. */
  now?: () => number
}

function nameTaken(name: string): AppError {
  return AppError.conflict(
    `A saved query named “${name}” already exists in this workspace (it may be private to someone else). Choose another name.`,
  )
}

/** The creator, or a workspace owner or admin, may change or delete a saved query. */
export function canChange(savedQuery: Pick<SavedQuery, "createdBy">, actor: Actor): boolean {
  return MANAGER_ROLES.includes(actor.role) || savedQuery.createdBy?.id === actor.userId
}

/**
 * Saved queries: kept with their source, checked by the query validators when
 * saved, and run through the query executor with the caller as user, so the
 * source's current schemas, validators, limits, and admission apply to every run.
 */
export class SavedQueriesService {
  private readonly now: () => number

  constructor(private readonly deps: SavedQueriesServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  list(workspaceId: string, userId: string, query: ListSavedQueriesQuery): Promise<SavedQueryList> {
    return this.deps.savedQueries.list(workspaceId, userId, query)
  }

  async get(workspaceId: string, userId: string, id: string): Promise<SavedQueryDetail> {
    return this.detail(workspaceId, await this.visible(workspaceId, userId, id))
  }

  async create(
    workspaceId: string,
    userId: string,
    input: CreateSavedQueryInput,
  ): Promise<SavedQueryDetail> {
    if ((await this.deps.savedQueries.count(workspaceId)) >= SAVED_QUERY_LIMITS.perWorkspace) {
      throw AppError.conflict(
        `A workspace can have at most ${SAVED_QUERY_LIMITS.perWorkspace.toLocaleString("en-US")} saved queries.`,
      )
    }
    if (input.origin) await this.checkOrigin(workspaceId, userId, input.connectionId, input.origin)
    await this.check(workspaceId, input.connectionId, input.query, input.parameters)
    let saved: SavedQuery
    try {
      saved = await this.deps.savedQueries.insert({ workspaceId, userId, ...input })
    } catch (error) {
      throw isUniqueViolation(error) ? nameTaken(input.name) : error
    }
    return this.detail(workspaceId, saved)
  }

  /** The creator, or an owner or admin, edits; a save based on an older version gets 409 with the current one. */
  async update(
    workspaceId: string,
    id: string,
    input: UpdateSavedQueryInput,
    actor: Actor,
  ): Promise<SavedQueryDetail> {
    const savedQuery = await this.visible(workspaceId, actor.userId, id)
    if (!canChange(savedQuery, actor)) {
      throw AppError.forbidden("Only its creator or a workspace owner or admin can change this saved query")
    }
    const { version, ...changes } = input
    if (changes.query !== undefined || changes.parameters !== undefined) {
      await this.check(
        workspaceId,
        savedQuery.source.id,
        changes.query ?? savedQuery.query,
        changes.parameters ?? savedQuery.parameters,
      )
    }
    let result
    try {
      result = await this.deps.savedQueries.update(workspaceId, id, version, changes, actor.userId)
    } catch (error) {
      throw isUniqueViolation(error) ? nameTaken(changes.name ?? savedQuery.name) : error
    }
    if (result.status === "missing") throw AppError.notFound(NOT_FOUND)
    if (result.status === "stale") throw AppError.stale("saved query", result.current)
    return this.detail(workspaceId, result.record)
  }

  async remove(workspaceId: string, id: string, actor: Actor): Promise<void> {
    const savedQuery = await this.visible(workspaceId, actor.userId, id)
    if (!canChange(savedQuery, actor)) {
      throw AppError.forbidden("Only its creator or a workspace owner or admin can delete this saved query")
    }
    if (!(await this.deps.savedQueries.delete(workspaceId, id))) throw AppError.notFound(NOT_FOUND)
  }

  /**
   * Runs the saved query with the run's values (else the defaults), resolved
   * in the workspace time zone now. The executor applies the source's current
   * schemas, validators, limits, and admission (429 QUERY_BUSY passes through).
   */
  async run(
    workspaceId: string,
    userId: string,
    id: string,
    values: RunValues,
    signal?: AbortSignal,
  ): Promise<SavedQueryRun> {
    const savedQuery = await this.visible(workspaceId, userId, id)
    const timeZone = await workspaceTimeZone(this.deps.settings, workspaceId)
    const compiled = await compileQuery(savedQuery.query)
    checkPlaceholders(compiled, savedQuery.parameters)
    const { parameters, instants } = resolveParameters(savedQuery.parameters, values, {
      timeZone,
      now: this.now(),
      requireValues: true,
    })
    const bound = new Map<string, BoundValue>(
      parameters.map((parameter) => [
        parameter.name,
        { value: parameter.value, instant: instants.get(parameter.name) ?? null },
      ]),
    )
    const execution = await this.deps.executor.execute({
      workspaceId,
      userId,
      connectionId: savedQuery.source.id,
      origin: "saved_query",
      query: compiled.bind(bound),
      savedQueryId: savedQuery.id,
      parameters: resolvedValues(parameters),
      ...(signal ? { signal } : {}),
    })
    await this.deps.savedQueries.recordRun(workspaceId, id, {
      executionId: execution.id,
      succeeded: execution.status === "succeeded",
    })
    if (execution.status === "rejected") throw rejected(execution)
    return { execution, parameters, timeZone }
  }

  async runs(
    workspaceId: string,
    userId: string,
    id: string,
    page: ListRunsQuery,
  ): Promise<SavedQueryRunPage> {
    await this.visible(workspaceId, userId, id)
    const rows = await this.deps.executions.listForSavedQuery(workspaceId, id, page)
    return {
      runs: rows.slice(0, page.limit),
      nextOffset: rows.length > page.limit ? page.offset + page.limit : null,
    }
  }

  /** The definition with its defaults as they resolve now, warnings, and latest result. */
  private async detail(workspaceId: string, savedQuery: SavedQuery): Promise<SavedQueryDetail> {
    const timeZone = await workspaceTimeZone(this.deps.settings, workspaceId)
    const compiled = await compileQuery(savedQuery.query)
    const { parameters } = resolveParameters(savedQuery.parameters, {}, {
      timeZone,
      now: this.now(),
      requireValues: false,
    })
    const latestRun = savedQuery.lastExecutionId
      ? await this.deps.executions.get(workspaceId, savedQuery.source.id, savedQuery.lastExecutionId)
      : null
    return { ...savedQuery, timeZone, defaults: parameters, warnings: clockWarnings(compiled), latestRun }
  }

  private async visible(workspaceId: string, userId: string, id: string): Promise<SavedQuery> {
    const savedQuery = await this.deps.savedQueries.get(workspaceId, userId, id)
    if (!savedQuery) throw AppError.notFound(NOT_FOUND)
    return savedQuery
  }

  /**
   * Compiles the query and checks its placeholders against the definitions,
   * then checks it with the source's validators, without running it.
   */
  private async check(
    workspaceId: string,
    connectionId: string,
    query: ReadQuery,
    definitions: ParameterDefinition[],
  ): Promise<void> {
    const compiled = await compileQuery(query)
    checkPlaceholders(compiled, definitions)
    // Resolving the defaults rejects fixed defaults that are not dates.
    resolveParameters(definitions, {}, { timeZone: "UTC", now: this.now(), requireValues: false })
    const sample = new Map<string, BoundValue>(
      compiled.names.map((name) => [name, { value: "2000-01-01", instant: 946_684_800_000 }]),
    )
    let rejection
    try {
      rejection = await this.deps.executor.check(workspaceId, connectionId, compiled.bind(sample))
    } catch (error) {
      if (error instanceof AppError && error.status === 404) {
        throw AppError.validation("Choose a source from this workspace.", { field: "connectionId" })
      }
      throw error
    }
    if (rejection) {
      throw AppError.queryRejected(rejection.message, {
        executionId: null,
        reason: rejection.reason,
        name: rejection.name,
      })
    }
  }

  /** A saved answer's query must come from that answer's evidence, in an answer the user asked. */
  private async checkOrigin(
    workspaceId: string,
    userId: string,
    connectionId: string,
    origin: SavedQueryOrigin,
  ): Promise<void> {
    const run = await this.deps.runs.getRun(workspaceId, userId, origin.runId)
    const cited = run?.answer?.evidence.find((item) => item.executionId === origin.executionId)
    if (!cited || cited.connectionId !== connectionId) {
      throw AppError.validation("The answer this query comes from does not cite that query run.", {
        field: "origin",
      })
    }
  }
}

function rejected(execution: ExecutionRecord): AppError {
  return AppError.queryRejected(execution.error?.message ?? "This query is not allowed.", {
    executionId: execution.id,
    reason: execution.error?.reason ?? null,
    name: execution.error?.name ?? null,
  })
}
