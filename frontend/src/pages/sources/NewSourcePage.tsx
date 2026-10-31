import { ArrowLeft } from "lucide-react"
import { Link, useNavigate } from "react-router-dom"

import { managesWorkspace } from "@/app/organization-role.ts"
import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { ENGINE_TERMS } from "@/entities/connections/engine.ts"
import { ConnectionForm } from "@/features/manage-connections/ConnectionForm.tsx"
import { EmptyState, LoadingState } from "@/shared/ui/states.tsx"

export function NewSourcePage() {
  const session = useWorkspaceSession()
  const navigate = useNavigate()

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/sources"
          className="inline-flex items-center gap-1.5 rounded-md text-sm text-(--muted) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Sources
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Add a source</h1>
        <p className="mt-1 max-w-2xl leading-7 text-(--muted)">
          Connect PostgreSQL or MongoDB: enter the connection settings, test them, then choose which
          schemas or databases Manifest may read.
        </p>
      </div>

      {!session.workspaceId && <LoadingState label="Loading workspace…" />}
      {session.workspaceId && !managesWorkspace(session.workspaceRole) && (
        <EmptyState
          title="Only owners and admins can add sources"
          description="You can view this workspace's sources. Ask an owner or admin to connect a new one."
        />
      )}
      {session.workspaceId && managesWorkspace(session.workspaceRole) && (
        <ConnectionForm
          key={session.workspaceId}
          workspaceId={session.workspaceId}
          onSaved={(connection) =>
            navigate("/sources", {
              state: {
                notice: `Saved “${connection.name}”. Manifest is discovering its ${ENGINE_TERMS[connection.engine].objects} now.`,
              },
            })
          }
        />
      )}
    </div>
  )
}
