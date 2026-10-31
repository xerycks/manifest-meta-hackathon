import { List, SquarePen } from "lucide-react"
import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { ChatPanel } from "@/features/chat-panel/ChatPanel.tsx"
import type { EvidenceAction } from "@/features/chat-panel/RunTurn.tsx"
import { ConversationList } from "@/features/conversation-list/ConversationList.tsx"
import { prefillFromEvidence } from "@/features/saved-query/saved-query-form.ts"
import { SaveQueryButton } from "@/features/saved-query/SaveQueryButton.tsx"
import { cn } from "@/shared/lib/cn.ts"
import { Button, buttonVariants } from "@/shared/ui/button.tsx"
import { LoadingState } from "@/shared/ui/states.tsx"

const LIST_ID = "ask-conversations"

/** Evidence from a source that still exists can become a saved query. */
const saveEvidence =
  (workspaceId: string): EvidenceAction =>
  (item, { runId, sourceName }) =>
    sourceName ? (
      <SaveQueryButton
        workspaceId={workspaceId}
        engine={item.query.language === "sql" ? "postgres" : "mongodb"}
        sourceName={sourceName}
        prefill={() => prefillFromEvidence(item, runId)}
      />
    ) : null

/**
 * Ask questions of the workspace's data; /ask starts a conversation,
 * /ask/:conversationId continues one. The conversation list is a sidebar on
 * wide screens and opens on request on narrow ones.
 */
export function AskPage() {
  const { conversationId = null } = useParams()
  const session = useWorkspaceSession()
  const navigate = useNavigate()
  const [listOpen, setListOpen] = useState(false)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ask</h1>
          <p className="mt-1 max-w-2xl leading-7 text-(--muted)">
            Every answer shows the queries that produced it, so you can check the numbers.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            className="lg:hidden"
            aria-expanded={listOpen}
            aria-controls={LIST_ID}
            onClick={() => setListOpen((open) => !open)}
          >
            <List aria-hidden className="size-4" />
            Conversations
          </Button>
          {conversationId && (
            <Link to="/ask" className={buttonVariants({ variant: "secondary" })}>
              <SquarePen aria-hidden className="size-4" />
              New conversation
            </Link>
          )}
        </div>
      </div>
      {session.workspaceId ? (
        <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-8">
          <nav
            id={LIST_ID}
            aria-label="Conversations"
            className={cn(
              "mb-6 rounded-lg border border-(--border) p-2 lg:sticky lg:top-6 lg:mb-0 lg:block lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto lg:border-0 lg:p-0",
              !listOpen && "hidden",
            )}
          >
            <ConversationList
              // A different workspace is a different set of conversations.
              key={session.workspaceId}
              workspaceId={session.workspaceId}
              currentId={conversationId}
              onNavigate={() => setListOpen(false)}
              onDeleted={(id) => {
                if (id === conversationId) navigate("/ask", { replace: true })
              }}
            />
          </nav>
          <div className="min-w-0">
            <ChatPanel
              key={session.workspaceId}
              workspaceId={session.workspaceId}
              conversationId={conversationId}
              onConversationStarted={(id) => navigate(`/ask/${id}`, { replace: true })}
              evidenceAction={saveEvidence(session.workspaceId)}
            />
          </div>
        </div>
      ) : (
        <LoadingState label="Loading workspace…" />
      )}
    </div>
  )
}
