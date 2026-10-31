import assert from "node:assert/strict"
import test from "node:test"

import { z } from "zod"

import type { AgentAnswer, AgentToolName, RunEventType } from "../../src/agent/contracts.js"
import {
  MAX_TOOL_CALLS_PER_TURN,
  NUDGE,
  runHarness,
  RunFailure,
  storedTranscript,
  type HarnessProgress,
} from "../../src/agent/harness.js"
import {
  UnparseableToolInput,
  type ModelMessage,
  type ModelProvider,
  type ModelTurn,
} from "../../src/agent/provider.js"
import { ScriptedProvider, scriptView, type Script } from "../../src/agent/scripted.js"
import { ToolError, type AgentTool, type ToolContext } from "../../src/agent/tools.js"

const ANSWER: AgentAnswer = { markdown: "42 orders.", status: "complete", missing: [], evidence: [] }

/** A tool with a zod input that records its calls and answers with `run`. */
function fakeTool(
  name: AgentToolName,
  input: z.ZodType,
  run: (value: unknown, context: ToolContext) => Promise<unknown> | unknown,
  log: string[] = [],
): AgentTool {
  return {
    name,
    definition: { name, description: name, inputSchema: { type: "object" } },
    prepare(raw) {
      const parsed = input.safeParse(raw)
      if (!parsed.success) return { error: `Invalid input for ${name}` }
      return {
        summary: `Running ${name}`,
        async run(context) {
          log.push(name)
          const output = await run(parsed.data, context)
          return name === "submit_answer"
            ? { output: { accepted: true }, summary: "Answer submitted", answer: output as AgentAnswer }
            : { output, summary: "done" }
        },
      }
    },
  }
}

function setup(script: Script | ModelProvider, options: { maxSteps?: number; signal?: AbortSignal } = {}) {
  const events: { type: RunEventType; data: unknown }[] = []
  const log: string[] = []
  const messages: ModelMessage[] = [{ role: "user", text: "How many orders?" }]
  const progress: HarnessProgress = { steps: 0, usage: { inputTokens: 0, outputTokens: 0 } }
  const signal = options.signal ?? new AbortController().signal
  const tools = [
    fakeTool("list_sources", z.object({}), () => ({ sources: ["demo"] }), log),
    fakeTool(
      "run_query",
      z.object({ sql: z.string() }),
      (value) => {
        if ((value as { sql: string }).sql.startsWith("DELETE"))
          throw new ToolError("QUERY_REJECTED: no writes", "exec-1")
        return { rows: [[42]] }
      },
      log,
    ),
    fakeTool("submit_answer", z.object({ markdown: z.string() }), () => ANSWER, log),
  ]
  const provider = typeof script === "function" ? new ScriptedProvider("test", script) : script
  const run = () =>
    runHarness(
      {
        provider,
        system: "system",
        messages,
        tools,
        context: { workspaceId: "w", userId: "u", scope: null, signal, executions: new Map() },
        maxSteps: options.maxSteps ?? 12,
        signal,
        emit: (type, data) => events.push({ type, data }),
      },
      progress,
    )
  return { run, events, log, messages, progress }
}

const submit = { name: "submit_answer", input: { markdown: "42 orders." } }

test("invalid input, unknown tools, and tool errors go back to the model, which recovers", async () => {
  const { run, events, messages, progress } = setup((view) => {
    if (view.turn === 0) {
      return {
        text: "Trying a few things. ",
        calls: [
          { name: "run_query", input: { sql: 42 } },
          { name: "drop_table", input: {} },
          { name: "run_query", input: { sql: "DELETE FROM orders" } },
        ],
      }
    }
    assert.deepEqual(
      view.results.slice(0, 3).map((result) => [result.name, result.ok]),
      [
        ["run_query", false],
        ["drop_table", false],
        ["run_query", false],
      ],
    )
    assert.match(String(view.results[1]?.output), /Unknown tool "drop_table"/)
    assert.match(String(view.results[2]?.output), /QUERY_REJECTED/)
    if (view.turn === 1) return { calls: [{ name: "run_query", input: { sql: "SELECT 42" } }] }
    return { calls: [submit] }
  })
  assert.deepEqual(await run(), ANSWER)
  assert.equal(progress.steps, 3)
  assert.equal(messages.length, 7)
  const finished = events.filter((event) => event.type === "tool.finished").map((event) => event.data)
  assert.deepEqual(
    finished.map((data) => (data as { ok: boolean }).ok),
    [false, false, false, true, true],
  )
  assert.equal((finished[2] as { executionId?: string }).executionId, "exec-1")
  assert.deepEqual(events[0], { type: "answer.delta", data: { text: "Trying a few things. " } })
})

test("a turn without tool calls is reminded to submit", async () => {
  const { run, messages } = setup((view) =>
    view.turn === 0 ? { text: "There are 42 orders." } : { calls: [submit] },
  )
  assert.deepEqual(await run(), ANSWER)
  assert.deepEqual(messages[2], { role: "user", text: NUDGE })
})

test("the step limit, a refusal, and truncated output fail the run with a clear error", async () => {
  const looping = setup(() => ({ calls: [{ name: "list_sources", input: {} }] }), { maxSteps: 3 })
  await assert.rejects(looping.run(), (error: unknown) => {
    assert.ok(error instanceof RunFailure)
    assert.equal(error.code, "AGENT_STEP_LIMIT")
    assert.match(error.message, /within 3 steps/)
    return true
  })
  assert.equal(looping.progress.steps, 3)
  assert.deepEqual(looping.log, ["list_sources", "list_sources", "list_sources"])

  const refused = setup(() => ({ stopReason: "refusal" }))
  await assert.rejects(
    refused.run(),
    (error: unknown) => error instanceof RunFailure && error.code === "AGENT_REFUSED",
  )

  const cut = setup(() => ({ calls: [submit], stopReason: "max_tokens" }))
  await assert.rejects(
    cut.run(),
    (error: unknown) => error instanceof RunFailure && error.code === "AGENT_OUTPUT_LIMIT",
  )
  assert.deepEqual(cut.log, [], "a cut-off tool call never runs")
})

test("unparseable tool input is asked for again, a bounded number of times", async () => {
  const flaky = (failures: number): ModelProvider => {
    let calls = 0
    return {
      provider: "test",
      model: "flaky",
      async turn(): Promise<ModelTurn> {
        calls += 1
        if (calls <= failures) throw new UnparseableToolInput()
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "submit_answer", input: { markdown: "42 orders." } }],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
        }
      },
    }
  }
  const recovers = setup(flaky(2))
  assert.deepEqual(await recovers.run(), ANSWER)
  assert.equal(recovers.progress.steps, 3)
  assert.deepEqual(recovers.progress.usage, { inputTokens: 10, outputTokens: 5 })

  const gives = setup(flaky(3))
  await assert.rejects(
    gives.run(),
    (error: unknown) => error instanceof RunFailure && error.code === "AGENT_PROVIDER_ERROR",
  )
})

test("a turn runs a bounded number of calls, and submit_answer after the others", async () => {
  const calls = [
    submit,
    ...Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 2 }, () => ({ name: "list_sources", input: {} })),
  ]
  const { run, log, messages } = setup(() => ({ calls }))
  assert.deepEqual(await run(), ANSWER)
  assert.equal(log.length, MAX_TOOL_CALLS_PER_TURN)
  assert.equal(log.at(-1), "submit_answer")
  const results = messages.at(-1)
  assert.ok(results?.role === "tool")
  assert.equal(results.results.length, calls.length)
  assert.equal(results.results[0]?.isError, false)
  assert.deepEqual(
    results.results.slice(-3).map((result) => result.content.startsWith("Error: Too many tool calls")),
    [true, true, true],
  )
})

test("aborting stops the run with the abort reason", async () => {
  const controller = new AbortController()
  const { run } = setup(
    () => {
      controller.abort("cancelled")
      return { calls: [{ name: "list_sources", input: {} }] }
    },
    { signal: controller.signal },
  )
  await assert.rejects(run(), (error: unknown) => error === "cancelled")
})

test("the script view separates earlier turns from this run's tool outcomes", () => {
  const view = scriptView([
    { role: "user", text: "First question" },
    { role: "assistant", text: "First answer", toolCalls: [] },
    { role: "user", text: "Follow-up" },
    { role: "assistant", text: "", toolCalls: [{ id: "a", name: "list_sources", input: {} }] },
    { role: "tool", results: [{ callId: "a", content: '{"sources":[]}', isError: false }] },
    { role: "assistant", text: "Done?", toolCalls: [] },
    { role: "user", text: NUDGE },
  ])
  assert.equal(view.question, "Follow-up")
  assert.deepEqual(view.history, [{ question: "First question", answer: "First answer" }])
  assert.equal(view.turn, 2)
  assert.deepEqual(view.last("list_sources"), {
    name: "list_sources",
    input: {},
    ok: true,
    output: { sources: [] },
  })
})

test("the stored transcript drops the oldest tool results first to stay within its bound", () => {
  const big = "x".repeat(4_000)
  const messages: ModelMessage[] = [
    { role: "user", text: "q" },
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "a", name: "run_query", input: {} }],
      providerContent: [{ type: "thinking" }],
    },
    { role: "tool", results: [{ callId: "a", content: big, isError: false }] },
    { role: "assistant", text: "", toolCalls: [{ id: "b", name: "run_query", input: {} }] },
    { role: "tool", results: [{ callId: "b", content: big, isError: false }] },
  ]
  const stored = storedTranscript(messages, 6_000)
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) <= 6_000)
  assert.ok(stored[2]?.role === "tool" && stored[2].results[0]?.content !== big)
  assert.ok(stored[4]?.role === "tool" && stored[4].results[0]?.content === big)
  assert.ok(
    messages[2]?.role === "tool" && messages[2].results[0]?.content === big,
    "the live transcript is unchanged",
  )
  assert.deepEqual(storedTranscript(messages), messages)
  assert.deepEqual(storedTranscript(messages, 10), [])
})
