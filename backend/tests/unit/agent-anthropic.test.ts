import assert from "node:assert/strict"
import test from "node:test"

import Anthropic from "@anthropic-ai/sdk"

import { AnthropicProvider, echoableContent } from "../../src/agent/anthropic.js"
import { ModelProviderError, UnparseableToolInput, type ModelMessage } from "../../src/agent/provider.js"

const API_KEY = "sk-ant-test-not-a-real-key"

interface Captured {
  url: string
  headers: Headers
  body: Record<string, unknown>
  signal: AbortSignal | null
}

function sse(events: Record<string, unknown>[]): string {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}

/** An SDK client whose fetch records each request and answers from `respond`, never the network. */
function stubbedClient(respond: (request: Captured) => Response): {
  client: Anthropic
  requests: Captured[]
} {
  const requests: Captured[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      signal: init?.signal ?? null,
    }
    requests.push(request)
    return respond(request)
  }
  const client = new Anthropic({ apiKey: API_KEY, baseURL: "http://anthropic.test", fetch, maxRetries: 0 })
  return { client, requests }
}

const streamed = (events: Record<string, unknown>[]) =>
  new Response(sse(events), { status: 200, headers: { "content-type": "text/event-stream" } })

const start = (usage: Record<string, number>) => ({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage,
  },
})

const TOOL_TURN = [
  start({
    input_tokens: 100,
    output_tokens: 1,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 300,
  }),
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking " } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "the orders table." } },
  { type: "content_block_stop", index: 1 },
  {
    type: "content_block_start",
    index: 2,
    content_block: { type: "tool_use", id: "toolu_1", name: "describe_object", input: {} },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '{"connectionId":"c1",' },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '"schema":"shop","name":"orders"}' },
  },
  { type: "content_block_stop", index: 2 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 57 },
  },
  { type: "message_stop" },
]

const tools = [
  {
    name: "describe_object",
    description: "Describe a table",
    inputSchema: {
      type: "object",
      properties: { connectionId: { type: "string" } },
      required: ["connectionId"],
    },
  },
]

const history: ModelMessage[] = [
  { role: "user", text: "How many orders?" },
  {
    role: "assistant",
    text: "Listing sources.",
    toolCalls: [{ id: "toolu_0", name: "list_sources", input: {} }],
    providerContent: [
      { type: "thinking", thinking: "", signature: "sig-0" },
      { type: "text", text: "Listing sources." },
      { type: "tool_use", id: "toolu_0", name: "list_sources", input: {} },
    ],
  },
  {
    role: "tool",
    results: [{ callId: "toolu_0", content: '{"sources":[]}', isError: false }],
  },
  { role: "assistant", text: "Earlier answer", toolCalls: [] },
  { role: "tool", results: [{ callId: "toolu_9", content: "Error: bad input", isError: true }] },
]

test("a streamed turn is requested with tools, adaptive thinking, caching, and fallbacks, and translated back", async () => {
  const { client, requests } = stubbedClient(() => streamed(TOOL_TURN))
  const provider = new AnthropicProvider("claude-opus-5-5", client)
  const deltas: string[] = []
  const turn = await provider.turn({
    system: "You are a test.",
    messages: history,
    tools,
    signal: new AbortController().signal,
    onText: (delta) => deltas.push(delta),
  })

  const [request] = requests
  assert.ok(request)
  assert.match(request.url, /^http:\/\/anthropic\.test\/v1\/messages/)
  // The key is sent as the SDK sends it, and only in its header.
  assert.ok(
    request.headers.get("x-api-key") === API_KEY ||
      request.headers.get("authorization") === `Bearer ${API_KEY}`,
  )
  assert.ok(!JSON.stringify(request.body).includes(API_KEY))
  assert.match(request.headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/)
  const body = request.body
  assert.equal(body.model, "claude-opus-5-5")
  assert.equal(body.stream, true)
  assert.equal(body.system, "You are a test.")
  assert.deepEqual(body.thinking, { type: "adaptive" })
  assert.deepEqual(body.output_config, { effort: "high" })
  assert.deepEqual(body.cache_control, { type: "ephemeral" })
  assert.equal(body.fallbacks, "default")
  assert.ok(typeof body.max_tokens === "number" && body.max_tokens >= 16_000)
  assert.ok(!("temperature" in body))
  assert.deepEqual(body.tools, [
    {
      name: "describe_object",
      description: "Describe a table",
      input_schema: tools[0]?.inputSchema,
      eager_input_streaming: true,
    },
  ])
  assert.deepEqual(body.messages, [
    { role: "user", content: "How many orders?" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-0" },
        { type: "text", text: "Listing sources." },
        { type: "tool_use", id: "toolu_0", name: "list_sources", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_0", content: '{"sources":[]}' }] },
    { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "Error: bad input", is_error: true }],
    },
  ])

  assert.deepEqual(deltas, ["Checking ", "the orders table."])
  assert.equal(turn.text, "Checking the orders table.")
  assert.equal(turn.stopReason, "tool_use")
  assert.deepEqual(turn.toolCalls, [
    { id: "toolu_1", name: "describe_object", input: { connectionId: "c1", schema: "shop", name: "orders" } },
  ])
  assert.deepEqual(turn.usage, { inputTokens: 420, outputTokens: 57 })
  // The signed thinking block is kept so the next request can replay it unchanged.
  const content = JSON.parse(JSON.stringify(turn.providerContent)) as Record<string, unknown>[]
  assert.deepEqual(content[0], { type: "thinking", thinking: "", signature: "sig-1" })
  assert.equal(content.length, 3)
})

test("models without server-side fallbacks are asked without them; stop reasons map to the boundary", async () => {
  const cases: [string, string][] = [
    ["end_turn", "end_turn"],
    ["max_tokens", "max_tokens"],
    ["model_context_window_exceeded", "max_tokens"],
    ["refusal", "refusal"],
    ["pause_turn", "end_turn"],
  ]
  for (const [reason, expected] of cases) {
    const { client, requests } = stubbedClient(() =>
      streamed([
        start({ input_tokens: 5, output_tokens: 1 }),
        {
          type: "message_delta",
          delta: { stop_reason: reason, stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: "message_stop" },
      ]),
    )
    const turn = await new AnthropicProvider("claude-haiku-5-5", client).turn({
      system: "s",
      messages: [{ role: "user", text: "q" }],
      tools: [],
      signal: new AbortController().signal,
      onText: () => {},
    })
    assert.equal(turn.stopReason, expected, reason)
    assert.equal(turn.text, "")
    assert.ok(!("fallbacks" in (requests[0]?.body ?? {})))
    assert.equal(requests[0]?.headers.get("anthropic-beta"), null)
  }
})

test("API failures become safe provider errors that never echo the key", async () => {
  const cases: [number, RegExp][] = [
    [401, /rejected the configured API key/],
    [404, /AGENT_MODEL/],
    [429, /rate limiting/],
    [529, /temporarily unavailable/],
    [400, /refused the request \(HTTP 400\)/],
  ]
  const logged: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "))
  try {
    for (const [status, message] of cases) {
      const { client } = stubbedClient(
        () =>
          new Response(
            JSON.stringify({ type: "error", error: { type: "error", message: `failure ${status}` } }),
            {
              status,
              headers: { "content-type": "application/json" },
            },
          ),
      )
      await assert.rejects(
        new AnthropicProvider("claude-opus-5-5", client).turn({
          system: "s",
          messages: [{ role: "user", text: "q" }],
          tools: [],
          signal: new AbortController().signal,
          onText: () => {},
        }),
        (error: unknown) => {
          assert.ok(error instanceof ModelProviderError, String(error))
          assert.match(error.message, message)
          assert.ok(!error.message.includes(API_KEY))
          return true
        },
      )
    }
  } finally {
    console.error = original
  }
  assert.ok(logged.length > 0 && logged.every((line) => !line.includes(API_KEY)))
})

test("an error the API streams partway through is a safe, retryable provider error", async () => {
  const { client } = stubbedClient(() =>
    streamed([
      start({ input_tokens: 5, output_tokens: 1 }),
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ]),
  )
  const original = console.error
  console.error = () => {}
  try {
    await assert.rejects(
      new AnthropicProvider("claude-opus-5-5", client).turn({
        system: "s",
        messages: [{ role: "user", text: "q" }],
        tools: [],
        signal: new AbortController().signal,
        onText: () => {},
      }),
      (error: unknown) => error instanceof ModelProviderError && /temporarily unavailable/.test(error.message),
    )
  } finally {
    console.error = original
  }
})

test("a turn that came back without content is left out of later requests", async () => {
  const { client, requests } = stubbedClient(() => streamed(TOOL_TURN))
  await new AnthropicProvider("claude-opus-5-5", client).turn({
    system: "s",
    messages: [
      { role: "user", text: "q" },
      { role: "assistant", text: "", toolCalls: [], providerContent: [] },
      { role: "user", text: "Finish by calling submit_answer." },
    ],
    tools: [],
    signal: new AbortController().signal,
    onText: () => {},
  })
  assert.deepEqual(requests[0]?.body.messages, [
    { role: "user", content: "q" },
    { role: "user", content: "Finish by calling submit_answer." },
  ])
})

test("tool input that is not JSON is reported as unparseable, and an aborted turn rejects", async () => {
  const broken = [
    start({ input_tokens: 5, output_tokens: 1 }),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t", name: "run_query", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"purpose": "a" "b"}' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ]
  const { client } = stubbedClient(() => streamed(broken))
  const request = {
    system: "s",
    messages: [{ role: "user" as const, text: "q" }],
    tools: [],
    signal: new AbortController().signal,
    onText: () => {},
  }
  await assert.rejects(new AnthropicProvider("claude-opus-5-5", client).turn(request), UnparseableToolInput)

  const aborted = new AbortController()
  aborted.abort("cancelled")
  const { client: idle } = stubbedClient(() => streamed(TOOL_TURN))
  await assert.rejects(
    new AnthropicProvider("claude-opus-5-5", idle).turn({ ...request, signal: aborted.signal }),
    (error: unknown) => !(error instanceof ModelProviderError),
  )

  // A stream that stops sending is ended by the abort, mid-turn, as fetch ends its body.
  const midway = new AbortController()
  const { client: stalled } = stubbedClient(
    ({ signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse(TOOL_TURN.slice(0, 6))))
            signal?.addEventListener("abort", () => controller.error(signal.reason))
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  )
  await assert.rejects(
    new AnthropicProvider("claude-opus-5-5", stalled).turn({
      ...request,
      signal: midway.signal,
      onText: () => midway.abort("cancelled"),
    }),
    (error: unknown) => !(error instanceof ModelProviderError),
  )
})

test("after a mid-output fallback, the declined part keeps only its text", () => {
  const content = [
    { type: "thinking", thinking: "", signature: "a" },
    { type: "text", text: "Partial " },
    { type: "tool_use", id: "t1", name: "run_query", input: {} },
    { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } },
    { type: "text", text: "continued" },
    { type: "tool_use", id: "t2", name: "list_sources", input: {} },
  ] as unknown as Anthropic.Beta.BetaContentBlock[]
  assert.deepEqual(
    echoableContent(content).map((block) => block.type),
    ["text", "fallback", "text", "tool_use"],
  )
  const plain = content.filter((block) => block.type !== "fallback")
  assert.equal(echoableContent(plain), plain)
})
