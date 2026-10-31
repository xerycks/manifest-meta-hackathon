import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import test from "node:test"

import { decodeAttachments, textSlice } from "../../src/agent/attachments.js"
import type { RunEvent } from "../../src/agent/contracts.js"
import { RunDeadline } from "../../src/agent/deadline.js"
import { demoScript } from "../../src/agent/demo-model.js"
import { RunEventBus } from "../../src/agent/event-bus.js"
import { AgentRunner } from "../../src/agent/runner.js"
import { scriptView } from "../../src/agent/scripted.js"
import { AgentService, type AgentServiceDeps } from "../../src/agent/service.js"
import { AppError } from "../../src/shared/http/errors.js"

const base64 = (text: string | Buffer) => Buffer.from(text).toString("base64")

test("text, CSV, Markdown, and JSON files are accepted by extension and decoded as UTF-8", () => {
  const [csv, notes] = decodeAttachments([
    { name: "sales.CSV", content: base64("\uFEFFmonth,total\n2026-09,12.50\n") },
    { name: "C:\\Users\\me\\notes.md", content: base64("# Notes — café") },
  ])
  assert.deepEqual(csv, {
    name: "sales.CSV",
    mediaType: "text/csv",
    sizeBytes: 26,
    content: "month,total\n2026-09,12.50\n",
  })
  assert.equal(notes?.name, "notes.md")
  assert.equal(notes?.mediaType, "text/markdown")
  assert.equal(notes?.sizeBytes, Buffer.byteLength("# Notes — café"))
})

test("other types, binary or non-UTF-8 content, empty files, and files over 256 KB are refused per file", () => {
  assert.throws(
    () =>
      decodeAttachments([
        { name: "fine.txt", content: base64("ok") },
        { name: "report.xlsx", content: base64("PK") },
        { name: "latin1.csv", content: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64") },
        { name: "image.txt", content: base64("GIF\u0000\u0001") },
        { name: "empty.csv", content: "" },
        { name: "huge.txt", content: base64("x".repeat(256 * 1024 + 1)) },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.status, 422)
      const problems = (error.details as { attachments: { index: number; message: string }[] }).attachments
      assert.deepEqual(
        problems.map((problem) => problem.index),
        [1, 2, 3, 4, 5],
      )
      assert.match(
        problems[0]?.message ?? "",
        /“report\.xlsx” is not a text or CSV file\. Attach \.csv, \.tsv/,
      )
      assert.match(problems[1]?.message ?? "", /not UTF-8 text/)
      assert.match(problems[2]?.message ?? "", /binary file/)
      assert.match(problems[3]?.message ?? "", /is empty/)
      assert.match(problems[4]?.message ?? "", /larger than 256 KB/)
      return true
    },
  )
})

test("file slices stay within their byte budget and never split a character", () => {
  const text = "ab€cd" // € is 3 bytes: a b [e2 82 ac] c d
  assert.deepEqual(textSlice(text, 0, 3), { text: "ab", offset: 0, nextOffset: 2 })
  assert.deepEqual(textSlice(text, 2, 3), { text: "€", offset: 2, nextOffset: 5 })
  // An offset inside a character moves on to the next whole one.
  assert.deepEqual(textSlice(text, 3, 10), { text: "cd", offset: 5, nextOffset: null })
  assert.deepEqual(textSlice(text, 50, 10), { text: "", offset: 7, nextOffset: null })
})

test("the run deadline pauses while waiting for the user and keeps the time that was left", async () => {
  const deadline = new RunDeadline(120, 1_000)
  await sleep(60)
  const left = deadline.pause()
  assert.ok(left > 0 && left <= 70, `about 60 ms of the run's time are left (${left})`)
  await sleep(150)
  assert.equal(deadline.signal.aborted, false, "waiting for the user does not use the run's time")
  deadline.resume()
  await sleep(100)
  assert.equal(deadline.signal.reason, "timeout")

  const waiting = new RunDeadline(10_000, 50)
  waiting.pause()
  await sleep(100)
  assert.equal(waiting.signal.reason, "answer_timeout")
  waiting.clear()
})

test("the event bus hands events to the streams following a run until they unsubscribe", () => {
  const bus = new RunEventBus()
  const seen: number[] = []
  const event = (seq: number) =>
    ({ seq, type: "run.cancelled", data: {}, createdAt: new Date().toISOString() }) as RunEvent
  const stop = bus.subscribe("run-1", (received) => seen.push(received.seq))
  bus.subscribe("run-2", () => assert.fail("another run's stream"))
  bus.publish("run-1", event(1))
  assert.equal(bus.followers("run-1"), 1)
  stop()
  bus.publish("run-1", event(2))
  assert.deepEqual(seen, [1])
  assert.equal(bus.followers("run-1"), 0)
})

test("a waiting run takes one answer, recorded before it goes on; a stopped run takes none", async () => {
  const runner = new AgentRunner()
  const log: string[] = []
  const controller = new AbortController()
  const reply = runner.waitForAnswer("run-1", controller.signal, async (answer) => {
    await sleep(10)
    log.push(`recorded ${answer}`)
  })
  assert.equal(await runner.answer("run-1", "By revenue"), true)
  assert.deepEqual(log, ["recorded By revenue"])
  assert.equal(await reply, "By revenue")
  assert.equal(await runner.answer("run-1", "Again"), false)

  const stopping = new AbortController()
  const stopped = runner.waitForAnswer("run-2", stopping.signal, async () => assert.fail("not recorded"))
  stopping.abort("cancelled")
  await assert.rejects(stopped, (reason: unknown) => reason === "cancelled")
  assert.equal(await runner.answer("run-2", "Too late"), false)
})

test("shutdown ends the event streams still open once the runs here have stopped", async () => {
  const runner = new AgentRunner()
  const log: string[] = []
  const slot = runner.claim({ runId: "run-1", workspaceId: "ws", userId: "user", conversationId: "chat" })
  assert.ok(!("busy" in slot))
  slot.start(async (signal) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve))
    log.push("run stopped")
  })
  runner.openStream("user", () => log.push("open stream ended"))
  const close = runner.openStream("user", () => log.push("closed stream ended"))
  close?.()
  assert.equal(runner.stopping, false)
  await runner.shutdown()
  assert.equal(runner.stopping, true)
  assert.deepEqual(log, ["run stopped", "open stream ended"])
})

test(
  "a stream sends a terminal event recorded after its replay was read; one opened during shutdown ends",
  async () => {
    const event = (seq: number, type: RunEvent["type"]) =>
      ({ seq, type, data: {}, createdAt: new Date().toISOString() }) as RunEvent
    let status = "cancelled"
    // The run ends between the replay and the status check, and its terminal event never comes live.
    const reads = [[event(1, "run.started")], [event(1, "run.started"), event(2, "run.cancelled")]]
    const runs = {
      getRun: async () => ({ status }),
      events: async (_workspaceId: string, _userId: string, _runId: string, after: number) =>
        (reads.shift() ?? []).filter((item) => item.seq > after),
    }
    const runner = new AgentRunner()
    const service = new AgentService({ runs, runner } as unknown as AgentServiceDeps)
    const follow = async () => {
      const seen = { sent: [] as number[], ended: 0 }
      await service.follow("ws", "user", "run-1", 0, {
        send: (item) => seen.sent.push(item.seq),
        end: () => (seen.ended += 1),
      })
      return seen
    }
    assert.deepEqual(await follow(), { sent: [1, 2], ended: 1 })
    assert.equal(runner.events.followers("run-1"), 0)

    status = "awaiting_input"
    reads.push([event(1, "run.started")])
    await runner.shutdown()
    assert.deepEqual(await follow(), { sent: [1], ended: 1 }, "caught up, then ended for the next process")
  },
)

test("the demo model asks which ranking “top customers” means, unless the question says", () => {
  const listed = {
    role: "tool" as const,
    results: [
      {
        callId: "call_1_1",
        content: JSON.stringify({ sources: [{ id: "c1", engine: "postgres", schemas: ["shop"] }] }),
        isError: false,
      },
    ],
  }
  const opening = [
    { role: "user" as const, text: "Who are our top customers?" },
    {
      role: "assistant" as const,
      text: "",
      toolCalls: [{ id: "call_1_1", name: "list_sources", input: {} }],
    },
    listed,
  ]
  const asking = demoScript(scriptView(opening))
  assert.equal(asking.calls?.[0]?.name, "ask_user")
  assert.deepEqual((asking.calls?.[0]?.input as { options: string[] }).options, [
    "By revenue",
    "By number of orders",
  ])

  const answered = [
    ...opening,
    { role: "assistant" as const, text: "", toolCalls: [{ id: "call_2_1", name: "ask_user", input: {} }] },
    {
      role: "tool" as const,
      results: [
        { callId: "call_2_1", content: JSON.stringify({ answer: "By number of orders" }), isError: false },
      ],
    },
    {
      role: "assistant" as const,
      text: "",
      toolCalls: [{ id: "call_3_1", name: "describe_object", input: {} }],
    },
    { role: "tool" as const, results: [{ callId: "call_3_1", content: "{}", isError: false }] },
  ]
  const query = demoScript(scriptView(answered)).calls?.[0]
  assert.equal(query?.name, "run_query")
  assert.match(JSON.stringify(query?.input), /ORDER BY orders DESC, revenue DESC/)

  const explicit = [
    { ...opening[0], text: "Top customers by revenue?" },
    opening[1],
    listed,
  ] as typeof opening
  assert.equal(demoScript(scriptView(explicit)).calls?.[0]?.name, "describe_object")
})
