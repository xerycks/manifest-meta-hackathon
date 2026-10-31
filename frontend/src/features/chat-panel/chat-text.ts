import type { AgentRun, RunStatus } from "../../entities/agent/types.ts"
import { ApiError } from "../../shared/api/client.ts"

/** Which model answered; the scripted demo model is always marked synthetic. */
export function modelLabel(run: Pick<AgentRun, "provider" | "model">): string {
  if (run.provider !== "scripted" || /synthetic/i.test(run.model)) return run.model
  return `${run.model} (synthetic)`
}

export interface Notice {
  title: string
  message: string
}

function validationMessages(details: unknown): string[] {
  const value = details as { issues?: unknown; attachments?: unknown } | null
  const entries = [value?.issues, value?.attachments].flatMap((list) => (Array.isArray(list) ? list : []))
  return entries.flatMap((entry: unknown) => {
    const message = (entry as { message?: unknown } | null)?.message
    return typeof message === "string" ? [message] : []
  })
}

/** Why a question, answer, or stop request was not accepted; the user's input is kept. */
export function describeAskError(error: unknown, action = "ask the question"): Notice {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "AGENT_BUSY":
        return { title: "Too many questions at once", message: error.message }
      case "CONFLICT":
        return { title: `Could not ${action}`, message: error.message }
      case "AGENT_NOT_CONFIGURED":
        return { title: "Asking is not set up", message: error.message }
      case "VALIDATION_FAILED": {
        const messages = [...new Set(validationMessages(error.details))]
        return {
          title: "Check your question",
          message: messages.length > 0 ? messages.join(" ") : error.message,
        }
      }
      default:
        return { title: `Could not ${action}`, message: error.message }
    }
  }
  return {
    title: `Could not ${action}`,
    message: error instanceof Error ? error.message : "Something went wrong. Please try again.",
  }
}

/** Markdown as one plain line: link text kept, table rules and markers dropped. */
function plainLine(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, " ")
    .replace(/[#*_`|>~]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim()
}

/** A short line for screen readers when a run reaches a new state. */
export function announcement(status: RunStatus, answer: string | null): string | null {
  switch (status) {
    case "awaiting_input":
      return "The question needs your answer to continue."
    case "completed":
      return `Answer ready: ${plainLine(answer ?? "").slice(0, 200)}`
    case "failed":
      return "The question could not be answered."
    case "cancelled":
      return "The question was stopped."
    default:
      return null
  }
}
