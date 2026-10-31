import { ChevronRight, Database } from "lucide-react"
import { Link } from "react-router-dom"

import { managesWorkspace } from "@/app/organization-role.ts"
import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useConnections } from "@/entities/connections/api.ts"
import { errorMessage } from "@/features/browse-manifest/manifest-view.ts"
import { buttonVariants } from "@/shared/ui/button.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

/** Choose a source to browse its discovered schemas, tables, and columns. */
export function ManifestsPage() {
  const session = useWorkspaceSession()
  const connections = useConnections(session.workspaceId)
  const canManage = managesWorkspace(session.workspaceRole)

  return (
    <div className="space-y-6">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Manifests</h1>
        <p className="mt-1 leading-7 text-(--muted)">
          The tables, views, columns, and relationships Manifest discovered in each source. Choose a
          source to browse it.
        </p>
      </div>

      {(!session.workspaceId || connections.isPending) && (
        <LoadingState label="Loading sources…" />
      )}
      {connections.isError && (
        <ErrorState
          title="Sources unavailable"
          message={errorMessage(connections.error)}
          onRetry={() => void connections.refetch()}
        />
      )}
      {connections.isSuccess && connections.data.length === 0 && (
        <EmptyState
          title="No sources yet"
          description={
            canManage
              ? "Connect a database first. Manifest discovers its tables and columns as soon as it is saved."
              : "No one has connected a source to this workspace yet. Ask an owner or admin to add one."
          }
          action={
            <Link to="/sources" className={buttonVariants({ variant: canManage ? "primary" : "secondary" })}>
              {canManage ? "Add a source" : "Go to Sources"}
            </Link>
          }
        />
      )}
      {connections.isSuccess && connections.data.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {connections.data.map((connection) => (
            <li key={connection.id}>
              <Link
                to={`/manifests/${connection.id}`}
                className="flex h-full items-center gap-3 rounded-lg border border-(--border) bg-white p-4 hover:bg-(--surface) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
              >
                <Database aria-hidden className="size-5 shrink-0 text-(--muted)" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium break-words">{connection.name}</span>
                  <span className="block text-sm break-words text-(--muted)">
                    {connection.config.database} · {connection.schemas.join(", ")}
                  </span>
                </span>
                <ChevronRight aria-hidden className="size-4 shrink-0 text-(--muted)" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
