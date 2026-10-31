import { Plus } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"

import { managesWorkspace } from "@/app/organization-role.ts"
import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useConnections } from "@/entities/connections/api.ts"
import { ConnectionCard } from "@/features/manage-connections/ConnectionCard.tsx"
import { describeConnectionError } from "@/features/manage-connections/connection-form.ts"
import { buttonVariants } from "@/shared/ui/button.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

export function SourcesPage() {
  const session = useWorkspaceSession()
  const canManage = managesWorkspace(session.workspaceRole)
  const connections = useConnections(session.workspaceId)
  const location = useLocation()
  const navigate = useNavigate()
  const heading = useRef<HTMLHeadingElement>(null)
  const [notice, setNotice] = useState(() => (location.state as { notice?: string } | null)?.notice)

  useEffect(() => {
    // Show a save confirmation once; reloading the page should not repeat it.
    if (location.state) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  const addSource = canManage && (
    <Link to="/sources/new" className={buttonVariants()}>
      <Plus aria-hidden className="size-4" />
      Add source
    </Link>
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">
            Sources
          </h1>
          <p className="mt-1 leading-7 text-(--muted)">
            PostgreSQL and MongoDB databases this workspace analyses. Passwords and connection strings
            are encrypted on the server and never shown again.
            {session.workspaceRole && !canManage && " Owners and admins add, edit, and remove sources."}
          </p>
        </div>
        {addSource}
      </div>

      {notice && (
        <p role="status" className="text-sm text-(--success)">
          {notice}
        </p>
      )}

      {(!session.workspaceId || connections.isPending) && <LoadingState label="Loading sources…" />}
      {connections.isError && (
        <ErrorState
          title="Sources unavailable"
          message={describeConnectionError(connections.error).message}
          onRetry={() => void connections.refetch()}
        />
      )}
      {connections.isSuccess && connections.data.length === 0 && (
        <EmptyState
          title="No sources connected"
          description={
            canManage
              ? "Connect a PostgreSQL or MongoDB database to start documenting and asking questions about it."
              : "No one has connected a source to this workspace yet. Ask an owner or admin to add one."
          }
          action={addSource || undefined}
        />
      )}
      {connections.isSuccess && session.workspaceId && connections.data.length > 0 && (
        <ul className="space-y-4">
          {connections.data.map((connection) => (
            <li key={connection.id}>
              <ConnectionCard
                connection={connection}
                workspaceId={session.workspaceId as string}
                canManage={canManage}
                onRemoved={(removed) => {
                  // The removed card took keyboard focus with it; continue from the page heading.
                  setNotice(`Removed “${removed.name}”.`)
                  heading.current?.focus()
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
