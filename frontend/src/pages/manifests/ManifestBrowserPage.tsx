import { ArrowLeft } from "lucide-react"
import { useState } from "react"
import { Link, useParams } from "react-router-dom"

import { managesWorkspace } from "@/app/organization-role.ts"
import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useConnection } from "@/entities/connections/api.ts"
import { useLatestRefresh, useManifest, useManifestObject } from "@/entities/manifests/api.ts"
import { isRefreshActive } from "@/entities/manifests/refresh-state.ts"
import { errorMessage, isNotFound } from "@/features/browse-manifest/manifest-view.ts"
import { ObjectDetail } from "@/features/browse-manifest/ObjectDetail.tsx"
import { ObjectList } from "@/features/browse-manifest/ObjectList.tsx"
import { RefreshPanel } from "@/features/refresh-manifest/RefreshPanel.tsx"
import { cn } from "@/shared/lib/cn.ts"
import { useDebouncedValue } from "@/shared/lib/use-debounced-value.ts"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

/** Detail pane for the object in the URL. */
function ObjectPane({
  workspaceId,
  connectionId,
  objectId,
}: {
  workspaceId: string
  connectionId: string
  objectId: string
}) {
  const object = useManifestObject(workspaceId, connectionId, objectId)
  if (object.isPending) return <LoadingState label="Loading table…" />
  if (isNotFound(object.error)) {
    return (
      <EmptyState
        title="Not in this manifest"
        description="This table or view does not belong to this source. Choose one from the list."
      />
    )
  }
  if (object.isError) {
    return (
      <ErrorState
        title="Table unavailable"
        message={errorMessage(object.error)}
        onRetry={() => void object.refetch()}
      />
    )
  }
  return <ObjectDetail connectionId={connectionId} detail={object.data} />
}

/**
 * One source's manifest: refresh status and controls, its schemas and objects
 * (searchable), and the selected object's detail. Serves /manifests/:connectionId
 * and /manifests/:connectionId/objects/:objectId, keeping the search between them.
 */
export function ManifestBrowserPage() {
  const { connectionId = "", objectId } = useParams()
  // A different source starts with a fresh search and refresh state.
  return <ManifestBrowser key={connectionId} connectionId={connectionId} objectId={objectId} />
}

function ManifestBrowser({
  connectionId,
  objectId,
}: {
  connectionId: string
  objectId: string | undefined
}) {
  const session = useWorkspaceSession()
  const workspaceId = session.workspaceId
  const canManage = managesWorkspace(session.workspaceRole)
  const [searchInput, setSearchInput] = useState("")
  const search = useDebouncedValue(searchInput.trim(), 250)

  const connection = useConnection(workspaceId, connectionId)
  const manifest = useManifest(workspaceId, connectionId, search)
  const latest = useLatestRefresh(workspaceId, connectionId)
  const sourceMissing = isNotFound(connection.error)
  const data = manifest.data
  const undiscovered =
    data !== undefined &&
    data.lastPublished === null &&
    !search &&
    data.schemas.every((schema) => schema.objects.length === 0)

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/manifests"
          className="inline-flex items-center gap-1.5 rounded-md text-sm text-(--muted) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Manifests
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight break-words">
          {connection.data?.name ?? "Manifest"}
        </h1>
        {connection.data && (
          <p className="mt-1 text-sm break-words text-(--muted)">
            Database {connection.data.config.database} · schemas{" "}
            {connection.data.schemas.join(", ")}
          </p>
        )}
      </div>

      {(!workspaceId || connection.isPending) && <LoadingState label="Loading source…" />}
      {sourceMissing && (
        <EmptyState
          title="Source not found"
          description="This source does not exist in the current workspace. It may have been removed, or it belongs to another workspace."
          action={
            <Link to="/manifests" className="text-sm font-medium text-(--accent) hover:underline">
              Choose another source
            </Link>
          }
        />
      )}
      {connection.isError && !sourceMissing && (
        <ErrorState
          title="Source unavailable"
          message={errorMessage(connection.error)}
          onRetry={() => void connection.refetch()}
        />
      )}

      {workspaceId && connection.isSuccess && (
        <>
          <RefreshPanel
            workspaceId={workspaceId}
            connectionId={connectionId}
            canManage={canManage}
            lastPublished={data?.lastPublished ?? null}
          />

          {manifest.isPending && <LoadingState label="Loading manifest…" />}
          {manifest.isError && (
            <ErrorState
              title="Manifest unavailable"
              message={errorMessage(manifest.error)}
              onRetry={() => void manifest.refetch()}
            />
          )}
          {undiscovered && (
            <EmptyState
              title="Not discovered yet"
              description={
                isRefreshActive(latest.data)
                  ? "Manifest is reading this source's catalog now. Its tables appear here when the refresh finishes."
                  : canManage
                    ? "Refresh the metadata to read this source's tables, views, columns, and relationships."
                    : "Its tables appear here once an owner or admin refreshes the metadata."
              }
            />
          )}
          {data && !undiscovered && (
            <div className="grid gap-6 lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)]">
              <div className="lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto lg:p-1">
                <ObjectList
                  connectionId={connectionId}
                  manifest={data}
                  search={searchInput}
                  onSearchChange={setSearchInput}
                  searching={manifest.isPlaceholderData || search !== searchInput.trim()}
                />
              </div>
              {/* On narrow screens the chosen object comes first. */}
              <div className={cn("min-w-0", objectId && "order-first lg:order-none")}>
                {objectId ? (
                  <ObjectPane
                    key={objectId}
                    workspaceId={workspaceId}
                    connectionId={connectionId}
                    objectId={objectId}
                  />
                ) : (
                  <p className="rounded-lg border border-dashed border-(--border) px-6 py-12 text-center text-sm text-(--muted)">
                    Choose a table or view to see its columns, keys, and relationships.
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
