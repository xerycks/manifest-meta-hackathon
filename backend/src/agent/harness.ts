import type { AgentAnswer, RunEventData, RunEventType, TokenUsage } from "./contracts.js"
import {
  UnparseableToolInput,
  type ModelMessage,
  type ModelProvider,
  type ToolCall,
  type ToolResult,
} from "./provider.js"
import { ToolError, type AgentTool, type ToolContext } from "./tools.js"

/** Sent when the model ends a turn without calling a tool. */
export const NUDGE =
  'Finish by calling submit_answer with your answer and the executions that support it. If the data cannot answer the question, submit what you found with status "partial" and list what is missing.'

/** Tool calls one turn may make; later ones get an error result instead of running. */
export const MAX_TOOL_CALLS_PER_TURN = 8
/** Tool calls of one turn that run at the same time. */
const TOOL_CONCURRENCY = 2
/** A turn whose tool input is not JSON is asked for again this many times in a row. */
const UNPARSEABLE_RETRIES = 2
/** Streamed text is recorded in pieces of about this many characters, up to a total per run. */
const DELTA_CHARS = 160
const STREAMED_CHARS = 100_000
/** The stored transcript stays below this many bytes of JSON. */
const TRANSCRIPT_BYTES = 1_000_000
const OMITTED = "[omitted from the stored transcript]"

/** The run cannot finish; the message is safe to show. */
export class RunFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "RunFailure"
  }
}

export type EmitEvent = <T extends RunEventType>(type: T, data: RunEventData[T]) => void

export interface HarnessInput {
  provider: ModelProvider
  system: string
  /** The conversation so far; turns and tool results are appended to it. */
  messages: ModelMessage[]
  tools: AgentTool[]
  context: ToolContext
  maxSteps: number
  /** Aborting it stops the model turn and any running tool. */
  signal: AbortSignal
  emit: EmitEvent
}

/** Updated as the run goes, so a failed run still records what it used. */
export interface HarnessProgress {
  steps: number
  usage: TokenUsage
}

interface CallOutcome {
  result: ToolResult
  answer?: AgentAnswer
}

const short = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Runs `task` over `items`, at most `limit` at a time. A failure stops the
 * queue but lets running tasks settle first, then rejects with it.
 */
async function eachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      try {
        await task(item)
      } catch (error) {
        queue.length = 0
        throw error
      }
    }
  })
  const failure = (await Promise.allSettled(workers)).find((outcome) => outcome.status === "rejected")
  if (failure) throw failure.reason
}

async function executeCall(input: HarnessInput, call: ToolCall): Promise<CallOutcome> {
  const { context, emit } = input
  const name = short(call.name, 60)
  const tool = input.tools.find((candidate) => candidate.name === call.name)
  const available = input.tools.map((entry) => entry.name).join(", ")
  const prepared = tool
    ? tool.prepare(call.input)
    : { error: `Unknown tool "${name}". Available tools: ${available}.` }
  emit("tool.started", {
    callId: call.id,
    tool: name,
    summary: "summary" in prepared ? prepared.summary : `Calling ${name}`,
  })
  const failed = (message: string, executionId?: string): CallOutcome => {
    emit("tool.finished", {
      callId: call.id,
      tool: name,
      ok: false,
      summary: short(message),
      ...(executionId ? { executionId } : {}),
    })
    return { result: { callId: call.id, content: `Error: ${message}`, isError: true } }
  }
  if ("error" in prepared) return failed(prepared.error)
  try {
    const success = await prepared.run(context)
    emit("tool.finished", {
      callId: call.id,
      tool: name,
      ok: true,
      summary: success.summary,
      ...(success.executionId ? { executionId: success.executionId } : {}),
    })
    return {
      result: { callId: call.id, content: JSON.stringify(success.output), isError: false },
      ...(success.answer ? { answer: success.answer } : {}),
    }
  } catch (error) {
    if (context.signal.aborted) throw error
    if (error instanceof ToolError) return failed(error.message, error.executionId)
    console.error(`Agent tool ${name} failed unexpectedly`, error)
    return failed(`${name} failed unexpectedly. Try again, or continue without it.`)
  }
}

/**
 * Runs the turn's tool calls (a bounded number, a few at a time) and returns
 * their results in call order. submit_answer runs after the others, so the
 * run ends only once they are done; the first accepted answer wins.
 */
async function executeCalls(
  input: HarnessInput,
  calls: ToolCall[],
): Promise<{ results: ToolResult[]; answer?: AgentAnswer }> {
  const allowed = calls.slice(0, MAX_TOOL_CALLS_PER_TURN)
  const outcomes = new Map<string, ToolResult>()
  await eachLimited(
    allowed.filter((call) => call.name !== "submit_answer"),
    TOOL_CONCURRENCY,
    async (call) => {
      outcomes.set(call.id, (await executeCall(input, call)).result)
    },
  )
  let answer: AgentAnswer | undefined
  for (const call of allowed.filter((entry) => entry.name === "submit_answer")) {
    if (answer) {
      outcomes.set(call.id, {
        callId: call.id,
        content: "Error: An answer was already submitted.",
        isError: true,
      })
      continue
    }
    const outcome = await executeCall(input, call)
    outcomes.set(call.id, outcome.result)
    answer = outcome.answer
  }
  const results = calls.map(
    (call) =>
      outcomes.get(call.id) ?? {
        callId: call.id,
        content: `Error: Too many tool calls in one turn (at most ${MAX_TOOL_CALLS_PER_TURN}). Make this call again in your next turn.`,
        isError: true,
      },
  )
  return answer ? { results, answer } : { results }
}

/**
 * The agent loop: a model turn, then its tool calls, then the results back to
 * the model, until it submits an answer. Bounded by the step limit and the
 * signal (cancel, deadline, shutdown), which rejects with the abort reason.
 * Problems a tool reports go back to the model; only the limits, provider
 * failures, refusals, and truncated output fail the run (with RunFailure or
 * ModelProviderError).
 */
export async function runHarness(input: HarnessInput, progress: HarnessProgress): Promise<AgentAnswer> {
  const { provider, messages, signal, emit } = input
  const tools = input.tools.map((tool) => tool.definition)
  let unparseable = 0
  let streamed = 0
  while (progress.steps < input.maxSteps) {
    signal.throwIfAborted()
    progress.steps += 1
    let pending = ""
    const flush = () => {
      if (pending) emit("answer.delta", { text: pending })
      pending = ""
    }
    const onText = (delta: string) => {
      const kept = delta.slice(0, Math.max(0, STREAMED_CHARS - streamed))
      streamed += kept.length
      pending += kept
      if (pending.length >= DELTA_CHARS) flush()
    }
    let turn
    try {
      turn = await provider.turn({ system: input.system, messages, tools, signal, onText })
    } catch (error) {
      flush()
      if (!(error instanceof UnparseableToolInput) || signal.aborted) throw error
      if (unparseable >= UNPARSEABLE_RETRIES) {
        throw new RunFailure(
          "AGENT_PROVIDER_ERROR",
          "The model repeatedly sent tool input that is not valid JSON.",
        )
      }
      unparseable += 1
      continue
    }
    flush()
    unparseable = 0
    progress.usage = {
      inputTokens: progress.usage.inputTokens + turn.usage.inputTokens,
      outputTokens: progress.usage.outputTokens + turn.usage.outputTokens,
    }
    if (turn.stopReason === "refusal") {
      throw new RunFailure("AGENT_REFUSED", "The model declined to answer this question.")
    }
    if (turn.stopReason === "max_tokens") {
      // A tool call cut off mid-input must not run.
      throw new RunFailure(
        "AGENT_OUTPUT_LIMIT",
        "The model's response was cut off at its length limit before it finished. Try a narrower question.",
      )
    }
    messages.push({
      role: "assistant",
      text: turn.text,
      toolCalls: turn.toolCalls,
      ...(turn.providerContent !== undefined ? { providerContent: turn.providerContent } : {}),
    })
    if (turn.toolCalls.length === 0) {
      messages.push({ role: "user", text: NUDGE })
      continue
    }
    const { results, answer } = await executeCalls(input, turn.toolCalls)
    messages.push({ role: "tool", results })
    if (answer) return answer
  }
  throw new RunFailure(
    "AGENT_STEP_LIMIT",
    `The question was not answered within ${input.maxSteps} steps. Try a narrower question, or ask it in parts.`,
  )
}

/**
 * The transcript as stored with the run, within a byte bound: from the oldest
 * on, tool results are dropped first, then the provider's own content of
 * assistant turns. A transcript that still does not fit is not stored.
 */
export function storedTranscript(messages: ModelMessage[], maxBytes = TRANSCRIPT_BYTES): ModelMessage[] {
  const stored = structuredClone(messages)
  const fits = () => Buffer.byteLength(JSON.stringify(stored)) <= maxBytes
  for (const message of stored) {
    if (fits()) return stored
    if (message.role === "tool") for (const result of message.results) result.content = OMITTED
  }
  for (const message of stored) {
    if (fits()) return stored
    if (message.role === "assistant") delete message.providerContent
  }
  return fits() ? stored : []
}
