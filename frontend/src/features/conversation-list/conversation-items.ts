import type { ConversationPage, ConversationSummary } from "../../entities/agent/types.ts"

export interface StatusBadge {
  label: string
  tone: "neutral" | "warning" | "danger"
}

/** How a conversation's latest question stands, when it needs attention; nothing for answered or stopped ones. */
export function conversationBadge(
  item: Pick<ConversationSummary, "status" | "pendingClarification">,
): StatusBadge | null {
  if (item.pendingClarification || item.status === "awaiting_input") {
    return { label: "Needs your answer", tone: "warning" }
  }
  switch (item.status) {
    case "queued":
    case "running":
      return { label: "Running", tone: "neutral" }
    case "failed":
      return { label: "Failed", tone: "danger" }
    case "interrupted":
      return { label: "Interrupted", tone: "warning" }
    default:
      return null
  }
}

/**
 * The loaded pages as one list. A conversation that moved up while pages were
 * read (a question was asked in it) is listed once, where it was read first.
 */
export function listedConversations(pages: ConversationPage[]): ConversationSummary[] {
  const seen = new Set<string>()
  return pages
    .flatMap((page) => page.conversations)
    .filter((item) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
}
