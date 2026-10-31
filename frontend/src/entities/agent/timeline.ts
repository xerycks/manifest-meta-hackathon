// Builds what the ask screen shows from a run and its ordered events. Events
// are applied once each, in sequence order, so replays and duplicate
// deliveries after a reconnect change nothing.

import {
  ACTIVE_RUN_STATUSES,
  type AgentAnswer,
  type AgentRun,
  type AgentRunWithEvents,
  type Clarification,
  type ConversationWithRuns,
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
}

export const isActive = (status: RunStatus) => ACTIVE_RUN_STATUSES.includes(status)

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
      return { ...timeline, status: status("completed"), answer: event.data.answer }
    case "run.failed":
      return { ...timeline, status: status("failed"), error: event.data }
    case "run.cancelled":
      return { ...timeline, status: status("cancelled") }
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
      answer: timeline.answer ?? run.answer,
      error: timeline.error ?? run.error,
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
}

export type ChatAction =
  /** Another conversation (or a new one) is opened. */
  | { type: "open"; conversationId: string | null }
  /** The conversation as read from the server. */
  | { type: "loaded"; conversation: ConversationWithRuns }
  /** A question was accepted; its conversation is the current one from now on. */
  | { type: "started"; run: AgentRun }
  | { type: "events"; runId: string; events: RunEvent[] }
  /** A fresher read of one run, e.g. after cancelling or answering it. */
  | { type: "run"; run: AgentRunWithEvents }

export const emptyChat = (conversationId: string | null): ChatState => ({ conversationId, runs: [] })

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
      if (action.conversation.id !== state.conversationId) return state
      const runs = action.conversation.runs.reduce(mergeRun, state.runs)
      return { ...state, runs: [...runs].sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt)) }
    }
    case "started":
      return { conversationId: action.run.conversationId, runs: mergeRun(state.runs, action.run) }
    case "events":
      return {
        ...state,
        runs: state.runs.map((timeline) =>
          timeline.run.id === action.runId ? applyEvents(timeline, action.events) : timeline,
        ),
      }
    case "run":
      return { ...state, runs: mergeRun(state.runs, action.run) }
  }
}

/** The run still being answered, if any (a conversation has at most one). */
export function activeRun(state: ChatState): RunTimeline | null {
  return state.runs.findLast((timeline) => isActive(timeline.status)) ?? null
}
