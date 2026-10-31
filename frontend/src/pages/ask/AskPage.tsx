import { SquarePen } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { ChatPanel } from "@/features/chat-panel/ChatPanel.tsx"
import { buttonVariants } from "@/shared/ui/button.tsx"
import { LoadingState } from "@/shared/ui/states.tsx"

/** Ask questions of the workspace's data; /ask starts a conversation, /ask/:conversationId continues one. */
export function AskPage() {
  const { conversationId = null } = useParams()
  const session = useWorkspaceSession()
  const navigate = useNavigate()

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ask</h1>
          <p className="mt-1 max-w-2xl leading-7 text-(--muted)">
            Every answer shows the queries that produced it, so you can check the numbers.
          </p>
        </div>
        {conversationId && (
          <Link to="/ask" className={buttonVariants({ variant: "secondary" })}>
            <SquarePen aria-hidden className="size-4" />
            New conversation
          </Link>
        )}
      </div>
      {session.workspaceId ? (
        <ChatPanel
          // A different workspace is a different set of conversations.
          key={session.workspaceId}
          workspaceId={session.workspaceId}
          conversationId={conversationId}
          onConversationStarted={(id) => navigate(`/ask/${id}`, { replace: true })}
        />
      ) : (
        <LoadingState label="Loading workspace…" />
      )}
    </div>
  )
}
