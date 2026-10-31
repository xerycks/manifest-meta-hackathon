import { BookMarked, ChevronRight } from "lucide-react"
import { Link } from "react-router-dom"

import { managesWorkspace } from "@/app/organization-role.ts"
import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useConnections } from "@/entities/connections/api.ts"
import { ENGINE_LABELS } from "@/entities/connections/engine.ts"
import { EngineIcon } from "@/entities/connections/EngineIcon.tsx"
import { KNOWLEDGE_HREF } from "@/entities/knowledge/links.ts"
import { errorMessage } from "@/features/browse-manifest/manifest-view.ts"
import { ManifestSearch } from "@/features/search-manifests/ManifestSearch.tsx"
import { buttonVariants } from "@/shared/ui/button.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

/**
 * Search across every source and the knowledge base, or choose a source to
 * browse and document its schemas, tables, and columns.
 */
export function ManifestsPage() {
  const session = useWorkspaceSession()
  const connections = useConnections(session.workspaceId)
  const canManage = managesWorkspace(session.workspaceRole)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight">Manifests</h1>
          <p className="mt-1 leading-7 text-(--muted)">
            The tables, collections, columns, fields, and relationships in each source, and what they
            mean. Choose a source to browse and describe it.
          </p>
        </div>
        <Link to={KNOWLEDGE_HREF} className={buttonVariants({ variant: "secondary" })}>
          <BookMarked aria-hidden className="size-4" />
          Knowledge base
        </Link>
      </div>

      <ManifestSearch workspaceId={session.workspaceId} />

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
                <EngineIcon engine={connection.engine} className="size-5 text-(--muted)" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium break-words">{connection.name}</span>
                  <span className="block text-sm break-words text-(--muted)">
                    {ENGINE_LABELS[connection.engine]} ·{" "}
                    {connection.engine === "postgres"
                      ? `${connection.config.database} · ${connection.schemas.join(", ")}`
                      : connection.schemas.join(", ")}
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
