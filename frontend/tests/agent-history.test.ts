import assert from "node:assert/strict"
import test from "node:test"

import { followRun, type StreamHandlers } from "../src/entities/agent/run-stream.ts"
import {
  activeRun,
  chatReducer,
  emptyChat,
  wasRetried,
  type ChatState,
} from "../src/entities/agent/timeline.ts"
import type {
  AgentAnswer,
  AgentRun,
  AgentRunWithEvents,
  ConversationPage,
  ConversationSummary,
  ConversationWithRuns,
  RunEvent,
} from "../src/entities/agent/types.ts"
import { announcement, waitsUntil } from "../src/features/chat-panel/chat-text.ts"
import { nextSubmission, submissionKey } from "../src/features/chat-panel/submission.ts"
import {
  conversationBadge,
  listedConversations,
} from "../src/features/conversation-list/conversation-items.ts"

const AT = "2026-10-31T10:00:00.000Z"
const ANSWER: AgentAnswer = {
  markdown: "There are **42** orders.",
  status: "complete",
  missing: [],
  evidence: [],
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    conversationId: "conversation-1",
    userId: "user-1",
    question: "How many orders?",
    connectionIds: [],
    status: "running",
    provider: "scripted",
    model: "demo (synthetic)",
    answer: null,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: 0,
    clarification: null,
    attachments: [],
    disposition: null,
    retryOf: null,
    createdAt: AT,
    startedAt: AT,
    finishedAt: null,
    ...overrides,
  }
}

function event<T extends RunEvent["type"]>(
  seq: number,
  type: T,
  data: Extract<RunEvent, { type: T }>["data"],
): RunEvent {
  return { seq, type, data, createdAt: AT } as RunEvent
}

/** A run that streams text, runs a query, streams more text, and answers. */
const story: RunEvent[] = [
  event(1, "run.started", { provider: "scripted", model: "demo (synthetic)" }),
  event(2, "answer.delta", { text: "Counting the " }),
  event(3, "answer.delta", { text: "orders. " }),
  event(4, "tool.started", { callId: "c1", tool: "run_query", summary: "Querying: orders" }),
  event(5, "tool.finished", {
    callId: "c1",
    tool: "run_query",
    ok: true,
    summary: "1 row",
    executionId: "e1",
  }),
  event(6, "answer.delta", { text: "There are 42 orders." }),
  event(7, "answer.completed", { answer: ANSWER }),
]

function conversation(runs: AgentRunWithEvents[], hasEarlier = false): ConversationWithRuns {
  return { id: "conversation-1", title: "How many orders?", createdAt: AT, updatedAt: AT, runs, hasEarlier }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("a stream that drops mid-answer catches up, and the run shows one answer without repeated text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let state = chatReducer(emptyChat(null), { type: "started", run: run(), from: null })
  const connections: { after: number; on: StreamHandlers }[] = []
  const reads: number[] = []
  followRun({
    from: 0,
    open(after, on) {
      connections.push({ after, on })
      return { close() {} }
    },
    // While disconnected the run finished: the read brings the rest of its events.
    async read(after) {
      reads.push(after)
      return {
        ...run({ status: "completed", answer: ANSWER }),
        events: story.filter((entry) => entry.seq > after),
      }
    },
    onEvents: (events) => (state = chatReducer(state, { type: "events", runId: "run-1", events })),
    onRun: (fresh) => (state = chatReducer(state, { type: "run", run: fresh })),
    onState() {},
  })
  const [first] = connections
  assert.ok(first)
  first.on.open()
  for (const entry of story.slice(0, 3)) first.on.message(JSON.stringify(entry))
  assert.deepEqual(
    state.runs[0]?.items.map((item) => item.kind === "note" && item.text),
    ["Counting the orders. "],
    "streamed text shows while the run works",
  )
  first.on.error()
  t.mock.timers.tick(1_000)
  await settle()

  assert.deepEqual(reads, [3], "the read starts after the last event received")
  assert.equal(connections.length, 1, "a finished run is not followed again")
  const timeline = state.runs[0]
  assert.ok(timeline)
  assert.equal(timeline.status, "completed")
  assert.equal(timeline.lastSeq, 7)
  assert.deepEqual(timeline.answer, ANSWER)
  assert.deepEqual(
    timeline.items.map((item) => item.kind),
    ["tool"],
    "the answer replaces the streamed text, as when the conversation is read again",
  )

  // Reading the conversation again (after a refresh) shows the same thing.
  const reloaded = chatReducer(
    chatReducer(emptyChat(null), { type: "open", conversationId: "conversation-1" }),
    {
      type: "loaded",
      conversation: conversation([
        {
          ...run({ status: "completed", answer: ANSWER }),
          events: story.filter((entry) => entry.type !== "answer.delta"),
        },
      ]),
    },
  )
  assert.deepEqual(reloaded.runs[0]?.items, timeline.items)
  assert.deepEqual(reloaded.runs[0]?.answer, timeline.answer)
})

test("a live stream ends on run.interrupted, and the run shows how to recover it", () => {
  let state = chatReducer(emptyChat(null), { type: "started", run: run(), from: null })
  const states: string[] = []
  let handlers: StreamHandlers | null = null
  followRun({
    from: 0,
    open(_after, on) {
      handlers = on
      return { close() {} }
    },
    read: () => new Promise(() => {}),
    onEvents: (events) => (state = chatReducer(state, { type: "events", runId: "run-1", events })),
    onRun() {},
    onState: (next) => states.push(next),
  })
  const on = handlers as StreamHandlers | null
  assert.ok(on)
  on.open()
  on.message(JSON.stringify(story[1]))
  on.message(
    JSON.stringify(
      event(4, "run.interrupted", {
        code: "AGENT_INTERRUPTED",
        message: "A restart interrupted it.",
        disposition: "retry",
      }),
    ),
  )
  assert.equal(states.at(-1), "ended")
  const timeline = state.runs[0]
  assert.equal(timeline?.status, "interrupted")
  assert.deepEqual(timeline?.error, { code: "AGENT_INTERRUPTED", message: "A restart interrupted it." })
  assert.equal(timeline?.disposition, "retry", "Retry is offered without reading the run again")
  assert.equal(timeline?.run.disposition, null)
  assert.deepEqual(timeline?.items, [])
  assert.equal(activeRun(state), null)
})

test("earlier pages of a conversation merge in order, and only the furthest read says whether more exist", () => {
  const at = (minute: number) => `2026-10-31T10:${String(minute).padStart(2, "0")}:00.000Z`
  const finished = (id: string, minute: number): AgentRunWithEvents => ({
    ...run({ id, status: "completed", answer: ANSWER, createdAt: at(minute) }),
    events: [event(1, "answer.completed", { answer: ANSWER })],
  })
  let state: ChatState = chatReducer(emptyChat(null), { type: "open", conversationId: "conversation-1" })
  state = chatReducer(state, {
    type: "loaded",
    conversation: conversation([finished("r3", 3), finished("r4", 4)], true),
  })
  assert.equal(state.hasEarlier, true)
  state = chatReducer(state, {
    type: "loaded",
    conversation: conversation([finished("r1", 1), finished("r2", 2)], false),
  })
  assert.deepEqual(
    state.runs.map((timeline) => timeline.run.id),
    ["r1", "r2", "r3", "r4"],
  )
  assert.equal(state.hasEarlier, false)
  // A fresh read of the latest page (it still has older runs) does not bring the button back.
  state = chatReducer(state, {
    type: "loaded",
    conversation: conversation([finished("r3", 3), finished("r4", 4), finished("r5", 5)], true),
  })
  assert.deepEqual(
    state.runs.map((timeline) => timeline.run.id),
    ["r1", "r2", "r3", "r4", "r5"],
  )
  assert.equal(state.hasEarlier, false)
})

test("a question sent before opening another conversation stays out of it", () => {
  const onNew = chatReducer(emptyChat(null), { type: "open", conversationId: null })
  // While the first question of a new conversation was being sent, the user opened conversation-2.
  const moved = chatReducer(onNew, { type: "open", conversationId: "conversation-2" })
  const late = chatReducer(moved, {
    type: "started",
    run: run({ conversationId: "conversation-9" }),
    from: null,
  })
  assert.equal(late, moved)
  // A follow-up sent in conversation-2, after which the user started a new conversation.
  const fresh = chatReducer(moved, { type: "open", conversationId: null })
  assert.equal(
    chatReducer(fresh, {
      type: "started",
      run: run({ conversationId: "conversation-2" }),
      from: "conversation-2",
    }),
    fresh,
  )
  // A late cancel or answer response for another conversation's run changes nothing either.
  assert.equal(
    chatReducer(fresh, { type: "run", run: { ...run({ conversationId: "conversation-2" }), events: [] } }),
    fresh,
  )
  // Still on the conversation it was asked in: it shows.
  const shown = chatReducer(onNew, {
    type: "started",
    run: run({ conversationId: "conversation-9" }),
    from: null,
  })
  assert.equal(shown.conversationId, "conversation-9")
  assert.equal(shown.runs.length, 1)
})

test("an interrupted run counts as retried once its retry is in the conversation", () => {
  let state = chatReducer(emptyChat(null), {
    type: "started",
    run: run({ status: "interrupted", disposition: "retry" }),
    from: null,
  })
  assert.equal(wasRetried(state, "run-1"), false)
  state = chatReducer(state, {
    type: "started",
    run: run({ id: "run-2", retryOf: "run-1", status: "queued", createdAt: "2026-10-31T10:01:00.000Z" }),
    from: "conversation-1",
  })
  assert.equal(wasRetried(state, "run-1"), true)
  assert.equal(activeRun(state)?.run.id, "run-2")
})

test("sending the same question again reuses its mutationId; a changed question gets a new one", () => {
  const file = { name: "notes.md", size: 12, lastModified: 1 }
  const draft = { question: "How many orders? ", connectionIds: ["b", "a"], files: [file] }
  const key = submissionKey("conversation-1", draft)
  let ids = 0
  const newId = () => `id-${(ids += 1)}`
  const failed = nextSubmission(null, key, newId)
  assert.deepEqual(failed, { key, mutationId: "id-1" })
  const same = submissionKey("conversation-1", {
    ...draft,
    question: "How many orders?",
    connectionIds: ["a", "b"],
  })
  assert.equal(nextSubmission(failed, same, newId).mutationId, "id-1", "the resend is the same question")
  for (const changed of [
    submissionKey("conversation-1", { ...draft, question: "How many refunds?" }),
    submissionKey("conversation-1", { ...draft, connectionIds: ["a"] }),
    submissionKey("conversation-1", { ...draft, files: [{ ...file, lastModified: 2 }] }),
    submissionKey(null, draft),
  ]) {
    assert.notEqual(nextSubmission(failed, changed, newId).mutationId, "id-1")
  }
})

test("the conversation list badges what needs attention and lists each conversation once", () => {
  assert.deepEqual(conversationBadge({ status: "running", pendingClarification: false }), {
    label: "Running",
    tone: "neutral",
  })
  assert.deepEqual(conversationBadge({ status: "awaiting_input", pendingClarification: true }), {
    label: "Needs your answer",
    tone: "warning",
  })
  assert.deepEqual(conversationBadge({ status: "failed", pendingClarification: false }), {
    label: "Failed",
    tone: "danger",
  })
  assert.deepEqual(conversationBadge({ status: "interrupted", pendingClarification: false }), {
    label: "Interrupted",
    tone: "warning",
  })
  for (const status of ["completed", "cancelled", null] as const) {
    assert.equal(conversationBadge({ status, pendingClarification: false }), null)
  }

  const item = (id: string): ConversationSummary => ({
    id,
    title: id,
    createdAt: AT,
    updatedAt: AT,
    status: "completed",
    pendingClarification: false,
    routine: null,
  })
  const pages: ConversationPage[] = [
    { conversations: [item("a"), item("b")], nextCursor: "next" },
    // "a" moved up between reads and was read again on the next page.
    { conversations: [item("c"), item("a")], nextCursor: null },
  ]
  assert.deepEqual(
    listedConversations(pages).map((entry) => entry.id),
    ["a", "b", "c"],
  )
})

test("a clarification says until when it waits, and an interruption is announced", () => {
  const now = Date.parse("2026-10-31T09:00:00")
  assert.match(waitsUntil(new Date("2026-10-31T09:30:00").toISOString(), now), /^\d{2}:30( [AP]M)?$/)
  assert.match(waitsUntil(new Date("2026-11-01T09:30:00").toISOString(), now), /^Nov 1, \d{2}:30/)
  assert.equal(announcement("interrupted", null), "A restart interrupted the question.")
})
