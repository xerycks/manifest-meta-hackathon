import { setTimeout as sleep } from "node:timers/promises"

import { NUDGE } from "./harness.js"
import type { ModelMessage, ModelProvider, ModelTurn, ModelTurnRequest, StopReason } from "./provider.js"

export interface ScriptedCall {
  name: string
  input: unknown
}

export interface ScriptedTurn {
  text?: string
  calls?: ScriptedCall[]
  /** Defaults to tool_use with calls, end_turn without. */
  stopReason?: StopReason
  /** Waits this long first (abortably), like a slow model. */
  delayMs?: number
}

/** A tool call of this run and what came back: parsed JSON when it succeeded, the error text otherwise. */
export interface ToolOutcome {
  name: string
  input: unknown
  ok: boolean
  output: unknown
}

/** What a script sees of the conversation so far. */
export interface ScriptView {
  question: string
  /** Earlier questions of the conversation and the answers given. */
  history: { question: string; answer: string }[]
  /** Model turns already taken in this run. */
  turn: number
  results: ToolOutcome[]
  /** The latest outcome of a tool, if it was called. */
  last(name: string): ToolOutcome | undefined
}

export type Script = (view: ScriptView) => ScriptedTurn

function parsed(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

/**
 * The run's question is the last user message that is not the harness's
 * reminder to submit; anything before it is the earlier conversation.
 */
export function scriptView(messages: ModelMessage[]): ScriptView {
  const questionAt = messages.findLastIndex((message) => message.role === "user" && message.text !== NUDGE)
  const question = messages[questionAt]
  const history: ScriptView["history"] = []
  for (let index = 0; index < questionAt - 1; index += 1) {
    const [asked, answered] = [messages[index], messages[index + 1]]
    if (asked?.role === "user" && answered?.role === "assistant") {
      history.push({ question: asked.text, answer: answered.text })
    }
  }
  const run = messages.slice(questionAt + 1)
  const results: ToolOutcome[] = []
  for (const [index, message] of run.entries()) {
    if (message.role !== "assistant") continue
    const next = run[index + 1]
    for (const call of message.toolCalls) {
      const result =
        next?.role === "tool" ? next.results.find((entry) => entry.callId === call.id) : undefined
      if (!result) continue
      results.push({
        name: call.name,
        input: call.input,
        ok: !result.isError,
        output: result.isError ? result.content : parsed(result.content),
      })
    }
  }
  return {
    question: question?.role === "user" ? question.text : "",
    history,
    turn: run.filter((message) => message.role === "assistant").length,
    results,
    last: (name) => results.findLast((result) => result.name === name),
  }
}

/**
 * Replays a deterministic script of tool calls and answers in place of a
 * model: for tests, and for the labeled local demo model.
 */
export class ScriptedProvider implements ModelProvider {
  readonly provider = "scripted"

  constructor(
    readonly model: string,
    private readonly script: Script,
  ) {}

  async turn(request: ModelTurnRequest): Promise<ModelTurn> {
    request.signal.throwIfAborted()
    const view = scriptView(request.messages)
    const next = this.script(view)
    if (next.delayMs) await sleep(next.delayMs, undefined, { signal: request.signal })
    const text = next.text ?? ""
    for (let start = 0; start < text.length; start += 40) request.onText(text.slice(start, start + 40))
    const toolCalls = (next.calls ?? []).map((call, index) => ({
      id: `call_${view.turn + 1}_${index + 1}`,
      name: call.name,
      input: call.input,
    }))
    return {
      text,
      toolCalls,
      stopReason: next.stopReason ?? (toolCalls.length > 0 ? "tool_use" : "end_turn"),
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }
}
