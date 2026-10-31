import { randomUUID } from "node:crypto"

import type { ConnectionsRepository } from "../connections/repository.js"
import { AppError } from "../shared/http/errors.js"
import { isUniqueViolation } from "../shared/postgres/errors.js"
import type { Workspace, WorkspaceSettingsRepository } from "../workspaces/repository.js"
import { decodeAttachments } from "./attachments.js"
import {
  ACTIVE_RUN_STATUSES,
  AGENT_LIMITS,
  TERMINAL_EVENT_TYPES,
  type AgentAnswer,
  type AgentRun,
  type AgentRunWithEvents,
  type AttachmentSummary,
  type Clarification,
  type ConversationWithRuns,
  type RunError,
  type RunEvent,
  type RunEventData,
  type RunEventType,
  type StartRunInput,
} from "./contracts.js"
import { RunDeadline, type DeadlineReason } from "./deadline.js"
import type { RunEventBus } from "./event-bus.js"
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
/** Runs a conversation read returns, the latest ones. */
const CONVERSATION_RUNS = 50
/** Files of a conversation the model is told about, the latest ones. */
const CONVERSATION_FILES = 30

export interface AgentLimits {
  maxSteps: number
  runTimeoutMs: number
  /** How long a run waits for the user's answer to a clarification. */
  answerTimeoutMs: number
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
  user: "You already have two questions being answered or waiting for your reply. Wait for one to finish, or cancel it.",
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

const bytes = (size: number) => `${size.toLocaleString("en-US")} byte${size === 1 ? "" : "s"}`

/** The run's question for the model, with the files of the conversation it may read. */
function questionMessage(run: AgentRun, files: AttachmentSummary[]): string {
  if (files.length === 0) return run.question
  const attachedNow = new Set(run.attachments.map((file) => file.id))
  return [
    run.question,
    "",
    "Files attached in this conversation (read them with read_attachment):",
    ...files.map(
      (file) =>
        `- ${file.name} (id: ${file.id}; ${file.mediaType}; ${bytes(file.sizeBytes)})${
          attachedNow.has(file.id) ? " — attached with this question" : ""
        }`,
    ),
  ].join("\n")
}

/**
 * Records a run's events in order, numbered from 1, and hands each to the
 * streams following the run once recorded. A failed write is logged, not
 * fatal, and the event is still streamed.
 */
class RunEvents {
  private seq = 0
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly runs: AgentRunsRepository,
    private readonly bus: RunEventBus,
    private readonly workspaceId: string,
    private readonly runId: string,
  ) {}

  readonly emit = <T extends RunEventType>(type: T, data: RunEventData[T]): void => {
    const event = { seq: (this.seq += 1), type, data }
    this.pending = this.pending
      .then(() => this.runs.appendEvent(this.workspaceId, this.runId, event))
      .catch((error: unknown) => {
        console.error(`Could not record event ${event.seq} of agent run ${this.runId}`, error)
        return new Date().toISOString()
      })
      .then((createdAt) => this.bus.publish(this.runId, { ...event, createdAt } as RunEvent))
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

  /** Records a queued run with its files and starts answering it; progress is read from the run. */
  async start(workspace: Workspace, userId: string, input: StartRunInput): Promise<AgentRun> {
    const { runs, runner, provider } = this.deps
    const attachments = decodeAttachments(input.attachments ?? [])
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
        attachments,
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

  /** The user's conversation with its latest runs and their events. */
  async conversation(
    workspaceId: string,
    userId: string,
    conversationId: string,
  ): Promise<ConversationWithRuns> {
    const found = await this.deps.runs.conversation(workspaceId, userId, conversationId, CONVERSATION_RUNS)
    if (!found) throw AppError.notFound("Conversation not found")
    return { ...found.conversation, runs: found.runs }
  }

  /**
   * Follows a run: its stored events after `after`, then live ones as they are
   * recorded, each once and in order, until the run's terminal event (or, for
   * a run that has ended, its stored events), when `end` is called. Rejects
   * with 404, before sending anything, unless the run is the user's. Resolves
   * with a function that stops following.
   */
  async follow(
    workspaceId: string,
    userId: string,
    runId: string,
    after: number,
    handlers: { send(event: RunEvent): void; end(): void },
  ): Promise<() => void> {
    const { runs, runner } = this.deps
    if (!(await runs.getRun(workspaceId, userId, runId))) throw AppError.notFound("Run not found")
    let last = after
    let live = false
    let ended = false
    const early: RunEvent[] = []
    let unsubscribe = () => {}
    const stop = () => {
      ended = true
      unsubscribe()
    }
    const deliver = (event: RunEvent) => {
      if (ended || event.seq <= last) return
      last = event.seq
      handlers.send(event)
      if (TERMINAL_EVENT_TYPES.includes(event.type)) {
        stop()
        handlers.end()
      }
    }
    // Listen first, so nothing recorded during the replay is missed; repeats are dropped by seq.
    unsubscribe = runner.events.subscribe(runId, (event) => (live ? deliver(event) : early.push(event)))
    try {
      for (const event of await runs.events(workspaceId, userId, runId, after)) deliver(event)
      live = true
      for (const event of early.sort((a, b) => a.seq - b.seq)) deliver(event)
      const run = await runs.getRun(workspaceId, userId, runId)
      if (!ended && (!run || !ACTIVE_RUN_STATUSES.includes(run.status))) {
        stop()
        handlers.end()
      }
    } catch (error) {
      stop()
      throw error
    }
    return stop
  }

  /** Gives a run waiting for the user its answer, and resolves once the run has it. */
  async answer(
    workspaceId: string,
    userId: string,
    runId: string,
    reply: string,
  ): Promise<AgentRunWithEvents> {
    const run = await this.deps.runs.getRun(workspaceId, userId, runId)
    if (!run) throw AppError.notFound("Run not found")
    const clarification = run.clarification
    if (run.status !== "awaiting_input" || !clarification) {
      throw AppError.conflict("This question is not waiting for an answer.", { status: run.status })
    }
    if (!clarification.allowFreeText && !clarification.options.includes(reply)) {
      throw AppError.validation("Choose one of the offered answers.", { options: clarification.options })
    }
    if (!(await this.deps.runner.answer(runId, reply))) {
      throw AppError.conflict(
        "This question is not being answered in this backend process, so it cannot take an answer here.",
        { status: run.status },
      )
    }
    return this.get(workspaceId, userId, runId)
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
    const { runs, runner, limits } = this.deps
    const deadline = new RunDeadline(limits.runTimeoutMs, limits.answerTimeoutMs)
    const signal = AbortSignal.any([stop, deadline.signal])
    const events = new RunEvents(runs, runner.events, workspace.id, run.id)
    const messages: ModelMessage[] = []
    const progress: HarnessProgress = { steps: 0, usage: { inputTokens: 0, outputTokens: 0 } }

    /** Pauses the run (and its clock) until the user answers the clarification. */
    const askUser = async (request: Omit<Clarification, "id">): Promise<string> => {
      const clarification: Clarification = { id: randomUUID(), ...request }
      await runs.markAwaiting(workspace.id, run.id, clarification)
      const answered = runner.waitForAnswer(run.id, signal, async (answer) => {
        deadline.resume()
        await runs.markResumed(workspace.id, run.id).catch((error: unknown) => {
          console.error(`Could not record that agent run ${run.id} goes on`, error)
        })
        events.emit("clarification.answered", { id: clarification.id, answer })
        await events.flush()
      })
      deadline.pause()
      events.emit("clarification.requested", clarification)
      return answered
    }

    let result:
      | { status: "completed"; answer: AgentAnswer }
      | { status: "failed"; error: RunError }
      | { status: "cancelled" }
    try {
      if (!(await runs.markRunning(workspace.id, run.id))) return
      events.emit("run.started", { provider: run.provider, model: run.model })
      const scope = run.connectionIds.length > 0 ? run.connectionIds : null
      const [context, description, prior, files] = await Promise.all([
        loadSourceContext(this.deps, workspace.id, scope),
        this.deps.settings.get(workspace.id, "description"),
        runs.priorTurns(workspace.id, run.userId, run.conversationId, run.id, PRIOR_TURNS),
        runs.conversationAttachments(workspace.id, run.userId, run.conversationId, CONVERSATION_FILES),
      ])
      const system = buildInstructions({
        workspace: {
          name: workspace.name,
          description: typeof description?.value === "string" ? description.value : null,
        },
        sources: formatSourceContext(context),
        today: new Date().toISOString().slice(0, 10),
      })
      messages.push(...priorMessages(prior), { role: "user", text: questionMessage(run, files) })
      const answer = await runHarness(
        {
          provider: this.deps.provider,
          system,
          messages,
          tools: this.deps.tools,
          context: {
            workspaceId: workspace.id,
            userId: run.userId,
            scope,
            signal,
            executions: new Map(),
            attachments: files,
            askUser,
          },
          maxSteps: limits.maxSteps,
          signal,
          emit: events.emit,
        },
        progress,
      )
      result = { status: "completed", answer }
    } catch (error) {
      result = this.failure(run, error, signal)
    } finally {
      deadline.clear()
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
    signal: AbortSignal,
  ): { status: "failed"; error: RunError } | { status: "cancelled" } {
    const failed = (code: string, message: string) => ({
      status: "failed" as const,
      error: { code, message },
    })
    if (signal.aborted) {
      const reason = signal.reason as AgentStopReason | DeadlineReason
      if (reason === "timeout") {
        return failed(
          "AGENT_TIMEOUT",
          `The question took longer than ${duration(this.deps.limits.runTimeoutMs)} to answer and was stopped.`,
        )
      }
      if (reason === "answer_timeout") {
        return failed(
          "AGENT_INPUT_TIMEOUT",
          `No reply to the clarification arrived within ${duration(this.deps.limits.answerTimeoutMs)}, so the question was stopped. Ask it again.`,
        )
      }
      if (reason === "shutdown") {
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
