// Builds what the ask screen shows from a run and its ordered events. Events
// are applied once each, in sequence order, so replays and duplicate
// deliveries after a reconnect change nothing. A finished run shows its
// answer (or how it ended) without the text streamed while working, exactly
// as the server returns it when the conversation is read again.

import {
  ACTIVE_RUN_STATUSES,
  type AgentAnswer,
  type AgentRun,
  type AgentRunWithEvents,
  type Clarification,
  type ConversationWithRuns,
  type RecoveryDisposition,
  type RunError,
  type RunEvent,
  type RunStatus,
} from "./types.ts"

export interface ToolStep {
  kind: "tool"
  callId: string
  tool: string
  /** What the call does, e.g. "Querying: monthly revenue". */
  summary: string
  state: "running" | "succeeded" | "failed"
  /** How it ended, e.g. "12 rows", or the error. */
  result: string | null
  /** The query execution a run_query call recorded. */
  executionId: string | null
}

/** Text the model streamed while working. */
export interface NoteItem {
  kind: "note"
  text: string
}

export interface ClarificationItem {
  kind: "clarification"
  clarification: Clarification
  /** Null while the run waits for it. */
  answer: string | null
}

export type TimelineItem = ToolStep | NoteItem | ClarificationItem

export interface RunTimeline {
  run: AgentRun
  status: RunStatus
  /** The last event applied; streams resume after it. */
  lastSeq: number
  /** Progress in the order it happened. */
  items: TimelineItem[]
  answer: AgentAnswer | null
  error: RunError | null
  /** How an interrupted run is recovered, from its run.interrupted event or a read of the run. */
  disposition: RecoveryDisposition | null
}

export const isActive = (status: RunStatus) => ACTIVE_RUN_STATUSES.includes(status)

/** The answer or error of a finished run supersedes the text streamed while working. */
const settled = (items: TimelineItem[]) => items.filter((item) => item.kind !== "note")

function applyEvent(timeline: RunTimeline, event: RunEvent): RunTimeline {
  const items = timeline.items
  const last = items.at(-1)
  // A finished run stays finished, whatever a late event says.
  const status = (next: RunStatus) => (isActive(timeline.status) ? next : timeline.status)
  switch (event.type) {
    case "run.started":
      return { ...timeline, status: status("running") }
    case "tool.started":
      return {
        ...timeline,
        items: [
          ...items,
          {
            kind: "tool",
            callId: event.data.callId,
            tool: event.data.tool,
            summary: event.data.summary,
            state: "running",
            result: null,
            executionId: null,
          },
        ],
      }
    case "tool.finished": {
      const finished = {
        state: event.data.ok ? ("succeeded" as const) : ("failed" as const),
        result: event.data.summary,
        executionId: event.data.executionId ?? null,
      }
      const index = items.findLastIndex((item) => item.kind === "tool" && item.callId === event.data.callId)
      if (index < 0) {
        const step: ToolStep = {
          kind: "tool",
          callId: event.data.callId,
          tool: event.data.tool,
          summary: event.data.tool,
          ...finished,
        }
        return { ...timeline, items: [...items, step] }
      }
      return {
        ...timeline,
        items: items.map((item, at) =>
          at === index && item.kind === "tool" ? { ...item, ...finished } : item,
        ),
      }
    }
    case "answer.delta":
      return {
        ...timeline,
        items:
          last?.kind === "note"
            ? [...items.slice(0, -1), { kind: "note", text: last.text + event.data.text }]
            : [...items, { kind: "note", text: event.data.text }],
      }
    case "clarification.requested":
      return {
        ...timeline,
        status: status("awaiting_input"),
        items: [...items, { kind: "clarification", clarification: event.data, answer: null }],
      }
    case "clarification.answered":
      return {
        ...timeline,
        status: status("running"),
        items: items.map((item) =>
          item.kind === "clarification" && item.clarification.id === event.data.id
            ? { ...item, answer: event.data.answer }
            : item,
        ),
      }
    case "answer.completed":
      return { ...timeline, status: status("completed"), answer: event.data.answer, items: settled(items) }
    case "run.failed":
      return { ...timeline, status: status("failed"), error: event.data, items: settled(items) }
    case "run.cancelled":
      return { ...timeline, status: status("cancelled"), items: settled(items) }
    case "run.interrupted":
      return {
        ...timeline,
        status: status("interrupted"),
        error: { code: event.data.code, message: event.data.message },
        disposition: event.data.disposition,
        items: settled(items),
      }
  }
}

/** Applies events not seen yet, in sequence order; repeats and older events are ignored. */
export function applyEvents(timeline: RunTimeline, events: RunEvent[]): RunTimeline {
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .reduce(
      (current, event) =>
        event.seq <= current.lastSeq ? current : { ...applyEvent(current, event), lastSeq: event.seq },
      timeline,
    )
}

/** A run as last read, with whatever events came with it. */
export function timelineFromRun(run: AgentRun | AgentRunWithEvents): RunTimeline {
  const { events = [], ...rest } = run as AgentRunWithEvents
  const start: RunTimeline = {
    run: rest,
    status: "queued",
    lastSeq: 0,
    items: [],
    answer: null,
    error: null,
    disposition: null,
  }
  return withSnapshot(applyEvents(start, events), rest)
}

/**
 * A fresher read of the run: its events are merged in, and a run the server
 * has finished is finished here too, even if its last events never arrived.
 * An older read never makes a finished run active again.
 */
function withSnapshot(timeline: RunTimeline, run: AgentRun): RunTimeline {
  if (!isActive(run.status)) {
    return {
      ...timeline,
      run,
      status: isActive(timeline.status) ? run.status : timeline.status,
      items: settled(timeline.items),
      answer: timeline.answer ?? run.answer,
      error: timeline.error ?? run.error,
      disposition: timeline.disposition ?? run.disposition,
    }
  }
  const fromRun = timeline.lastSeq === 0 && isActive(timeline.status)
  return { ...timeline, run, status: fromRun ? run.status : timeline.status }
}

/** The clarification a run is waiting on, if any. */
export function pendingClarification(timeline: RunTimeline): ClarificationItem | null {
  if (timeline.status !== "awaiting_input") return null
  return (
    timeline.items.findLast(
      (item): item is ClarificationItem => item.kind === "clarification" && item.answer === null,
    ) ?? null
  )
}

// A conversation on screen --------------------------------------------------

export interface ChatState {
  conversationId: string | null
  /** Oldest first. */
  runs: RunTimeline[]
  /** The server has older runs than the oldest shown. */
  hasEarlier: boolean
}

export type ChatAction =
  /** Another conversation (or a new one) is opened. */
  | { type: "open"; conversationId: string | null }
  /** The conversation as read from the server: its latest runs, or older ones. */
  | { type: "loaded"; conversation: ConversationWithRuns }
  /**
   * A question was accepted. `from` is the conversation it was asked in
   * (null: a new one); if another conversation was opened meanwhile, the run
   * stays out of it.
   */
  | { type: "started"; run: AgentRun; from: string | null }
  | { type: "events"; runId: string; events: RunEvent[] }
  /** A fresher read of one run, e.g. after cancelling or answering it. */
  | { type: "run"; run: AgentRunWithEvents }

export const emptyChat = (conversationId: string | null): ChatState => ({
  conversationId,
  runs: [],
  hasEarlier: false,
})

const byCreation = (a: RunTimeline, b: RunTimeline) =>
  a.run.createdAt.localeCompare(b.run.createdAt) || a.run.id.localeCompare(b.run.id)

function mergeRun(runs: RunTimeline[], run: AgentRun | AgentRunWithEvents): RunTimeline[] {
  const index = runs.findIndex((timeline) => timeline.run.id === run.id)
  if (index < 0) return [...runs, timelineFromRun(run)]
  const merged = withSnapshot(applyEvents(runs[index], (run as AgentRunWithEvents).events ?? []), run)
  return runs.map((timeline, at) => (at === index ? merged : timeline))
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "open":
      return action.conversationId === state.conversationId ? state : emptyChat(action.conversationId)
    case "loaded": {
      const { conversation } = action
      if (conversation.id !== state.conversationId) return state
      const runs = [...conversation.runs.reduce(mergeRun, state.runs)].sort(byCreation)
      // Only the read that reaches furthest back knows whether older runs exist.
      const oldest = conversation.runs[0]
      const reachesBack = !oldest || runs[0]?.run.id === oldest.id
      return { ...state, runs, hasEarlier: reachesBack ? conversation.hasEarlier : state.hasEarlier }
    }
    case "started":
      if (action.from !== state.conversationId) return state
      return { ...state, conversationId: action.run.conversationId, runs: mergeRun(state.runs, action.run) }
    case "events":
      return {
        ...state,
        runs: state.runs.map((timeline) =>
          timeline.run.id === action.runId ? applyEvents(timeline, action.events) : timeline,
        ),
      }
    case "run":
      if (action.run.conversationId !== state.conversationId) return state
      return { ...state, runs: mergeRun(state.runs, action.run) }
  }
}

/** Whether a run of the conversation was retried (it has a retry among the runs shown). */
export function wasRetried(state: ChatState, runId: string): boolean {
  return state.runs.some((timeline) => timeline.run.retryOf === runId)
}

/** The run still being answered, if any (a conversation has at most one). */
export function activeRun(state: ChatState): RunTimeline | null {
  return state.runs.findLast((timeline) => isActive(timeline.status)) ?? null
}
