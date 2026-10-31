import { randomUUID } from "node:crypto"

import type { ConnectionsRepository } from "../connections/repository.js"
import type { QueryExecutionsRepository } from "../queries/repository.js"
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
  type Conversation,
  type ConversationPage,
  type ConversationWithRuns,
  type ListConversationsQuery,
  type RunError,
  type RunEvent,
  type RunEventData,
  type RunEventType,
  type StartRunInput,
} from "./contracts.js"
import { RunDeadline, type DeadlineReason } from "./deadline.js"
import type { RunEventBus } from "./event-bus.js"
import {
  answeredTurn,
  runHarness,
  RunFailure,
  storedTranscript,
  type HarnessProgress,
  type PendingQuestion,
} from "./harness.js"
import { buildInstructions } from "./instructions.js"
import { ModelProviderError, type ModelMessage, type ModelProvider } from "./provider.js"
import {
  INTERRUPTED,
  type AgentRunsRepository,
  type NewRun,
  type PriorTurn,
  type RunCheckpoint,
  type RunOutcome,
} from "./repository.js"
import type { AgentBusy, AgentRunner, AgentSlot, AgentStopReason } from "./runner.js"
import { formatSourceContext, loadSourceContext, type SourceContextDeps } from "./source-context.js"
import { runExecution, type AgentTool, type RunExecution } from "./tools.js"

const BUSY_RETRY_AFTER_SECONDS = 10
const STREAM_RETRY_AFTER_SECONDS = 5
/** Earlier questions of a conversation given to the model, and their characters in total. */
const PRIOR_TURNS = 6
const PRIOR_CHARS = 16_000
/** Files of a conversation the model is told about, the latest ones. */
const CONVERSATION_FILES = 30
const MUTATION_INDEX = "agent_runs_mutation_idx"
const RETRY_INDEX = "agent_runs_retry_idx"
const ROUTINE_CONVERSATION_INDEX = "conversations_routine_idx"

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
  executions: QueryExecutionsRepository
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

function mutationTaken(): AppError {
  return AppError.conflict("This mutationId was already used for another question. Send a new one.")
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

/** A routine's run asked a clarification, which no one is there to answer. */
function unanswerable(question: string): RunFailure {
  const asked = question.length > 200 ? `${question.slice(0, 199)}…` : question
  return new RunFailure(
    "AGENT_NO_CLARIFICATION",
    `This question was asked by a routine, so no one could answer the clarification it needed (“${asked}”). Make the routine's question specific enough to answer on its own.`,
  )
}

/** What a run that ends without going on (cancelled or timed out while waiting) used, from its checkpoint. */
function usedSoFar(run: AgentRun, checkpoint: RunCheckpoint | null) {
  return {
    answer: null,
    usage: checkpoint?.usage ?? run.usage,
    steps: checkpoint?.steps ?? run.steps,
    transcript: checkpoint ? storedTranscript(checkpoint.messages) : [],
  }
}

/**
 * Records a run's events in order and hands each to the streams following
 * the run once it is recorded. Events that change the run's state are
 * written together with the change (see AgentRunsRepository). A plain event
 * that cannot be recorded is logged and not streamed; the run goes on.
 */
class RunEvents {
  private pending: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly runs: AgentRunsRepository,
    private readonly bus: RunEventBus,
    private readonly workspaceId: string,
    private readonly runId: string,
  ) {}

  readonly emit = <T extends RunEventType>(type: T, data: RunEventData[T]): void => {
    this.record(() => this.runs.appendEvent(this.workspaceId, this.runId, { type, data })).catch(
      (error: unknown) => console.error(`Could not record a ${type} event of agent run ${this.runId}`, error),
    )
  }

  /** Records a state change with its event, after the events before it; resolves with whether it applied. */
  async change(write: () => Promise<RunEvent | null>): Promise<boolean> {
    return (await this.record(write)) !== null
  }

  private record(write: () => Promise<RunEvent | null>): Promise<RunEvent | null> {
    const recorded = this.pending.then(async () => {
      const event = await write()
      if (event) this.bus.publish(this.runId, event)
      return event
    })
    this.pending = recorded.catch(() => null)
    return recorded
  }
}

/** A run being worked on in this process. */
interface Job {
  workspace: Workspace
  run: AgentRun
  events: RunEvents
  deadline: RunDeadline
  /** Cancel, shutdown, or the deadline. */
  signal: AbortSignal
  /** Asked by a routine: a clarification fails the run, since no one can answer it. */
  unattended: boolean
}

/** What the model works with; it grows as the run goes. */
interface RunState {
  system: string
  files: AttachmentSummary[]
  messages: ModelMessage[]
  executions: Map<string, RunExecution>
  progress: HarnessProgress
}

type Result =
  | { status: "completed"; answer: AgentAnswer }
  | { status: "failed" | "interrupted"; error: RunError }
  | { status: "cancelled" }

/**
 * Answers questions in the background: each run gathers its sources'
 * context, drives the model through the harness, and records its events,
 * its answer or failure, usage, and transcript. A run waiting for the user
 * keeps a checkpoint, so it can still be answered after a restart.
 */
export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  /**
   * Records a queued run with its files and starts answering it; progress is
   * read from the run. A question sent again with the same mutation id
   * returns the run it started (created: false).
   */
  async start(
    workspace: Workspace,
    userId: string,
    input: StartRunInput,
  ): Promise<{ run: AgentRun; created: boolean }> {
    const { mutationId } = input
    const sent = mutationId ? await this.sentBefore(workspace.id, userId, mutationId, input) : null
    if (sent) return { run: sent, created: false }
    const attachments = decodeAttachments(input.attachments ?? [])
    const connectionIds = input.connectionIds ?? []
    await this.checkSources(workspace.id, connectionIds)
    if (
      input.conversationId &&
      !(await this.deps.runs.getConversation(workspace.id, userId, input.conversationId))
    ) {
      throw AppError.notFound("Conversation not found")
    }
    try {
      const { run } = await this.queue(workspace, {
        id: randomUUID(),
        conversationId: input.conversationId ?? randomUUID(),
        ...(input.conversationId
          ? {}
          : { newConversation: { title: input.question.slice(0, AGENT_LIMITS.titleChars).trim() } }),
        userId,
        question: input.question,
        connectionIds,
        attachments,
        ...(mutationId ? { mutationId } : {}),
      })
      return { run, created: true }
    } catch (error) {
      if (mutationId && isUniqueViolation(error, MUTATION_INDEX)) {
        // Sent twice at once (the other request won), or the id was used in another workspace.
        const winner = await this.sentBefore(workspace.id, userId, mutationId, input)
        if (winner) return { run: winner, created: false }
        throw mutationTaken()
      }
      throw isUniqueViolation(error) ? conversationBusy() : error
    }
  }

  /**
   * Asks a routine's question as its owner, in the routine's conversation
   * (started with `title` the first time). No one is there to answer, so a
   * clarification fails the run. Resolves once the run is queued, with
   * `finished`, which resolves with the run once its outcome is recorded.
   */
  async startForRoutine(
    workspace: Workspace,
    userId: string,
    input: { routineId: string; title: string; question: string; connectionIds: string[] },
  ): Promise<{ run: AgentRun; finished: Promise<AgentRun | null> }> {
    await this.checkSources(workspace.id, input.connectionIds)
    for (let attempt = 1; ; attempt += 1) {
      const existing = await this.deps.runs.routineConversation(workspace.id, userId, input.routineId)
      try {
        const { run, done } = await this.queue(
          workspace,
          {
            id: randomUUID(),
            conversationId: existing ?? randomUUID(),
            ...(existing ? {} : { newConversation: { title: input.title, routineId: input.routineId } }),
            userId,
            question: input.question,
            connectionIds: input.connectionIds,
          },
          { unattended: true },
        )
        return { run, finished: done.then(() => this.deps.runs.getRun(workspace.id, userId, run.id)) }
      } catch (error) {
        // Another run of the routine started its conversation first: ask in that one.
        if (attempt === 1 && isUniqueViolation(error, ROUTINE_CONVERSATION_INDEX)) continue
        throw isUniqueViolation(error) ? conversationBusy() : error
      }
    }
  }

  /**
   * Asks an interrupted question again as a new run in its conversation, with
   * the same sources and files. Each interrupted run is retried once; asking
   * again returns that retry (created: false).
   */
  async retry(
    workspace: Workspace,
    userId: string,
    runId: string,
  ): Promise<{ run: AgentRun; created: boolean }> {
    const { runs } = this.deps
    const interrupted = await runs.getRun(workspace.id, userId, runId)
    if (!interrupted) throw AppError.notFound("Run not found")
    const retried = await runs.findRetry(workspace.id, userId, runId)
    if (retried) return { run: retried, created: false }
    if (interrupted.status !== "interrupted") {
      throw AppError.conflict(
        "Only a question interrupted by a restart can be retried. Ask it again instead.",
        {
          status: interrupted.status,
        },
      )
    }
    if (interrupted.disposition !== "retry") {
      throw AppError.conflict(
        "This question started actions with effects before it was interrupted. Check what they changed before asking again.",
        { disposition: interrupted.disposition },
      )
    }
    try {
      const { run } = await this.queue(workspace, {
        id: randomUUID(),
        conversationId: interrupted.conversationId,
        userId,
        question: interrupted.question,
        connectionIds: interrupted.connectionIds,
        retryOf: interrupted.id,
      })
      return { run, created: true }
    } catch (error) {
      if (isUniqueViolation(error, RETRY_INDEX)) {
        const winner = await runs.findRetry(workspace.id, userId, runId)
        if (winner) return { run: winner, created: false }
      }
      throw isUniqueViolation(error) ? conversationBusy() : error
    }
  }

  async get(workspaceId: string, userId: string, runId: string, after = 0): Promise<AgentRunWithEvents> {
    const run = await this.deps.runs.getRun(workspaceId, userId, runId)
    if (!run) throw AppError.notFound("Run not found")
    return { ...run, events: await this.deps.runs.events(workspaceId, userId, runId, after) }
  }

  /** The user's conversations, newest activity first. */
  list(workspaceId: string, userId: string, query: ListConversationsQuery): Promise<ConversationPage> {
    return this.deps.runs.listConversations(workspaceId, userId, query)
  }

  /** The user's conversation with its latest runs (older than run `before`) and their events. */
  async conversation(
    workspaceId: string,
    userId: string,
    conversationId: string,
    before?: string,
  ): Promise<ConversationWithRuns> {
    const found = await this.deps.runs.conversation(workspaceId, userId, conversationId, {
      limit: AGENT_LIMITS.conversationRuns,
      before,
    })
    if (!found) throw AppError.notFound("Conversation not found")
    return { ...found.conversation, runs: found.runs, hasEarlier: found.hasEarlier }
  }

  async rename(
    workspaceId: string,
    userId: string,
    conversationId: string,
    title: string,
  ): Promise<Conversation> {
    const renamed = await this.deps.runs.renameConversation(workspaceId, userId, conversationId, title)
    if (!renamed) throw AppError.notFound("Conversation not found")
    return renamed
  }

  /** Deletes the user's conversation, stopping its active run first. */
  async remove(workspaceId: string, userId: string, conversationId: string): Promise<void> {
    const { runs } = this.deps
    if (!(await runs.getConversation(workspaceId, userId, conversationId))) {
      throw AppError.notFound("Conversation not found")
    }
    const active = await runs.activeRunId(workspaceId, userId, conversationId)
    if (active) {
      await this.cancel(workspaceId, userId, active).catch((error: unknown) => {
        // It finished meanwhile, or runs in another process: deleting it stops it from being shown.
        if (!(error instanceof AppError && error.status === 409)) throw error
      })
    }
    if (!(await runs.deleteConversation(workspaceId, userId, conversationId))) {
      throw AppError.notFound("Conversation not found")
    }
  }

  /**
   * Follows a run: its stored events after `after`, then live ones as they are
   * recorded, each once and in order, until the run's terminal event (or, for
   * a run that has ended, its stored events) or a shutdown, when `end` is called. Rejects
   * with 404, before sending anything, unless the run is the user's, and with
   * 429 when the user has too many streams open. Resolves with a function
   * that stops following.
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
    let release = () => {}
    const stop = () => {
      ended = true
      unsubscribe()
      release()
    }
    const end = () => {
      stop()
      handlers.end()
    }
    const opened = runner.openStream(userId, end)
    if (!opened) {
      throw AppError.tooManyStreams(
        "You are following too many questions at once. Close some Ask tabs, then try again.",
        STREAM_RETRY_AFTER_SECONDS,
      )
    }
    release = opened
    const deliver = (event: RunEvent) => {
      if (ended) return
      if (event.seq > last) {
        last = event.seq
        handlers.send(event)
      }
      // Nothing follows a terminal event, also one the client already has.
      if (TERMINAL_EVENT_TYPES.includes(event.type)) end()
    }
    // Listen first, so nothing recorded during the replay is missed; repeats are dropped by seq.
    unsubscribe = runner.events.subscribe(runId, (event) => (live ? deliver(event) : early.push(event)))
    try {
      for (const event of await runs.events(workspaceId, userId, runId, after)) deliver(event)
      live = true
      for (const event of early.sort((a, b) => a.seq - b.seq)) deliver(event)
      const run = await runs.getRun(workspaceId, userId, runId)
      if (!ended && (!run || !ACTIVE_RUN_STATUSES.includes(run.status))) {
        // It ended after the replay was read, and its terminal event (recorded
        // with the final status) may not have been handed over yet: read it.
        for (const event of await runs.events(workspaceId, userId, runId, last)) deliver(event)
        if (!ended) end()
      }
      // Shutting down: the client reconnects to the next process.
      if (!ended && runner.stopping) end()
    } catch (error) {
      stop()
      throw error
    }
    return stop
  }

  /**
   * Gives a run waiting for the user its answer, and resolves once the run
   * has it. A run that waits from before a restart goes on from its checkpoint.
   */
  async answer(
    workspace: Workspace,
    userId: string,
    runId: string,
    reply: string,
  ): Promise<AgentRunWithEvents> {
    const run = await this.deps.runs.getRun(workspace.id, userId, runId)
    if (!run) throw AppError.notFound("Run not found")
    const clarification = run.clarification
    if (run.status !== "awaiting_input" || !clarification) {
      throw AppError.conflict("This question is not waiting for an answer.", { status: run.status })
    }
    if (!clarification.allowFreeText && !clarification.options.includes(reply)) {
      throw AppError.validation("Choose one of the offered answers.", { options: clarification.options })
    }
    if (!(await this.deps.runner.answer(runId, reply)))
      await this.resume(workspace, run, clarification, reply)
    return this.get(workspace.id, userId, runId)
  }

  /**
   * Stops the model and any running query, and resolves once the cancellation
   * is recorded. A run that waits from before a restart has nothing running,
   * so its cancellation is only recorded.
   */
  async cancel(workspaceId: string, userId: string, runId: string): Promise<AgentRunWithEvents> {
    const { runs, runner } = this.deps
    const run = await this.get(workspaceId, userId, runId)
    if (await runner.cancel(runId)) return this.get(workspaceId, userId, runId)
    if (run.status === "awaiting_input") {
      const checkpoint = await runs.checkpoint(workspaceId, runId)
      const outcome: RunOutcome = { ...usedSoFar(run, checkpoint), status: "cancelled", error: null }
      const stopWaiting = () => runs.finish(workspaceId, runId, outcome, true)
      if (await this.eventsOf(workspaceId, runId).change(stopWaiting)) {
        return this.get(workspaceId, userId, runId)
      }
      // Answered meanwhile: it goes on in this process now.
      if (await runner.cancel(runId)) return this.get(workspaceId, userId, runId)
    }
    throw AppError.conflict(
      ACTIVE_RUN_STATUSES.includes(run.status)
        ? "This question is not being answered in this backend process, so it cannot be cancelled here."
        : "This question has already finished.",
      { status: run.status },
    )
  }

  /**
   * Records a queued run within the admission limits and starts answering it;
   * `done` resolves once its outcome is recorded.
   */
  private async queue(
    workspace: Workspace,
    input: Omit<NewRun, "workspaceId" | "provider" | "model">,
    options: { unattended?: boolean } = {},
  ): Promise<{ run: AgentRun; done: Promise<void> }> {
    const { runs, provider } = this.deps
    const slot = this.claim(workspace.id, input.userId, input.id, input.conversationId)
    let run: AgentRun | null
    try {
      run = await runs.insertRun({
        ...input,
        workspaceId: workspace.id,
        provider: provider.provider,
        model: provider.model,
      })
    } catch (error) {
      slot.release()
      throw error
    }
    if (!run) {
      slot.release()
      throw AppError.notFound("Conversation not found")
    }
    const queued = run
    const done = slot.start((signal) => this.execute(workspace, queued, signal, options.unattended ?? false))
    return { run: queued, done }
  }

  /** 422 unless every chosen source exists in the workspace. */
  private async checkSources(workspaceId: string, connectionIds: string[]): Promise<void> {
    if (connectionIds.length === 0) return
    const known = new Set((await this.deps.connections.list(workspaceId)).map((source) => source.id))
    const unknown = connectionIds.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      throw AppError.validation("Some of the chosen sources do not exist in this workspace.", {
        connectionIds: unknown,
      })
    }
  }

  private claim(workspaceId: string, userId: string, runId: string, conversationId: string): AgentSlot {
    const slot = this.deps.runner.claim({ runId, workspaceId, userId, conversationId })
    if (!("busy" in slot)) return slot
    if (slot.busy === "conversation") throw conversationBusy()
    throw AppError.agentBusy(BUSY_MESSAGES[slot.busy], BUSY_RETRY_AFTER_SECONDS)
  }

  /** The run started with this mutation id; 409 when the id was used for another question. */
  private async sentBefore(
    workspaceId: string,
    userId: string,
    mutationId: string,
    input: StartRunInput,
  ): Promise<AgentRun | null> {
    const run = await this.deps.runs.findByMutation(workspaceId, userId, mutationId)
    const other =
      run !== null &&
      (run.question !== input.question ||
        (input.conversationId !== undefined && input.conversationId !== run.conversationId))
    if (other) throw mutationTaken()
    return run
  }

  private eventsOf(workspaceId: string, runId: string): RunEvents {
    return new RunEvents(this.deps.runs, this.deps.runner.events, workspaceId, runId)
  }

  private job(
    workspace: Workspace,
    run: AgentRun,
    events: RunEvents,
    runMs: number,
    stop: AbortSignal,
    unattended = false,
  ): Job {
    const deadline = new RunDeadline(runMs, this.deps.limits.answerTimeoutMs)
    return { workspace, run, events, deadline, signal: AbortSignal.any([stop, deadline.signal]), unattended }
  }

  private execute(
    workspace: Workspace,
    run: AgentRun,
    stop: AbortSignal,
    unattended: boolean,
  ): Promise<void> {
    const { runs, settings } = this.deps
    const job = this.job(
      workspace,
      run,
      this.eventsOf(workspace.id, run.id),
      this.deps.limits.runTimeoutMs,
      stop,
      unattended,
    )
    return this.drive(job, async () => {
      const started = { provider: run.provider, model: run.model }
      if (!(await job.events.change(() => runs.markRunning(workspace.id, run.id, started)))) return null
      const scope = run.connectionIds.length > 0 ? run.connectionIds : null
      const [context, description, prior, files] = await Promise.all([
        loadSourceContext(this.deps, workspace.id, scope),
        settings.get(workspace.id, "description"),
        runs.priorTurns(workspace.id, run.userId, run.conversationId, run.id, PRIOR_TURNS),
        runs.conversationAttachments(workspace.id, run.userId, run.conversationId, CONVERSATION_FILES),
      ])
      return {
        system: buildInstructions({
          workspace: {
            name: workspace.name,
            description: typeof description?.value === "string" ? description.value : null,
          },
          sources: formatSourceContext(context),
          today: new Date().toISOString().slice(0, 10),
          unattended,
        }),
        files,
        messages: [...priorMessages(prior), { role: "user", text: questionMessage(run, files) }],
        executions: new Map(),
        progress: { steps: 0, usage: { inputTokens: 0, outputTokens: 0 } },
      }
    })
  }

  /**
   * Goes on with a run that waits for the user but not in this process (it
   * asked before a restart), from its stored checkpoint, with the answer.
   */
  private async resume(workspace: Workspace, run: AgentRun, clarification: Clarification, reply: string) {
    const { runs, limits } = this.deps
    const events = this.eventsOf(workspace.id, run.id)
    const checkpoint = await runs.checkpoint(workspace.id, run.id)
    if (Date.parse(clarification.expiresAt) <= Date.now()) {
      const error = inputTimeout(limits.answerTimeoutMs)
      const outcome: RunOutcome = { ...usedSoFar(run, checkpoint), status: "failed", error }
      await events.change(() => runs.finish(workspace.id, run.id, outcome, true))
      throw AppError.conflict(error.message, { status: "failed" })
    }
    if (!checkpoint) {
      throw AppError.conflict(
        "This question is not being answered in this backend process, so it cannot take an answer here.",
        { status: run.status },
      )
    }
    const slot = this.claim(workspace.id, run.userId, run.id, run.conversationId)
    try {
      const answered = { id: clarification.id, answer: reply }
      if (!(await events.change(() => runs.markResumed(workspace.id, run.id, answered)))) {
        throw AppError.conflict("This question is no longer waiting for an answer.")
      }
    } catch (error) {
      slot.release()
      throw error
    }
    slot.start((signal) =>
      this.drive(this.job(workspace, run, events, checkpoint.runMsLeft, signal), async () => {
        const [files, records] = await Promise.all([
          runs.conversationAttachments(workspace.id, run.userId, run.conversationId, CONVERSATION_FILES),
          this.deps.executions.succeeded(workspace.id, checkpoint.executionIds),
        ])
        return {
          system: checkpoint.system,
          files,
          messages: [...checkpoint.messages, answeredTurn(checkpoint.question, reply, events.emit)],
          executions: new Map(
            records.flatMap((record) =>
              record.result ? [[record.id, runExecution({ ...record, result: record.result })] as const] : [],
            ),
          ),
          progress: { steps: checkpoint.steps, usage: checkpoint.usage },
        }
      }),
    )
  }

  /**
   * Drives the model through the harness until it answers, waiting for the
   * user whenever it asks, and records how the run ended. A shutdown leaves a
   * waiting run waiting: it goes on from its checkpoint after the restart.
   */
  private async drive(job: Job, prepare: () => Promise<RunState | null>): Promise<void> {
    const { workspace, run, events, deadline, signal } = job
    let state: RunState | null = null
    let waiting = false
    let result: Result
    try {
      state = await prepare()
      if (!state) return
      for (;;) {
        const outcome = await runHarness(
          {
            provider: this.deps.provider,
            system: state.system,
            messages: state.messages,
            tools: this.deps.tools,
            context: {
              workspaceId: workspace.id,
              userId: run.userId,
              scope: run.connectionIds.length > 0 ? run.connectionIds : null,
              signal,
              executions: state.executions,
              attachments: state.files,
            },
            maxSteps: this.deps.limits.maxSteps,
            signal,
            emit: events.emit,
          },
          state.progress,
        )
        if ("answer" in outcome) {
          result = { status: "completed", answer: outcome.answer }
          break
        }
        if (job.unattended) throw unanswerable(outcome.question.request.question)
        waiting = true
        const answer = await this.waitForAnswer(job, state, outcome.question)
        waiting = false
        state.messages.push(answeredTurn(outcome.question, answer, events.emit))
      }
    } catch (error) {
      if (waiting && signal.reason === "shutdown") return
      result = this.failure(run, error, signal)
    } finally {
      deadline.clear()
    }
    const outcome: RunOutcome = {
      status: result.status,
      answer: result.status === "completed" ? result.answer : null,
      error: "error" in result ? result.error : null,
      usage: state?.progress.usage ?? { inputTokens: 0, outputTokens: 0 },
      steps: state?.progress.steps ?? 0,
      transcript: storedTranscript(state?.messages ?? []),
    }
    await events
      .change(() => this.deps.runs.finish(workspace.id, run.id, outcome))
      .catch((error: unknown) => {
        console.error(`Could not record the outcome of agent run ${run.id}`, error)
      })
  }

  /**
   * Records that the run waits for the user's answer, with a checkpoint to go
   * on from after a restart, and pauses its clock. Resolves with the answer
   * once it is recorded; rejects with the abort reason if the run stops first.
   */
  private async waitForAnswer(job: Job, state: RunState, question: PendingQuestion): Promise<string> {
    const { workspace, run, events, deadline, signal } = job
    const { runs, runner, limits } = this.deps
    const clarification: Clarification = {
      id: randomUUID(),
      ...question.request,
      expiresAt: new Date(Date.now() + limits.answerTimeoutMs).toISOString(),
    }
    const checkpoint: RunCheckpoint = {
      system: state.system,
      messages: state.messages,
      question,
      steps: state.progress.steps,
      usage: state.progress.usage,
      executionIds: [...state.executions.keys()],
      runMsLeft: deadline.pause(),
    }
    // Listen before the question is recorded, so an answer sent right after it is taken.
    const abandon = new AbortController()
    const answered = runner.waitForAnswer(
      run.id,
      AbortSignal.any([signal, abandon.signal]),
      async (answer) => {
        deadline.resume()
        await events
          .change(() => runs.markResumed(workspace.id, run.id, { id: clarification.id, answer }))
          .catch((error: unknown) =>
            console.error(`Could not record the answer to agent run ${run.id}`, error),
          )
      },
    )
    try {
      if (!(await events.change(() => runs.markAwaiting(workspace.id, run.id, clarification, checkpoint)))) {
        throw new Error(`Agent run ${run.id} stopped running before it could ask its question`)
      }
    } catch (error) {
      abandon.abort()
      await answered.catch(() => {})
      throw error
    }
    return answered
  }

  /** How a run ended, from which signal stopped it or what failed. */
  private failure(
    run: AgentRun,
    error: unknown,
    signal: AbortSignal,
  ): Exclude<Result, { status: "completed" }> {
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
        return { status: "failed", error: inputTimeout(this.deps.limits.answerTimeoutMs) }
      }
      if (reason === "shutdown") return { status: "interrupted", error: INTERRUPTED }
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

function inputTimeout(answerTimeoutMs: number): RunError {
  return {
    code: "AGENT_INPUT_TIMEOUT",
    message: `No reply to the clarification arrived within ${duration(answerTimeoutMs)}, so the question was stopped. Ask it again.`,
  }
}
