import assert from "node:assert/strict"
import test from "node:test"

import {
  activeRun,
  applyEvents,
  chatReducer,
  emptyChat,
  pendingClarification,
  timelineFromRun,
} from "../src/entities/agent/timeline.ts"
import type { AgentAnswer, AgentRun, AgentRunWithEvents, RunEvent } from "../src/entities/agent/types.ts"

const AT = "2026-10-31T10:00:00.000Z"

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    conversationId: "conversation-1",
    userId: "user-1",
    question: "Who are the top customers?",
    connectionIds: [],
    status: "queued",
    provider: "scripted",
    model: "demo (synthetic)",
    answer: null,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: 0,
    clarification: null,
    attachments: [],
    createdAt: AT,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

const ANSWER: AgentAnswer = {
  markdown: "**Ada** ranks first with 12 orders.",
  status: "complete",
  missing: [],
  evidence: [],
}

let seq = 0
function event<T extends RunEvent["type"]>(
  type: T,
  data: Extract<RunEvent, { type: T }>["data"],
  at = seq + 1,
): RunEvent {
  seq = Math.max(seq, at)
  return { seq: at, type, data, createdAt: AT } as RunEvent
}

function story(): RunEvent[] {
  seq = 0
  return [
    event("run.started", { provider: "scripted", model: "demo (synthetic)" }),
    event("answer.delta", { text: "Checking which " }),
    event("answer.delta", { text: "sources exist. " }),
    event("tool.started", { callId: "c1", tool: "list_sources", summary: "Listing sources" }),
    event("tool.finished", { callId: "c1", tool: "list_sources", ok: true, summary: "1 source" }),
    event("tool.started", { callId: "c2", tool: "run_query", summary: "Querying: top customers" }),
    event("tool.finished", {
      callId: "c2",
      tool: "run_query",
      ok: false,
      summary: "QUERY_REJECTED: not allowed",
      executionId: "exec-1",
    }),
  ]
}

test("events build the run's progress in sequence order, whatever order they arrive in", () => {
  const events = story()
  const shuffled = [events[4], events[0], events[6], events[2], events[1], events[5], events[3]] as RunEvent[]
  const timeline = applyEvents(timelineFromRun(run()), shuffled)
  assert.equal(timeline.status, "running")
  assert.equal(timeline.lastSeq, 7)
  assert.deepEqual(timeline.items, [
    { kind: "note", text: "Checking which sources exist. " },
    {
      kind: "tool",
      callId: "c1",
      tool: "list_sources",
      summary: "Listing sources",
      state: "succeeded",
      result: "1 source",
      executionId: null,
    },
    {
      kind: "tool",
      callId: "c2",
      tool: "run_query",
      summary: "Querying: top customers",
      state: "failed",
      result: "QUERY_REJECTED: not allowed",
      executionId: "exec-1",
    },
  ])
})

test("events already applied are ignored by sequence, so replays after a reconnect change nothing", () => {
  const events = story()
  const once = applyEvents(timelineFromRun(run()), events)
  const replayed = applyEvents(applyEvents(once, events.slice(3)), [...events, ...events])
  assert.deepEqual(replayed, once)
  const late = applyEvents(once, [event("answer.delta", { text: "stale" }, 2)])
  assert.equal(late, once, "an event at or below the last sequence is a no-op")
})

test("streamed text comes first, and the final answer is the structured one", () => {
  const events = [
    ...story(),
    event("answer.delta", { text: "Done." }),
    event("answer.completed", { answer: ANSWER }),
  ]
  const timeline = applyEvents(timelineFromRun(run()), events)
  assert.equal(timeline.status, "completed")
  assert.deepEqual(timeline.answer, ANSWER)
  assert.deepEqual(timeline.items.at(-1), { kind: "note", text: "Done." })
  assert.equal(activeRun({ conversationId: "conversation-1", runs: [timeline] }), null)
})

test("a clarification waits for an answer, then the run goes on", () => {
  seq = 0
  const asked = applyEvents(timelineFromRun(run()), [
    event("run.started", { provider: "scripted", model: "demo (synthetic)" }),
    event("tool.started", { callId: "c1", tool: "ask_user", summary: "Asking you: revenue or orders?" }),
    event("clarification.requested", {
      id: "q1",
      question: "Revenue or orders?",
      options: ["By revenue", "By number of orders"],
      allowFreeText: true,
    }),
  ])
  assert.equal(asked.status, "awaiting_input")
  assert.equal(pendingClarification(asked)?.clarification.question, "Revenue or orders?")

  const answered = applyEvents(asked, [
    event("clarification.answered", { id: "q1", answer: "By number of orders" }),
    event("tool.finished", {
      callId: "c1",
      tool: "ask_user",
      ok: true,
      summary: "You answered: By number of orders",
    }),
  ])
  assert.equal(answered.status, "running")
  assert.equal(pendingClarification(answered), null)
  assert.deepEqual(
    answered.items.find((item) => item.kind === "clarification"),
    {
      kind: "clarification",
      clarification: {
        id: "q1",
        question: "Revenue or orders?",
        options: ["By revenue", "By number of orders"],
        allowFreeText: true,
      },
      answer: "By number of orders",
    },
  )
})

test("cancelling and failing end the run, and a finished run stays finished", () => {
  const events = story()
  const cancelled = applyEvents(timelineFromRun(run()), [...events, event("run.cancelled", {})])
  assert.equal(cancelled.status, "cancelled")
  assert.equal(
    applyEvents(cancelled, [event("run.started", { provider: "x", model: "y" })]).status,
    "cancelled",
  )

  const failed = applyEvents(timelineFromRun(run()), [
    ...story(),
    event("run.failed", { code: "AGENT_TIMEOUT", message: "The question took longer than 5 minutes." }),
  ])
  assert.equal(failed.status, "failed")
  assert.deepEqual(failed.error, {
    code: "AGENT_TIMEOUT",
    message: "The question took longer than 5 minutes.",
  })
})

test("a finished read of the run settles it even when its last events never arrived", () => {
  const live = applyEvents(timelineFromRun(run()), story())
  const state = chatReducer(chatReducer(emptyChat(null), { type: "started", run: run() }), {
    type: "events",
    runId: "run-1",
    events: story(),
  })
  assert.deepEqual(state.runs[0], live)
  const settled = chatReducer(state, {
    type: "run",
    run: { ...run({ status: "completed", answer: ANSWER }), events: [] } satisfies AgentRunWithEvents,
  })
  assert.equal(settled.runs[0]?.status, "completed")
  assert.deepEqual(settled.runs[0]?.answer, ANSWER)
  assert.equal(settled.runs[0]?.items.length, live.items.length, "progress so far is kept")
})

test("a conversation opens from its stored runs, merges with runs started here, and resets when another opens", () => {
  const opened = chatReducer(emptyChat(null), { type: "open", conversationId: "conversation-1" })
  assert.deepEqual(opened, { conversationId: "conversation-1", runs: [] })
  const asked = chatReducer(opened, {
    type: "started",
    run: run({ id: "run-2", createdAt: "2026-10-31T10:05:00.000Z" }),
  })
  const loaded = chatReducer(asked, {
    type: "loaded",
    conversation: {
      id: "conversation-1",
      title: "Who are the top customers?",
      createdAt: AT,
      updatedAt: AT,
      runs: [
        { ...run({ status: "completed", answer: ANSWER }), events: [] },
        {
          ...run({ id: "run-2", status: "running", createdAt: "2026-10-31T10:05:00.000Z" }),
          events: story(),
        },
      ],
    },
  })
  assert.deepEqual(
    loaded.runs.map((timeline) => [timeline.run.id, timeline.status]),
    [
      ["run-1", "completed"],
      ["run-2", "running"],
    ],
  )
  assert.equal(activeRun(loaded)?.run.id, "run-2")
  assert.equal(activeRun(loaded)?.lastSeq, 7)
  assert.equal(
    chatReducer(loaded, {
      type: "loaded",
      conversation: { ...loaded, id: "other", title: "", createdAt: AT, updatedAt: AT, runs: [] },
    }),
    loaded,
    "another conversation's read is ignored",
  )
  assert.equal(chatReducer(loaded, { type: "open", conversationId: "conversation-1" }), loaded)
  assert.deepEqual(chatReducer(loaded, { type: "open", conversationId: null }), emptyChat(null))
})

test("after a reconnect, the caught-up read and the replayed stream add up to each event once", () => {
  const events = story()
  const once = chatReducer(chatReducer(emptyChat(null), { type: "started", run: run() }), {
    type: "events",
    runId: "run-1",
    events,
  })
  // Events 1-3 arrived live, the read while reconnecting brought 4-7, then the new stream repeats 6-7.
  let state = chatReducer(emptyChat(null), { type: "started", run: run() })
  state = chatReducer(state, { type: "events", runId: "run-1", events: events.slice(0, 3) })
  state = chatReducer(state, {
    type: "run",
    run: { ...run({ status: "running" }), events: events.slice(3) },
  })
  for (const repeated of events.slice(5)) {
    state = chatReducer(state, { type: "events", runId: "run-1", events: [repeated] })
  }
  assert.deepEqual(state.runs[0]?.items, once.runs[0]?.items)
  assert.equal(state.runs[0]?.lastSeq, 7)
  assert.equal(activeRun(state)?.lastSeq, 7, "the next stream starts after the last event")
})

test("an older read of the run never undoes what the stream has shown", () => {
  const events = [...story(), event("answer.completed", { answer: ANSWER })]
  const done = chatReducer(chatReducer(emptyChat(null), { type: "started", run: run() }), {
    type: "events",
    runId: "run-1",
    events,
  })
  const stale = chatReducer(done, {
    type: "loaded",
    conversation: {
      id: "conversation-1",
      title: "Who are the top customers?",
      createdAt: AT,
      updatedAt: AT,
      runs: [{ ...run({ status: "running" }), events: events.slice(0, 3) }],
    },
  })
  assert.equal(stale.runs[0]?.status, "completed")
  assert.deepEqual(stale.runs[0]?.answer, ANSWER)
  assert.deepEqual(stale.runs[0]?.items, done.runs[0]?.items)
  assert.equal(activeRun(stale), null)

  // Settled by a finished read without events, then an older read still says queued.
  const settled = chatReducer(chatReducer(emptyChat(null), { type: "started", run: run() }), {
    type: "run",
    run: { ...run({ status: "failed", error: { code: "AGENT_INTERRUPTED", message: "Stopped." } }), events: [] },
  })
  const older = chatReducer(settled, { type: "run", run: { ...run(), events: [] } })
  assert.equal(older.runs[0]?.status, "failed")
  assert.equal(activeRun(older), null)
})

test("cancelling while a clarification waits removes the question to answer and ends the run", () => {
  seq = 0
  const asked = [
    event("run.started", { provider: "scripted", model: "demo (synthetic)" }),
    event("tool.started", { callId: "c1", tool: "ask_user", summary: "Asking you: which month?" }),
    event("clarification.requested", { id: "q1", question: "Which month?", options: [], allowFreeText: true }),
  ]
  const waiting = chatReducer(chatReducer(emptyChat(null), { type: "started", run: run() }), {
    type: "events",
    runId: "run-1",
    events: asked,
  })
  assert.equal(activeRun(waiting)?.status, "awaiting_input")
  assert.ok(pendingClarification(waiting.runs[0] as NonNullable<(typeof waiting.runs)[0]>))

  // The cancel response carries every event; the stream then repeats the last one.
  const cancelledEvent = event("run.cancelled", {})
  const cancelled = chatReducer(waiting, {
    type: "run",
    run: { ...run({ status: "cancelled" }), events: [...asked, cancelledEvent] },
  })
  const repeated = chatReducer(cancelled, { type: "events", runId: "run-1", events: [cancelledEvent] })
  assert.deepEqual(repeated, cancelled, "the repeated terminal event changes nothing")
  const timeline = repeated.runs[0]
  assert.ok(timeline)
  assert.equal(timeline.status, "cancelled")
  assert.equal(pendingClarification(timeline), null)
  assert.equal(activeRun(repeated), null)
})

test("an answer to a clarification shows at once from the response, and the stream's copy is ignored", () => {
  seq = 0
  const asked = [
    event("run.started", { provider: "scripted", model: "demo (synthetic)" }),
    event("clarification.requested", {
      id: "q1",
      question: "Revenue or orders?",
      options: ["By revenue", "By number of orders"],
      allowFreeText: false,
    }),
  ]
  const answeredEvent = event("clarification.answered", { id: "q1", answer: "By revenue" })
  const waiting = chatReducer(chatReducer(emptyChat(null), { type: "started", run: run() }), {
    type: "events",
    runId: "run-1",
    events: asked,
  })
  const answered = chatReducer(waiting, {
    type: "run",
    run: { ...run({ status: "running" }), events: [...asked, answeredEvent] },
  })
  assert.equal(answered.runs[0]?.status, "running")
  assert.equal(pendingClarification(answered.runs[0] as NonNullable<(typeof answered.runs)[0]>), null)
  assert.deepEqual(chatReducer(answered, { type: "events", runId: "run-1", events: [answeredEvent] }), answered)
})
