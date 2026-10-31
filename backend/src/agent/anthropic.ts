import Anthropic from "@anthropic-ai/sdk"

import {
  ModelProviderError,
  UnparseableToolInput,
  type ModelMessage,
  type ModelProvider,
  type ModelTurn,
  type ModelTurnRequest,
  type StopReason,
  type ToolDefinition,
} from "./provider.js"

type ContentBlock = Anthropic.Beta.BetaContentBlock
type MessageParam = Anthropic.Beta.BetaMessageParam

/** Thinking counts toward this; streaming keeps large values within request timeouts. */
const MAX_OUTPUT_TOKENS = 64_000

/**
 * Models that accept server-side refusal fallbacks in their "default" form:
 * a declined turn is re-run on the model Anthropic recommends for it.
 */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"])
const FALLBACK_BETA = "server-side-fallback-2026-07-01"

function toMessage(message: ModelMessage): MessageParam {
  if (message.role === "user") return { role: "user", content: message.text }
  if (message.role === "tool") {
    return {
      role: "user",
      content: message.results.map((result) => ({
        type: "tool_result",
        tool_use_id: result.callId,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      })),
    }
  }
  if (Array.isArray(message.providerContent)) {
    return { role: "assistant", content: message.providerContent as ContentBlock[] }
  }
  return {
    role: "assistant",
    content: [
      ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
      ...message.toolCalls.map((call) => ({
        type: "tool_use" as const,
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    ],
  }
}

/**
 * The API rejects an assistant message without content, which a model turn
 * can occasionally be; such turns are left out every time, so the history
 * stays append-only.
 */
function toMessages(messages: ModelMessage[]): MessageParam[] {
  return messages
    .map(toMessage)
    .filter((message) => message.role !== "assistant" || message.content.length > 0)
}

function toTool(tool: ToolDefinition): Anthropic.Beta.BetaTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    // Inputs stream as they are generated; the harness validates every one.
    eager_input_streaming: true,
  }
}

/**
 * The content to send back for a turn. After a fallback mid-output, the
 * declined part before the last fallback block keeps only its text: its
 * thinking and tool calls are not part of the continued answer.
 */
export function echoableContent(content: ContentBlock[]): ContentBlock[] {
  const boundary = content.findLastIndex((block) => block.type === "fallback")
  if (boundary < 0) return content
  return content.filter((block, index) => index >= boundary || block.type === "text")
}

function stopReason(reason: Anthropic.Beta.BetaStopReason | null): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use"
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens"
    case "refusal":
      return "refusal"
    default:
      return "end_turn"
  }
}

/** A safe message for a provider failure; the API's own text stays in the server log. */
function providerFailure(error: InstanceType<typeof Anthropic.APIError>): ModelProviderError {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ModelProviderError("The model provider rejected the configured API key (ANTHROPIC_API_KEY).")
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ModelProviderError("The configured model (AGENT_MODEL) is not available to this API key.")
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ModelProviderError("The model provider is rate limiting requests. Try again in a minute.")
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelProviderError("The model provider could not be reached. Try again shortly.")
  }
  // No status: the API reported an error (such as overloaded) partway through the stream.
  if (error.status === undefined || error.status >= 500) {
    return new ModelProviderError("The model provider is temporarily unavailable. Try again shortly.")
  }
  return new ModelProviderError(`The model provider refused the request (HTTP ${error.status}).`)
}

/** Claude through the Anthropic Messages API, streamed. */
export class AnthropicProvider implements ModelProvider {
  readonly provider = "anthropic"

  constructor(
    readonly model: string,
    private readonly client: Anthropic,
  ) {}

  async turn(request: ModelTurnRequest): Promise<ModelTurn> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: request.system,
        messages: toMessages(request.messages),
        tools: request.tools.map(toTool),
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        // The growing conversation is resent every turn; cache its prefix.
        cache_control: { type: "ephemeral" },
        ...(FALLBACK_MODELS.has(this.model) ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      },
      { signal: request.signal },
    )
    stream.on("text", (delta) => request.onText(delta))

    let message: Anthropic.Beta.BetaMessage
    try {
      message = await stream.finalMessage()
    } catch (error) {
      if (request.signal.aborted) throw error
      if (error instanceof Anthropic.APIError) {
        console.error(
          `Model provider request failed (${error.status ?? "no status"}): ${error.message.slice(0, 300)}`,
        )
        throw providerFailure(error)
      }
      // Tool input that is not JSON at all fails while the stream is read; the
      // SDK reports it as its own (non-API) error.
      if (error instanceof SyntaxError || error instanceof Anthropic.AnthropicError)
        throw new UnparseableToolInput()
      throw error
    }

    const content = echoableContent(message.content)
    const usage = message.usage
    return {
      text: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
      toolCalls: content.flatMap((block) =>
        block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : [],
      ),
      stopReason: stopReason(message.stop_reason),
      usage: {
        // Cached and uncached prompt tokens together: what the turn read.
        inputTokens:
          usage.input_tokens +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
      },
      providerContent: content,
    }
  }
}
