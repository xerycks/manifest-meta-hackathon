import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"

import { followRun, reconnectDelay, SILENCE_MS, type StreamHandlers } from "../src/entities/agent/run-stream.ts"
import type { AgentRunWithEvents, RunEvent, RunStatus } from "../src/entities/agent/types.ts"
import { ApiError } from "../src/shared/api/client.ts"

const AT = "2026-10-31T10:00:00.000Z"

function event(seq: number, type: RunEvent["type"] = "tool.started"): RunEvent {
  const data =
    type === "answer.completed"
      ? { answer: { markdown: "Done.", status: "complete", missing: [], evidence: [] } }
      : { callId: `c${seq}`, tool: "list_sources", summary: "Listing sources" }
  return { seq, type, data, createdAt: AT } as RunEvent
}

function run(status: RunStatus, events: RunEvent[]): AgentRunWithEvents {
  return {
    id: "run-1",
    conversationId: "conversation-1",
    userId: "user-1",
    question: "How many orders?",
    connectionIds: [],
    status,
    provider: "scripted",
    model: "demo (synthetic)",
    answer: null,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: 0,
    clarification: null,
    attachments: [],
    createdAt: AT,
    startedAt: AT,
    finishedAt: null,
    events,
  }
}

interface Connection {
  after: number
  on: StreamHandlers
  closed: boolean
  send(seq: number, type?: RunEvent["type"]): void
}

/** Lets pending promises (a finished read) settle; setImmediate is not mocked. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** Timers are mocked so waits pass when the test says. */
const mockTimers = (t: TestContext) => t.mock.timers.enable({ apis: ["setTimeout"] })

/** A followed run whose stream connections and reads the test drives by hand. */
function follow(from: number, read: (after: number) => Promise<AgentRunWithEvents>) {
  const connections: Connection[] = []
  const applied: number[] = []
  const reads: number[] = []
  const caughtUp: number[][] = []
  const states: string[] = []
  const stop = followRun({
    from,
    open(after, on) {
      const connection: Connection = {
        after,
        on,
        closed: false,
        send: (seq, type) => on.message(JSON.stringify(event(seq, type))),
      }
      connections.push(connection)
      return { close: () => (connection.closed = true) }
    },
    read(after) {
      reads.push(after)
      return read(after)
    },
    onEvents: (events) => applied.push(...events.map((entry) => entry.seq)),
    onRun: (fresh) => caughtUp.push(fresh.events.map((entry) => entry.seq)),
    onState: (state, problem) => states.push(problem ? `${state}: ${problem}` : state),
  })
  const latest = () => {
    const connection = connections.at(-1)
    assert.ok(connection, "a stream was opened")
    return connection
  }
  return { connections, applied, reads, caughtUp, states, stop, latest }
}

const never = () => new Promise<AgentRunWithEvents>(() => {})

test("events are applied once each, after the starting sequence, until the terminal event ends the stream", (t) => {
  mockTimers(t)
  const stream = follow(2, never)
  assert.equal(stream.latest().after, 2, "the stream starts after the last event already applied")
  stream.latest().on.open()
  for (const seq of [1, 2, 3, 3, 4, 2]) stream.latest().send(seq)
  stream.latest().send(5, "answer.completed")
  assert.deepEqual(stream.applied, [3, 4, 5])
  assert.deepEqual(stream.states, ["connecting", "live", "ended"])
  assert.equal(stream.latest().closed, true, "the stream is closed after the terminal event")

  // The browser reports the closed connection as an error; nothing reconnects.
  stream.latest().on.error()
  stream.latest().send(6)
  t.mock.timers.tick(60_000)
  assert.deepEqual(stream.reads, [])
  assert.equal(stream.connections.length, 1)
  assert.deepEqual(stream.applied, [3, 4, 5])
})

test("a dropped connection catches up from the last event received, then reconnects after it", async (t) => {
  mockTimers(t)
  const stream = follow(0, async () => run("running", [event(3), event(4)]))
  stream.latest().on.open()
  stream.latest().send(1)
  stream.latest().send(2)
  stream.latest().on.error()
  assert.equal(stream.connections[0]?.closed, true, "the browser's own reconnect is stopped")
  assert.deepEqual(stream.states, ["connecting", "live", "reconnecting"])

  t.mock.timers.tick(999)
  assert.deepEqual(stream.reads, [], "it waits a moment first")
  t.mock.timers.tick(1)
  await settle()
  assert.deepEqual(stream.reads, [2], "the read starts after the last event received")
  assert.deepEqual(stream.caughtUp, [[3, 4]])
  assert.equal(stream.connections.length, 2)
  assert.equal(stream.latest().after, 4, "the new stream starts after the events the read caught up")

  stream.latest().on.open()
  for (const seq of [3, 4, 5]) stream.latest().send(seq)
  assert.deepEqual(stream.applied, [1, 2, 5], "events the read delivered are not applied again")
  assert.equal(stream.states.at(-1), "live")
})

test("a run that ended while disconnected is settled from the read, without reconnecting", async (t) => {
  mockTimers(t)
  const stream = follow(4, async () => run("cancelled", [event(5)]))
  stream.latest().on.error()
  t.mock.timers.tick(1_000)
  await settle()
  assert.deepEqual(stream.caughtUp, [[5]])
  assert.deepEqual(stream.states, ["connecting", "reconnecting", "ended"])
  assert.equal(stream.connections.length, 1)
})

test("server and network failures are retried with growing waits; a refusal loses the stream with its reason", async (t) => {
  mockTimers(t)
  const answers: (() => Promise<AgentRunWithEvents>)[] = [
    () => Promise.reject(new ApiError(502, "HTTP_ERROR", "Request failed (502)")),
    () => Promise.reject(new ApiError(0, "NETWORK_ERROR", "Cannot reach the Manifest API.")),
    async () => run("awaiting_input", []),
    () => Promise.reject(new ApiError(404, "NOT_FOUND", "Run not found")),
  ]
  const stream = follow(7, () => (answers.shift() ?? never)())
  stream.latest().on.error()
  t.mock.timers.tick(1_000)
  await settle()
  t.mock.timers.tick(1_999)
  await settle()
  assert.equal(stream.reads.length, 1, "the second attempt waits 2 s")
  t.mock.timers.tick(1)
  await settle()
  assert.equal(stream.reads.length, 2)
  t.mock.timers.tick(4_000)
  await settle()
  assert.equal(stream.reads.length, 3)
  assert.equal(stream.connections.length, 2, "reconnected once the run could be read")
  assert.equal(stream.latest().after, 7)

  // A connection that opened resets the waits.
  stream.latest().on.open()
  stream.latest().on.error()
  t.mock.timers.tick(1_000)
  await settle()
  assert.deepEqual(stream.reads, [7, 7, 7, 7])
  assert.equal(stream.states.at(-1), "lost: Run not found")
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(stream.reads.length, 4, "a lost stream stops trying")
  assert.equal(stream.connections.length, 2)
})

test("a stream that goes silent is treated as dropped, while heartbeats and events keep it open", async (t) => {
  mockTimers(t)
  const stream = follow(3, async () => run("failed", [event(5, "run.failed")]))
  stream.latest().on.open()
  t.mock.timers.tick(SILENCE_MS - 1)
  stream.latest().on.heartbeat()
  t.mock.timers.tick(SILENCE_MS - 1)
  stream.latest().send(4)
  t.mock.timers.tick(SILENCE_MS - 1)
  assert.deepEqual(stream.states, ["connecting", "live"], "a waiting run's stream stays open on heartbeats")
  assert.equal(stream.latest().closed, false)

  // Nothing more arrives: the connection looks open but is dead (e.g. behind a proxy whose backend died).
  t.mock.timers.tick(1)
  assert.equal(stream.latest().closed, true)
  assert.equal(stream.states.at(-1), "reconnecting")
  t.mock.timers.tick(1_000)
  await settle()
  assert.deepEqual(stream.reads, [4], "it catches up after the last event received")
  assert.equal(stream.states.at(-1), "ended", "a run that failed meanwhile is settled from the read")
})

test("stopping closes the stream, cancels a pending retry, and ignores a read that returns late", async (t) => {
  mockTimers(t)
  const waiting = follow(0, never)
  waiting.latest().on.error()
  waiting.stop()
  t.mock.timers.tick(10_000)
  assert.deepEqual(waiting.reads, [])

  let finish: (value: AgentRunWithEvents) => void = () => {}
  const reading = follow(0, () => new Promise((resolve) => (finish = resolve)))
  reading.latest().on.error()
  t.mock.timers.tick(1_000)
  await settle()
  assert.deepEqual(reading.reads, [0])
  reading.stop()
  finish(run("running", [event(1)]))
  await settle()
  assert.deepEqual(reading.caughtUp, [], "a read that returns after stopping is dropped")
  assert.equal(reading.connections.length, 1)

  const live = follow(0, never)
  live.stop()
  assert.equal(live.latest().closed, true)
})

test("reconnection waits grow from 1 s to at most 10 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(reconnectDelay), [1_000, 2_000, 4_000, 8_000, 10_000, 10_000])
})
