import type { TokenUsage } from "./contracts.js"

// The boundary between the agent harness and a model provider. Messages are
// provider-neutral; a provider may attach opaque content to its own turns
// (such as signed thinking blocks) that it needs replayed verbatim.

export interface ToolCall {
  id: string
  name: string
  /** As the model sent it; the harness validates it before running the tool. */
  input: unknown
}

export interface ToolResult {
  callId: string
  content: string
  isError: boolean
}

export type ModelMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant"
      text: string
      toolCalls: ToolCall[]
      /** The provider's own content for this turn, replayed as it was. */
      providerContent?: unknown
    }
  | { role: "tool"; results: ToolResult[] }

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema of an object. */
  inputSchema: Record<string, unknown>
}

/**
 * Why a turn ended: it asked for tools, it finished, it ran out of output
 * (or context), or the provider declined to answer.
 */
export type StopReason = "tool_use" | "end_turn" | "max_tokens" | "refusal"

export interface ModelTurnRequest {
  system: string
  messages: ModelMessage[]
  tools: ToolDefinition[]
  /** Aborting it stops the turn (and the provider's stream) at once. */
  signal: AbortSignal
  /** Called with text as it streams. */
  onText(delta: string): void
}

export interface ModelTurn {
  text: string
  toolCalls: ToolCall[]
  stopReason: StopReason
  usage: TokenUsage
  providerContent?: unknown
}

export interface ModelProvider {
  /** Stored on each run, e.g. "anthropic". */
  readonly provider: string
  readonly model: string
  turn(request: ModelTurnRequest): Promise<ModelTurn>
}

/** The provider failed the turn; the message is safe to show and never carries a key or prompt. */
export class ModelProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelProviderError"
  }
}

/** A tool call's input could not be parsed at all, so the turn has to be asked for again. */
export class UnparseableToolInput extends Error {
  constructor() {
    super("The model sent tool input that is not valid JSON.")
    this.name = "UnparseableToolInput"
  }
}
