import { randomUUID } from "node:crypto"

import type { ConnectionsRepository } from "../connections/repository.js"
import { AppError } from "../shared/http/errors.js"
import { isUniqueViolation } from "../shared/postgres/errors.js"
import type { Workspace, WorkspaceSettingsRepository } from "../workspaces/repository.js"
import {
  ACTIVE_RUN_STATUSES,
  AGENT_LIMITS,
  type AgentAnswer,
  type AgentRun,
  type AgentRunWithEvents,
  type RunError,
  type RunEventData,
  type RunEventType,
  type StartRunInput,
} from "./contracts.js"
import { runHarness, RunFailure, storedTranscript, type HarnessProgress } from "./harness.js"
import { buildInstructions } from "./instructions.js"
import { ModelProviderError, type ModelMessage, type ModelProvider } from "./provider.js"
import type { AgentRunsRepository, PriorTurn, RunOutcome } from "./repository.js"
import type { AgentBusy, AgentRunner, AgentStopReason } from "./runner.js"
import { formatSourceContext, loadSourceContext, type SourceContextDeps } from "./source-context.js"
import type { AgentTool } from "./tools.js"

const BUSY_RETRY_AFTER_SECONDS = 10
/** Earlier questions of a conversation given to the model, and their characters in total. */
const PRIOR_TURNS = 6
const PRIOR_CHARS = 16_000

export interface AgentLimits {
  maxSteps: number
  runTimeoutMs: number
}

export interface AgentServiceDeps extends SourceContextDeps {
  runs: AgentRunsRepository
  connections: ConnectionsRepository
  settings: WorkspaceSettingsRepository
  tools: AgentTool[]
  provider: ModelProvider
  runner: AgentRunner
  limits: AgentLimits
}

const BUSY_MESSAGES: Record<Exclude<AgentBusy, "conversation">, string> = {
  user: "You already have two questions being answered. Wait for one to finish, or cancel it.",
  workspace: "This workspace is answering as many questions as it can at once. Try again shortly.",
  process: "Manifest is answering as many questions as it can at once. Try again shortly.",
}

function conversationBusy(): AppError {
  return AppError.conflict(
    "This conversation is still answering a question. Wait for it to finish, or cancel it.",
  )
}

function duration(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0
    ? `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`
    : `${Math.round(ms / 1000)} seconds`
}

function priorAnswer(turn: PriorTurn): string {
  if (turn.status === "completed" && turn.answer) return turn.answer
  if (turn.status === "cancelled") return "(No answer was given: the question was cancelled.)"
  return `(No answer was given. ${turn.error ?? "The question could not be answered."})`
}

/** Earlier questions and how they ended, oldest first, within the character budget. */
function priorMessages(turns: PriorTurn[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  let used = 0
  for (const turn of turns) {
    const answer = priorAnswer(turn)
    used += turn.question.length + answer.length
    if (used > PRIOR_CHARS) break
    messages.unshift(
      { role: "user", text: turn.question },
      { role: "assistant", text: answer, toolCalls: [] },
    )
  }
  return messages
}

/** Records a run's events in order, numbered from 1; a failed write is logged, not fatal. */
class RunEvents {
  private seq = 0
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly runs: AgentRunsRepository,
    private readonly workspaceId: string,
    private readonly runId: string,
  ) {}

  readonly emit = <T extends RunEventType>(type: T, data: RunEventData[T]): void => {
    const event = { seq: (this.seq += 1), type, data }
    this.pending = this.pending
      .then(() => this.runs.appendEvent(this.workspaceId, this.runId, event))
      .catch((error: unknown) => {
        console.error(`Could not record event ${event.seq} of agent run ${this.runId}`, error)
      })
  }

  flush(): Promise<void> {
    return this.pending
  }
}

/**
 * Answers questions in the background: each run gathers its sources'
 * context, drives the model through the harness, and records its events,
 * its answer or failure, usage, and transcript.
 */
export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  /** Records a queued run and starts answering it; progress is read from the run. */
  async start(workspace: Workspace, userId: string, input: StartRunInput): Promise<AgentRun> {
    const { runs, runner, provider } = this.deps
    const connectionIds = input.connectionIds ?? []
    if (connectionIds.length > 0) {
      const known = new Set((await this.deps.connections.list(workspace.id)).map((source) => source.id))
      const unknown = connectionIds.filter((id) => !known.has(id))
      if (unknown.length > 0) {
        throw AppError.validation("Some of the chosen sources do not exist in this workspace.", {
          connectionIds: unknown,
        })
      }
    }
    if (input.conversationId && !(await runs.getConversation(workspace.id, userId, input.conversationId))) {
      throw AppError.notFound("Conversation not found")
    }

    const runId = randomUUID()
    const conversationId = input.conversationId ?? randomUUID()
    const slot = runner.claim({ runId, workspaceId: workspace.id, userId, conversationId })
    if ("busy" in slot) {
      if (slot.busy === "conversation") throw conversationBusy()
      throw AppError.agentBusy(BUSY_MESSAGES[slot.busy], BUSY_RETRY_AFTER_SECONDS)
    }
    let run: AgentRun | null
    try {
      if (!input.conversationId) {
        await runs.createConversation({
          id: conversationId,
          workspaceId: workspace.id,
          userId,
          title: input.question.slice(0, AGENT_LIMITS.titleChars).trim(),
        })
      }
      run = await runs.insertRun({
        id: runId,
        workspaceId: workspace.id,
        conversationId,
        userId,
        question: input.question,
        connectionIds,
        provider: provider.provider,
        model: provider.model,
      })
    } catch (error) {
      slot.release()
      throw isUniqueViolation(error) ? conversationBusy() : error
    }
    if (!run) {
      slot.release()
      throw AppError.notFound("Conversation not found")
    }
    const queued = run
    slot.start((signal) => this.execute(workspace, queued, signal))
    return queued
  }

  async get(workspaceId: string, userId: string, runId: string, after = 0): Promise<AgentRunWithEvents> {
    const run = await this.deps.runs.getRun(workspaceId, userId, runId)
    if (!run) throw AppError.notFound("Run not found")
    return { ...run, events: await this.deps.runs.events(workspaceId, userId, runId, after) }
  }

  /** Stops the model and any running query, and resolves once the cancellation is recorded. */
  async cancel(workspaceId: string, userId: string, runId: string): Promise<AgentRunWithEvents> {
    const run = await this.get(workspaceId, userId, runId)
    if (await this.deps.runner.cancel(runId)) return this.get(workspaceId, userId, runId)
    throw AppError.conflict(
      ACTIVE_RUN_STATUSES.includes(run.status)
        ? "This question is not being answered in this backend process, so it cannot be cancelled here."
        : "This question has already finished.",
      { status: run.status },
    )
  }

  private async execute(workspace: Workspace, run: AgentRun, stop: AbortSignal): Promise<void> {
    const { runs, limits } = this.deps
    const deadline = AbortSignal.timeout(limits.runTimeoutMs)
    const signal = AbortSignal.any([stop, deadline])
    const events = new RunEvents(runs, workspace.id, run.id)
    const messages: ModelMessage[] = []
    const progress: HarnessProgress = { steps: 0, usage: { inputTokens: 0, outputTokens: 0 } }
    let result:
      | { status: "completed"; answer: AgentAnswer }
      | { status: "failed"; error: RunError }
      | { status: "cancelled" }
    try {
      if (!(await runs.markRunning(workspace.id, run.id))) return
      events.emit("run.started", { provider: run.provider, model: run.model })
      const scope = run.connectionIds.length > 0 ? run.connectionIds : null
      const [context, description, prior] = await Promise.all([
        loadSourceContext(this.deps, workspace.id, scope),
        this.deps.settings.get(workspace.id, "description"),
        runs.priorTurns(workspace.id, run.userId, run.conversationId, run.id, PRIOR_TURNS),
      ])
      const system = buildInstructions({
        workspace: {
          name: workspace.name,
          description: typeof description?.value === "string" ? description.value : null,
        },
        sources: formatSourceContext(context),
        today: new Date().toISOString().slice(0, 10),
      })
      messages.push(...priorMessages(prior), { role: "user", text: run.question })
      const answer = await runHarness(
        {
          provider: this.deps.provider,
          system,
          messages,
          tools: this.deps.tools,
          context: { workspaceId: workspace.id, userId: run.userId, scope, signal, executions: new Map() },
          maxSteps: limits.maxSteps,
          signal,
          emit: events.emit,
        },
        progress,
      )
      result = { status: "completed", answer }
    } catch (error) {
      result = this.failure(run, error, { signal, stop, deadline })
    }

    if (result.status === "completed") events.emit("answer.completed", { answer: result.answer })
    else if (result.status === "cancelled") events.emit("run.cancelled", {})
    else events.emit("run.failed", result.error)
    await events.flush()
    const outcome: RunOutcome = {
      status: result.status,
      answer: result.status === "completed" ? result.answer : null,
      error: result.status === "failed" ? result.error : null,
      usage: progress.usage,
      steps: progress.steps,
      transcript: storedTranscript(messages),
    }
    await runs.finish(workspace.id, run.id, outcome).catch((error: unknown) => {
      console.error(`Could not record the outcome of agent run ${run.id}`, error)
    })
  }

  /** How a run ended, from which signal stopped it or what failed. */
  private failure(
    run: AgentRun,
    error: unknown,
    signals: { signal: AbortSignal; stop: AbortSignal; deadline: AbortSignal },
  ): { status: "failed"; error: RunError } | { status: "cancelled" } {
    const { signal, stop, deadline } = signals
    const failed = (code: string, message: string) => ({
      status: "failed" as const,
      error: { code, message },
    })
    if (signal.aborted) {
      if (signal.reason === deadline.reason) {
        return failed(
          "AGENT_TIMEOUT",
          `The question took longer than ${duration(this.deps.limits.runTimeoutMs)} to answer and was stopped.`,
        )
      }
      if ((stop.reason as AgentStopReason) === "shutdown") {
        return failed(
          "AGENT_INTERRUPTED",
          "The backend stopped while this question was being answered. Ask it again.",
        )
      }
      return { status: "cancelled" }
    }
    if (error instanceof RunFailure) return failed(error.code, error.message)
    if (error instanceof ModelProviderError) return failed("AGENT_PROVIDER_ERROR", error.message)
    console.error(`Agent run ${run.id} failed unexpectedly`, error)
    return failed(
      "INTERNAL_ERROR",
      "The question could not be answered because of an unexpected error. Try again; if it keeps failing, check the backend logs.",
    )
  }
}
