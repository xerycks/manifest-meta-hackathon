import { ApiError } from "../../shared/api/client.ts"
import type { ExecutionRecord, ExecutionStatus } from "./types.ts"

export const STATUS_LABELS: Record<
  ExecutionStatus,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" }
> = {
  running: { label: "Running", tone: "neutral" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  timed_out: { label: "Timed out", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  rejected: { label: "Not allowed", tone: "danger" },
}

export interface OutcomeNotice {
  title: string
  message: string
}

/** What to tell the user about a run that did not succeed, or null when it did. */
export function describeOutcome(record: Pick<ExecutionRecord, "status" | "error">): OutcomeNotice | null {
  const message = record.error?.message ?? "The query did not finish."
  switch (record.status) {
    case "succeeded":
    case "running":
      return null
    case "rejected":
      return { title: "Query not allowed", message }
    case "timed_out":
      return { title: "Query timed out", message }
    case "cancelled":
      return { title: "Query cancelled", message }
    case "failed":
      if (record.error?.code === "SOURCE_CONNECTION_FAILED") {
        return { title: "Could not reach the source", message }
      }
      if (record.error?.code === "QUERY_INTERRUPTED") return { title: "Query interrupted", message }
      return { title: "Query failed", message }
  }
}

function issueMessages(details: unknown): string[] {
  const issues = (details as { issues?: unknown } | null)?.issues
  if (!Array.isArray(issues)) return []
  return issues.flatMap((issue: unknown) => {
    const message = (issue as { message?: unknown } | null)?.message
    return typeof message === "string" ? [message] : []
  })
}

/** A request that failed before the query ran: refused, too busy, malformed, or unreachable. */
export function describeRunError(error: unknown): OutcomeNotice {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "QUERY_REJECTED":
        return { title: "Query not allowed", message: error.message }
      case "QUERY_BUSY":
        return { title: "Too many queries running", message: error.message }
      case "INVALID_PARAMETERS":
        return { title: "Check the parameters", message: error.message }
      case "VALIDATION_FAILED": {
        const messages = issueMessages(error.details)
        return { title: "Check the query", message: messages.length > 0 ? messages.join(" ") : error.message }
      }
      default:
        return { title: "Could not run the query", message: error.message }
    }
  }
  return {
    title: "Could not run the query",
    message: error instanceof Error ? error.message : "Something went wrong. Please try again.",
  }
}
