import assert from "node:assert/strict"
import test from "node:test"

import { AnthropicProvider } from "../../src/agent/anthropic.js"
import { agentLimits, createModelProvider } from "../../src/agent/config.js"
import { amount, DEMO_MODEL, demoScript } from "../../src/agent/demo-model.js"
import { AgentRunner } from "../../src/agent/runner.js"
import { scriptView } from "../../src/agent/scripted.js"
import { createAgentTools, type ToolServices } from "../../src/agent/tools.js"
import { loadEnv } from "../../src/config/env.js"
import { jsonbText } from "../../src/shared/postgres/json.js"

const SESSION_SECRET = "production-session-secret-at-least-32-chars"

test("agent configuration defaults, and a provider only when one is usable", () => {
  const env = loadEnv({})
  assert.equal(env.AGENT_PROVIDER, "anthropic")
  assert.equal(env.AGENT_MODEL, "claude-opus-5-5")
  assert.deepEqual(agentLimits(env), { maxSteps: 12, runTimeoutMs: 300_000, answerTimeoutMs: 1_800_000 })
  assert.equal(createModelProvider(env), null, "no key, no provider")

  const keyed = createModelProvider(
    loadEnv({ ANTHROPIC_API_KEY: "sk-ant-test", AGENT_MODEL: "claude-sonnet-5-5" }),
  )
  assert.ok(keyed instanceof AnthropicProvider)
  assert.equal(keyed.model, "claude-sonnet-5-5")

  const demo = createModelProvider(loadEnv({ AGENT_PROVIDER: "scripted" }))
  assert.equal(demo?.provider, "scripted")
  assert.equal(demo?.model, DEMO_MODEL)

  assert.deepEqual(
    agentLimits(
      loadEnv({ AGENT_MAX_STEPS: "3", AGENT_RUN_TIMEOUT_MS: "5000", AGENT_ANSWER_TIMEOUT_MS: "60000" }),
    ),
    { maxSteps: 3, runTimeoutMs: 5_000, answerTimeoutMs: 60_000 },
  )
  assert.throws(() => loadEnv({ AGENT_MAX_STEPS: "0" }), /AGENT_MAX_STEPS/)
  assert.throws(() => loadEnv({ AGENT_ANSWER_TIMEOUT_MS: "10" }), /AGENT_ANSWER_TIMEOUT_MS/)
  assert.throws(() => loadEnv({ AGENT_PROVIDER: "openai" }), /AGENT_PROVIDER/)
})

test("the scripted demo model is refused in production, and the key is never echoed", () => {
  assert.throws(
    () => loadEnv({ NODE_ENV: "production", SESSION_SECRET, AGENT_PROVIDER: "scripted" }),
    /AGENT_PROVIDER: the scripted demo model is not allowed in production/,
  )
  assert.throws(
    () => loadEnv({ ANTHROPIC_API_KEY: "", AGENT_MAX_STEPS: "x" }),
    (error: unknown) => error instanceof Error && /ANTHROPIC_API_KEY/.test(error.message),
  )
})

/** A task that runs until aborted and records why. */
function blocking(log: string[], name: string) {
  return (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const stop = () => {
        log.push(`${name}:${String(signal.reason)}`)
        resolve()
      }
      if (signal.aborted) stop()
      else signal.addEventListener("abort", stop)
    })
}

test("the runner admits one run per conversation, two per user, five per workspace", async () => {
  const runner = new AgentRunner()
  const log: string[] = []
  const claim = (runId: string, userId: string, conversationId: string, workspaceId = "w1") => {
    const slot = runner.claim({ runId, workspaceId, userId, conversationId })
    if ("busy" in slot) return slot.busy
    slot.start(blocking(log, runId))
    return "started"
  }
  assert.equal(claim("r1", "u1", "c1"), "started")
  assert.equal(claim("r2", "u1", "c1"), "conversation")
  assert.equal(claim("r3", "u1", "c2"), "started")
  assert.equal(claim("r4", "u1", "c3"), "user")
  assert.equal(claim("r4b", "u1", "c4", "w2"), "user", "the user limit spans workspaces")
  assert.equal(claim("r5", "u2", "c5"), "started")
  assert.equal(claim("r6", "u3", "c6"), "started")
  assert.equal(claim("r7", "u3", "c7"), "started")
  assert.equal(claim("r8", "u4", "c8"), "workspace")
  assert.equal(claim("r9", "u4", "c9", "w2"), "started")

  const released = runner.claim({ runId: "r10", workspaceId: "w2", userId: "u5", conversationId: "c10" })
  assert.ok(!("busy" in released))
  released.release()

  assert.equal(await runner.cancel("r1"), true)
  assert.deepEqual(log, ["r1:cancelled"])
  assert.equal(await runner.cancel("r1"), false)
  assert.equal(claim("r11", "u1", "c1"), "started", "the conversation is free again")

  await runner.shutdown()
  assert.ok(log.includes("r9:shutdown") && log.includes("r11:shutdown"))
  const late = runner.claim({ runId: "r12", workspaceId: "w3", userId: "u9", conversationId: "c12" })
  assert.ok(!("busy" in late))
  late.start(blocking(log, "r12"))
  await runner.shutdown()
  assert.ok(log.includes("r12:shutdown"), "runs started during shutdown begin aborted")
})

test("jsonb text replaces escaped NUL characters but keeps a literal backslash-u0000", () => {
  assert.equal(jsonbText({ a: "x\u0000y" }), '{"a":"x\\ufffdy"}')
  assert.equal(jsonbText({ a: "\\u0000" }), '{"a":"\\\\u0000"}')
  assert.equal(jsonbText({ a: "\\\u0000" }), '{"a":"\\\\\\ufffd"}')
  assert.deepEqual(JSON.parse(jsonbText({ a: ["ok", 1, null] })), { a: ["ok", 1, null] })
})

test("the demo model formats exact amounts and admits what it cannot answer", () => {
  assert.equal(amount("1234567.50"), "1,234,567.50")
  assert.equal(amount(-9876), "-9,876")
  assert.equal(amount("2026-10"), "2026-10")
  assert.equal(amount(null), "—")

  const unsupported = demoScript(scriptView([{ role: "user", text: "Which customers churned?" }]))
  const call = unsupported.calls?.[0]
  assert.equal(call?.name, "submit_answer")
  const input = call?.input as { markdown: string; status: string }
  assert.equal(input.status, "partial")
  assert.match(input.markdown, /scripted demo model \(synthetic\)/)

  const first = demoScript(scriptView([{ role: "user", text: "What was net revenue by month?" }]))
  assert.equal(first.calls?.[0]?.name, "list_sources")
})

test("run_query takes a query as written, without positional parameter values", () => {
  const runQuery = createAgentTools({} as ToolServices).find((tool) => tool.name === "run_query")
  assert.ok(runQuery)
  assert.ok(!JSON.stringify(runQuery.definition.inputSchema).includes("params"))
  const input = (query: Record<string, unknown>) => ({
    connectionId: "6f1d1c6e-8f3e-4f0e-9f1a-2b3c4d5e6f70",
    purpose: "Orders by status",
    query: { language: "sql", ...query },
  })
  assert.ok(!("error" in runQuery.prepare(input({ sql: "SELECT status FROM orders" }))))
  const prepared = runQuery.prepare(input({ sql: "SELECT * FROM orders WHERE status = $1", params: ["open"] }))
  assert.ok("error" in prepared)
  assert.match(prepared.error, /params/)
})
