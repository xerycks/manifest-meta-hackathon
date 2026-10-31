import { ArrowLeft } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { managesWorkspace } from "@/app/organization-role.ts"
import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useConnection } from "@/entities/connections/api.ts"
import type { Connection } from "@/entities/connections/types.ts"
import type { ReadQuery } from "@/entities/queries/types.ts"
import { ConnectionCard } from "@/features/manage-connections/ConnectionCard.tsx"
import { ConnectionForm } from "@/features/manage-connections/ConnectionForm.tsx"
import { describeConnectionError } from "@/features/manage-connections/connection-form.ts"
import { QueryConsole } from "@/features/run-query/QueryConsole.tsx"
import { prefillFromQuery } from "@/features/saved-query/saved-query-form.ts"
import { SaveQueryButton } from "@/features/saved-query/SaveQueryButton.tsx"
import { ApiError } from "@/shared/api/client.ts"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

/** Owners and admins save the console's query as a saved query. */
const saveFromConsole =
  (workspaceId: string, connection: Connection) => (currentQuery: () => ReadQuery | null) => (
    <SaveQueryButton
      workspaceId={workspaceId}
      engine={connection.engine}
      sourceName={connection.name}
      prefill={() => prefillFromQuery(currentQuery(), connection.id)}
    />
  )

export function EditSourcePage() {
  const { connectionId = "" } = useParams()
  const session = useWorkspaceSession()
  const navigate = useNavigate()
  const canManage = managesWorkspace(session.workspaceRole)
  const connection = useConnection(session.workspaceId, connectionId)
  // Malformed ids fail validation; either way the source does not exist here.
  const notFound =
    connection.error instanceof ApiError &&
    (connection.error.status === 404 || connection.error.status === 422)

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
        <h1 className="mt-2 text-2xl font-semibold tracking-tight break-words">
          {connection.data ? connection.data.name : "Source"}
        </h1>
        {canManage && (
          <p className="mt-1 max-w-2xl leading-7 text-(--muted)">
            Changes to the connection settings, schemas, or databases are tested before they are
            saved.
          </p>
        )}
      </div>

      {(!session.workspaceId || connection.isPending) && <LoadingState label="Loading source…" />}
      {notFound && (
        <EmptyState
          title="Source not found"
          description="This source does not exist in the current workspace. It may have been removed, or it belongs to another workspace."
        />
      )}
      {connection.isError && !notFound && (
        <ErrorState
          title="Source unavailable"
          message={describeConnectionError(connection.error).message}
          onRetry={() => void connection.refetch()}
        />
      )}
      {connection.isSuccess && session.workspaceId && !canManage && (
        <>
          <p className="text-sm text-(--muted)">
            You can view this source. Owners and admins can edit, retest, or remove it.
          </p>
          <ConnectionCard
            connection={connection.data}
            workspaceId={session.workspaceId}
            canManage={false}
          />
        </>
      )}
      {connection.isSuccess && session.workspaceId && canManage && (
        <>
          <ConnectionForm
            key={connection.data.id}
            workspaceId={session.workspaceId}
            connection={connection.data}
            onSaved={(saved) => navigate("/sources", { state: { notice: `Saved “${saved.name}”.` } })}
          />
          <QueryConsole
            key={`console-${connection.data.id}`}
            workspaceId={session.workspaceId}
            connection={connection.data}
            saveAction={saveFromConsole(session.workspaceId, connection.data)}
          />
        </>
      )}
    </div>
  )
}
