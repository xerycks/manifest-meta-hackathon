import type { AgentService } from "../agent/service.js"
import type { ConnectionsRepository } from "../connections/repository.js"
import type { ExecutionRecord } from "../queries/schemas.js"
import { resolveParameters } from "../saved-queries/parameters.js"
import type { SavedQueriesRepository } from "../saved-queries/repository.js"
import type { SavedQueriesService } from "../saved-queries/service.js"
import { AppError } from "../shared/http/errors.js"
import { parseInput } from "../shared/http/validate.js"
import { isUniqueViolation } from "../shared/postgres/errors.js"
import { MANAGER_ROLES } from "../workspaces/access.js"
import type {
  WorkspaceRole,
  WorkspaceSettingsRepository,
  WorkspacesRepository,
} from "../workspaces/repository.js"
import { workspaceTimeZone } from "../workspaces/time-zone.js"
import { retryWhileBusy, SHUTDOWN, type DispatchTarget, type RoutineDispatcher } from "./dispatcher.js"
import type {
  DueRoutine,
  QueuedRun,
  RoutineDefinition,
  RoutinesRepository,
  RunOutcome,
  SlotPlan,
  ViewedRoutine,
} from "./repository.js"
import {
  catchUp,
  describeSchedule,
  nextRunAfter,
  scheduleProblem,
  upcomingRuns,
  wallClock,
  type MissedSlots,
} from "./schedule.js"
import {
  ROUTINE_LIMITS,
  routineTargetSchema,
  type CreateRoutineInput,
  type ListRunsQuery,
  type Routine,
  type RoutineDetail,
  type RoutineList,
  type RoutineRun,
  type RoutineRunError,
  type RoutineRunPage,
  type RoutineTarget,
  type SchedulePreview,
  type UpdateRoutineInput,
} from "./schemas.js"

const NOT_FOUND = "Routine not found"
const BUSY_RETRY_AFTER_SECONDS = 30

export interface Actor {
  userId: string
  role: WorkspaceRole
}

export interface RoutinesServiceDeps {
  routines: RoutinesRepository
  savedQueries: SavedQueriesRepository
  /** Saved query routines run through the saved query run path. */
  savedQueryRuns: SavedQueriesService
  /** Null without a model provider: question routines cannot be created, and their runs fail. */
  agent: AgentService | null
  connections: ConnectionsRepository
  workspaces: WorkspacesRepository
  settings: WorkspaceSettingsRepository
  dispatcher: RoutineDispatcher
  minIntervalMinutes: number
}

/** The routine's owner, or a workspace owner or admin, manages it. */
export function canManage(routine: Pick<Routine, "owner">, actor: Actor): boolean {
  return MANAGER_ROLES.includes(actor.role) || routine.owner?.id === actor.userId
}

function nameTaken(name: string): AppError {
  return AppError.conflict(`A routine named “${name}” already exists in this workspace. Choose another name.`)
}

const failed = (code: string, message: string): RunOutcome => ({
  status: "failed",
  error: { code, message },
})

const INTERRUPTED: RoutineRunError = {
  code: "ROUTINE_INTERRUPTED",
  message: "The backend stopped while this run was in progress. It is not retried automatically; run the routine now if you need its result.",
}
const OWNER_GONE = failed(
  "ROUTINE_OWNER_REMOVED",
  "The routine's owner is no longer a member of this workspace, so it cannot run as them. A workspace owner or admin can delete it, and someone else can create it again.",
)
const SAVED_QUERY_REMOVED = failed("SAVED_QUERY_REMOVED", "The saved query this routine runs was deleted.")
const SAVED_QUERY_HIDDEN = failed(
  "SAVED_QUERY_UNAVAILABLE",
  "The routine's owner can no longer open the saved query it runs: it was deleted or made private by someone else.",
)
const CANCELLED: RoutineRunError = {
  code: "AGENT_CANCELLED",
  message: "The question was cancelled before it was answered.",
}
const CONVERSATION_DELETED: RoutineRunError = {
  code: "CONVERSATION_DELETED",
  message: "The routine's conversation was deleted while the question was being answered.",
}
const STILL_ANSWERING: RunOutcome = {
  status: "skipped",
  error: {
    code: "ROUTINE_STILL_RUNNING",
    message: "The routine's conversation was still answering an earlier question, so this run was skipped.",
  },
}

/** Slots are missed while no backend runs, or while every backend is busy with other runs. */
function missedMessage(missed: MissedSlots, timeZone: string): string {
  const first = wallClock(new Date(missed.first), timeZone)
  const last = wallClock(new Date(missed.last), timeZone)
  const why = "no backend was running or free to start it; only the latest due run started."
  if (missed.count === 1) return `The scheduled run at ${first} (${timeZone}) was skipped because ${why}`
  const count = missed.more ? `More than ${missed.count.toLocaleString("en-US")}` : String(missed.count)
  return `${count} scheduled runs from ${first} to ${last} (${timeZone}) were skipped because ${why}`
}

/**
 * Routines: a saved query or a question that runs on a schedule as its
 * owner, and on demand. Schedules are read in the routine's time zone with
 * the dispatcher's clock; runs record how they ended, and three failures in a
 * row pause a routine.
 */
export class RoutinesService implements DispatchTarget {
  constructor(private readonly deps: RoutinesServiceDeps) {}

  async list(workspaceId: string, viewerId: string): Promise<RoutineList> {
    return { routines: await this.deps.routines.list(workspaceId, viewerId) }
  }

  async get(workspaceId: string, viewerId: string, id: string): Promise<RoutineDetail> {
    return this.detail(await this.visible(workspaceId, viewerId, id))
  }

  /** Any member creates routines; they run as their creator, who owns them. */
  async create(workspaceId: string, userId: string, input: CreateRoutineInput): Promise<RoutineDetail> {
    if ((await this.deps.routines.count(workspaceId)) >= ROUTINE_LIMITS.perWorkspace) {
      throw AppError.conflict(`A workspace can have at most ${ROUTINE_LIMITS.perWorkspace} routines.`)
    }
    const { name, description, cron, enabled, delivery } = input
    const timeZone = input.timeZone ?? (await workspaceTimeZone(this.deps.settings, workspaceId))
    this.checkSchedule(cron, timeZone)
    const target: RoutineTarget =
      input.kind === "saved_query"
        ? { kind: input.kind, savedQueryId: input.savedQueryId, parameters: input.parameters }
        : { kind: input.kind, question: input.question, connectionIds: input.connectionIds }
    await this.checkTarget(workspaceId, userId, target, timeZone)
    let id: string
    try {
      id = await this.deps.routines.insert({
        workspaceId,
        ownerId: userId,
        name,
        description,
        target,
        cron,
        timeZone,
        nextRunAt: enabled ? this.nextRun(cron, timeZone) : null,
        delivery,
      })
    } catch (error) {
      throw isUniqueViolation(error) ? nameTaken(name) : error
    }
    return this.get(workspaceId, userId, id)
  }

  /**
   * The owner, or an owner or admin, edits; a save based on an older version
   * gets 409 with the current one. Target fields merge with the stored target
   * and are checked whole, as the owner runs it. A new schedule (or resuming)
   * moves the next run to its next slot after now.
   */
  async update(
    workspaceId: string,
    id: string,
    input: UpdateRoutineInput,
    actor: Actor,
  ): Promise<RoutineDetail> {
    const routine = await this.manageable(workspaceId, id, actor, "change")
    const stored = await this.storedDefinition(workspaceId, id)
    const { version, name, description, cron, timeZone, enabled, delivery, ...targetFields } = input
    const schedule = { cron: cron ?? routine.cron, timeZone: timeZone ?? routine.timeZone }
    if (cron !== undefined || timeZone !== undefined) this.checkSchedule(schedule.cron, schedule.timeZone)
    let target: RoutineTarget | undefined
    if (Object.keys(targetFields).length > 0) {
      const kind = targetFields.kind ?? stored.target.kind
      const base = kind === stored.target.kind ? stored.target : { kind }
      target = parseInput(routineTargetSchema, { ...base, ...targetFields })
      if (!stored.ownerId) {
        throw AppError.validation("This routine's owner no longer exists, so what it runs cannot be changed.")
      }
      await this.checkTarget(workspaceId, stored.ownerId, target, schedule.timeZone)
    }
    let result
    try {
      result = await this.deps.routines.update(
        workspaceId,
        actor.userId,
        id,
        version,
        { name, description, target, cron, timeZone, enabled, delivery },
        (nextCron, nextTimeZone) => this.nextRun(nextCron, nextTimeZone),
      )
    } catch (error) {
      throw isUniqueViolation(error) ? nameTaken(name ?? routine.name) : error
    }
    if (result.status === "missing") throw AppError.notFound(NOT_FOUND)
    if (result.status === "stale") throw AppError.stale("routine", this.detail(result.current))
    return this.detail(result.record)
  }

  /** Stops scheduled runs until resumed; manual runs still work. */
  async pause(workspaceId: string, id: string, actor: Actor): Promise<RoutineDetail> {
    await this.manageable(workspaceId, id, actor, "pause")
    if (!(await this.deps.routines.pause(workspaceId, id))) throw AppError.notFound(NOT_FOUND)
    return this.get(workspaceId, actor.userId, id)
  }

  /** Schedules the next slot after now; slots missed while paused do not run. */
  async resume(workspaceId: string, id: string, actor: Actor): Promise<RoutineDetail> {
    await this.manageable(workspaceId, id, actor, "resume")
    const resumed = await this.deps.routines.resume(workspaceId, id, (cron, timeZone) =>
      this.nextRun(cron, timeZone),
    )
    if (!resumed) throw AppError.notFound(NOT_FOUND)
    return this.get(workspaceId, actor.userId, id)
  }

  async remove(workspaceId: string, id: string, actor: Actor): Promise<void> {
    await this.manageable(workspaceId, id, actor, "delete")
    if (!(await this.deps.routines.delete(workspaceId, id))) throw AppError.notFound(NOT_FOUND)
  }

  /**
   * Starts a run now, paused or not, without touching the schedule. The same
   * mutation id returns the run it started (created: false).
   */
  async runNow(
    workspaceId: string,
    id: string,
    mutationId: string,
    actor: Actor,
  ): Promise<{ run: RoutineRun; created: boolean }> {
    await this.manageable(workspaceId, id, actor, "run")
    // Fail fast like other admission limits, so manual runs cannot crowd out scheduled ones;
    // a mutation id sent before still gets its run.
    if (
      this.deps.dispatcher.full &&
      !(await this.deps.routines.manualRunId(workspaceId, id, mutationId))
    ) {
      throw AppError.routineBusy(
        "This backend is already running as many routines as it can. Try again in a minute.",
        BUSY_RETRY_AFTER_SECONDS,
      )
    }
    const queued = await this.deps.routines.insertManualRun(workspaceId, id, mutationId, actor.userId)
    if (!queued) throw AppError.notFound(NOT_FOUND)
    if (queued.created) this.launch({ id: queued.id, workspaceId, routineId: id })
    const run = await this.deps.routines.getRun(workspaceId, actor.userId, queued.id)
    if (!run) throw AppError.notFound(NOT_FOUND)
    return { run, created: queued.created }
  }

  async runs(
    workspaceId: string,
    viewerId: string,
    id: string,
    page: ListRunsQuery,
  ): Promise<RoutineRunPage> {
    await this.visible(workspaceId, viewerId, id)
    const rows = await this.deps.routines.runs(workspaceId, viewerId, id, page)
    return {
      runs: rows.slice(0, page.limit),
      nextOffset: rows.length > page.limit ? page.offset + page.limit : null,
    }
  }

  /** A schedule in words with its next runs, or 422 saying what is wrong with it. */
  async preview(workspaceId: string, cron: string, timeZone: string | undefined): Promise<SchedulePreview> {
    const zone = timeZone ?? (await workspaceTimeZone(this.deps.settings, workspaceId))
    this.checkSchedule(cron, zone)
    const upcoming = upcomingRuns(cron, zone, new Date(this.deps.dispatcher.now()), ROUTINE_LIMITS.upcoming)
    return {
      cron,
      timeZone: zone,
      schedule: describeSchedule(cron),
      upcoming: upcoming.map((time) => time.toISOString()),
    }
  }

  /** Claims up to `limit` due routines (each slot once, across backends) and starts their runs. */
  async dispatch(limit: number): Promise<void> {
    const now = new Date(this.deps.dispatcher.now())
    const queued = await this.deps.routines.claimDue(now, limit, (routine) => this.plan(routine, now))
    for (const run of queued) this.launch(run)
  }

  private plan(routine: DueRoutine, now: Date): SlotPlan {
    const { slot, missed, next } = catchUp(routine.cron, routine.timeZone, routine.nextRunAt, now)
    return {
      slot,
      next,
      missed: missed ? { slots: missed, message: missedMessage(missed, routine.timeZone) } : null,
    }
  }

  private launch(run: QueuedRun): void {
    this.deps.dispatcher.launch(run.id, (signal) => this.execute(run, signal))
  }

  /** Works on a queued run as the routine's owner and records how it ended. */
  private async execute(run: QueuedRun, signal: AbortSignal): Promise<void> {
    const { routines } = this.deps
    if (!(await routines.markRunning(run.workspaceId, run.id))) return
    let outcome: RunOutcome
    try {
      const routine = await routines.definition(run.workspaceId, run.routineId)
      // Deleted meanwhile: its runs went with it.
      if (!routine) return
      outcome = await this.perform(run, routine, signal)
    } catch (error) {
      outcome = this.failure(error, signal)
    }
    await routines.finishRun(run.workspaceId, run.id, outcome)
  }

  private async perform(
    run: QueuedRun,
    routine: RoutineDefinition,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    const { workspaces } = this.deps
    const ownerId = routine.ownerId
    if (!ownerId || !(await workspaces.roleFor(run.workspaceId, ownerId))) return OWNER_GONE
    const target = routine.target
    if (target.kind === "saved_query") {
      if (!target.savedQueryId) return SAVED_QUERY_REMOVED
      const savedQueryId = target.savedQueryId
      try {
        const { execution } = await retryWhileBusy(
          () =>
            this.deps.savedQueryRuns.run(run.workspaceId, ownerId, savedQueryId, target.parameters, {
              signal,
              origin: "routine",
              timeZone: routine.timeZone,
            }),
          signal,
          this.deps.dispatcher.options,
        )
        return this.executionOutcome(execution, signal)
      } catch (error) {
        if (error instanceof AppError && error.status === 404) return SAVED_QUERY_HIDDEN
        throw error
      }
    }
    const agent = this.deps.agent
    if (!agent) {
      const error = AppError.agentNotConfigured()
      return failed(error.code, error.message)
    }
    const workspace = await workspaces.getById(run.workspaceId)
    if (!workspace) return failed("NOT_FOUND", "The workspace no longer exists.")
    const question = {
      routineId: routine.id,
      title: `Routine: ${routine.name}`.slice(0, ROUTINE_LIMITS.titleChars).trim(),
      question: target.question,
      connectionIds: target.connectionIds,
    }
    let started
    try {
      started = await retryWhileBusy(
        () => agent.startForRoutine(workspace, ownerId, question),
        signal,
        this.deps.dispatcher.options,
      )
    } catch (error) {
      // The conversation is busy with an earlier run of the routine (or the owner's follow-up).
      if (error instanceof AppError && error.code === "CONFLICT") return STILL_ANSWERING
      throw error
    }
    await this.deps.routines.linkAgentRun(run.workspaceId, run.id, started.run.id)
    const ended = await started.finished
    if (!ended) return { status: "cancelled", error: CONVERSATION_DELETED }
    switch (ended.status) {
      case "completed":
        return { status: "succeeded", error: null }
      case "cancelled":
        return { status: "cancelled", error: CANCELLED }
      case "interrupted":
        return { status: "interrupted", error: INTERRUPTED }
      default:
        return failed(
          ended.error?.code ?? "INTERNAL_ERROR",
          ended.error?.message ?? "The question could not be answered.",
        )
    }
  }

  /** A saved query run's outcome; one the shutdown stopped is interrupted, not failed. */
  private executionOutcome(execution: ExecutionRecord, signal: AbortSignal): RunOutcome {
    const executionId = execution.id
    if (execution.status === "succeeded") return { status: "succeeded", error: null, executionId }
    if (signal.reason === SHUTDOWN || execution.error?.code === "QUERY_INTERRUPTED") {
      return { status: "interrupted", error: INTERRUPTED, executionId }
    }
    const error = {
      code: execution.error?.code ?? "QUERY_FAILED",
      message: execution.error?.message ?? "The query did not finish.",
    }
    return { status: execution.status === "cancelled" ? "cancelled" : "failed", error, executionId }
  }

  private failure(error: unknown, signal: AbortSignal): RunOutcome {
    if (signal.reason === SHUTDOWN) return { status: "interrupted", error: INTERRUPTED }
    if (error instanceof AppError) {
      const details = error.details as { executionId?: unknown } | undefined
      const executionId = typeof details?.executionId === "string" ? details.executionId : undefined
      return { status: "failed", error: { code: error.code, message: error.message }, executionId }
    }
    console.error("A routine run failed unexpectedly", error)
    return failed(
      "INTERNAL_ERROR",
      "The routine run failed unexpectedly. Try again; if it keeps failing, check the backend logs.",
    )
  }

  private detail(routine: ViewedRoutine): RoutineDetail {
    const now = new Date(this.deps.dispatcher.now())
    const upcoming = routine.enabled
      ? upcomingRuns(routine.cron, routine.timeZone, now, ROUTINE_LIMITS.upcoming)
      : []
    return { ...routine, upcoming: upcoming.map((time) => time.toISOString()) }
  }

  private async visible(workspaceId: string, viewerId: string, id: string): Promise<ViewedRoutine> {
    const routine = await this.deps.routines.get(workspaceId, viewerId, id)
    if (!routine) throw AppError.notFound(NOT_FOUND)
    return routine
  }

  private async manageable(
    workspaceId: string,
    id: string,
    actor: Actor,
    action: string,
  ): Promise<ViewedRoutine> {
    const routine = await this.visible(workspaceId, actor.userId, id)
    if (!canManage(routine, actor)) {
      throw AppError.forbidden(`Only the routine's owner or a workspace owner or admin can ${action} it`)
    }
    return routine
  }

  private async storedDefinition(workspaceId: string, id: string): Promise<RoutineDefinition> {
    const stored = await this.deps.routines.definition(workspaceId, id)
    if (!stored) throw AppError.notFound(NOT_FOUND)
    return stored
  }

  private checkSchedule(cron: string, timeZone: string): void {
    const problem = scheduleProblem(cron, timeZone, this.deps.minIntervalMinutes)
    if (problem) throw AppError.validation(problem, { field: "cron" })
  }

  /** The schedule's next slot after now; 422 for a stored schedule that can no longer be read. */
  private nextRun(cron: string, timeZone: string): Date {
    let next: Date | null
    try {
      next = nextRunAfter(cron, timeZone, new Date(this.deps.dispatcher.now()))
    } catch {
      next = null
    }
    if (!next) {
      throw AppError.validation("Manifest cannot read this schedule or time zone. Edit the schedule first.", {
        field: "cron",
      })
    }
    return next
  }

  /**
   * A saved query the owner can open, with values its parameters accept (and
   * a value for each required one); or a question with sources from this
   * workspace, when a model provider is configured.
   */
  private async checkTarget(
    workspaceId: string,
    ownerId: string,
    target: RoutineTarget,
    timeZone: string,
  ): Promise<void> {
    if (target.kind === "saved_query") {
      const savedQuery = await this.deps.savedQueries.get(workspaceId, ownerId, target.savedQueryId)
      if (!savedQuery) {
        throw AppError.validation(
          "Choose a saved query from this workspace that the routine's owner can open.",
          { field: "savedQueryId" },
        )
      }
      resolveParameters(savedQuery.parameters, target.parameters, {
        timeZone,
        now: this.deps.dispatcher.now(),
        requireValues: true,
      })
      return
    }
    if (!this.deps.agent) throw AppError.agentNotConfigured()
    if (target.connectionIds.length === 0) return
    const known = new Set((await this.deps.connections.list(workspaceId)).map((source) => source.id))
    const unknown = target.connectionIds.filter((sourceId) => !known.has(sourceId))
    if (unknown.length > 0) {
      throw AppError.validation("Some of the chosen sources do not exist in this workspace.", {
        field: "connectionIds",
        connectionIds: unknown,
      })
    }
  }
}
