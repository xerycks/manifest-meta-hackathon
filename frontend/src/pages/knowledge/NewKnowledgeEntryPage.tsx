import { ArrowLeft } from "lucide-react"
import { Link, useNavigate } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { KNOWLEDGE_HREF, knowledgeEntryHref } from "@/entities/knowledge/links.ts"
import { KnowledgeEntryForm } from "@/features/manage-knowledge/KnowledgeEntryForm.tsx"
import { LoadingState } from "@/shared/ui/states.tsx"

export function NewKnowledgeEntryPage() {
  const session = useWorkspaceSession()
  const navigate = useNavigate()

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link
          to={KNOWLEDGE_HREF}
          className="inline-flex items-center gap-1.5 rounded-md text-sm text-(--muted) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Knowledge base
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New entry</h1>
        <p className="mt-1 leading-7 text-(--muted)">
          Define a term once so questions and dashboards use it the same way. You can edit your own
          entries later; owners and admins can edit any.
        </p>
      </div>
      {session.workspaceId ? (
        <KnowledgeEntryForm
          workspaceId={session.workspaceId}
          entry={null}
          onSaved={(saved) =>
            navigate(knowledgeEntryHref(saved.id), { state: { notice: `Added “${saved.title}”.` } })
          }
          onCancel={() => navigate(KNOWLEDGE_HREF)}
        />
      ) : (
        <LoadingState label="Loading workspace…" />
      )}
    </div>
  )
}
