import { RefreshCw, Square } from "lucide-react"

import {
  useCancelRefresh,
  useLatestRefresh,
  useStartRefresh,
} from "@/entities/manifests/api.ts"
import type { ConnectionEngine } from "@/entities/connections/types.ts"
import { isRefreshActive } from "@/entities/manifests/refresh-state.ts"
import type { ManifestRefresh } from "@/entities/manifests/types.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Button } from "@/shared/ui/button.tsx"
import { Card } from "@/shared/ui/card.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"

import { describeChanges, describeCounts, refreshProgress } from "./refresh-summary.ts"

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {formatRelativeTime(iso)}
    </time>
  )
}

/** Where the shown metadata comes from, for notices about a refresh that did not publish. */
function StillShowing({ lastPublished }: { lastPublished: ManifestRefresh | null }) {
  if (!lastPublished?.finishedAt) return null
  return (
    <p className="mt-1 leading-6">
      Showing the metadata from the last successful refresh (
      <When iso={lastPublished.finishedAt} />
      ).
    </p>
  )
}

/**
 * Refresh status for one source: live progress while a refresh runs (polled),
 * when the shown metadata was published, and why the last refresh did not
 * finish. Owners and admins can start and cancel refreshes.
 */
export function RefreshPanel({
  workspaceId,
  connectionId,
  engine,
  canManage,
  lastPublished,
}: {
  workspaceId: string
  connectionId: string
  engine: ConnectionEngine
  canManage: boolean
  lastPublished: ManifestRefresh | null
}) {
  const latest = useLatestRefresh(workspaceId, connectionId)
  const start = useStartRefresh(workspaceId, connectionId)
  const cancel = useCancelRefresh(workspaceId, connectionId)
  const refresh = latest.data ?? null
  const active = isRefreshActive(refresh)
  const progress = refresh && active ? refreshProgress(refresh, engine) : null
  const actionError = start.error ?? cancel.error
  const counts = lastPublished?.counts ?? null
  const changes = counts ? describeChanges(counts, engine) : null

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 text-sm">
          {progress ? (
            <>
              <p role="status" className="flex items-center gap-2 font-medium">
                <span
                  aria-hidden
                  className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-(--border) border-t-(--accent) motion-reduce:animate-none"
                />
                Refreshing metadata: {progress.label}…
              </p>
              {progress.detail && <p className="mt-1 text-(--muted)">{progress.detail}</p>}
              {progress.max !== null && progress.value !== null && (
                <progress
                  className="mt-2 h-1.5 w-full max-w-md overflow-hidden rounded-full accent-(--accent)"
                  value={progress.value}
                  max={progress.max}
                  aria-label="Refresh progress"
                />
              )}
            </>
          ) : lastPublished?.finishedAt ? (
            <>
              <p className="font-medium">
                Last refreshed <When iso={lastPublished.finishedAt} />
              </p>
              {counts && (
                <p className="mt-1 text-(--muted)">
                  {describeCounts(counts, engine)}
                  {changes && ` · ${changes}`}
                </p>
              )}
            </>
          ) : (
            <p className="font-medium">
              {latest.isPending ? "Checking refresh status…" : "Not refreshed yet"}
            </p>
          )}
        </div>

        {canManage &&
          (active && refresh ? (
            <Button
              variant="secondary"
              onClick={() => {
                start.reset()
                cancel.mutate(refresh.id)
              }}
              disabled={cancel.isPending}
            >
              <Square aria-hidden className="size-4" />
              {cancel.isPending ? "Cancelling…" : "Cancel refresh"}
            </Button>
          ) : (
            <Button
              onClick={() => {
                cancel.reset()
                start.mutate()
              }}
              disabled={start.isPending || latest.isPending}
            >
              <RefreshCw aria-hidden className="size-4" />
              {start.isPending ? "Starting…" : "Refresh metadata"}
            </Button>
          ))}
      </div>

      {!active && refresh?.status === "failed" && (
        <FailureNotice
          title="The last refresh failed"
          message={refresh.error ?? "The refresh stopped without a reason."}
        >
          <StillShowing lastPublished={lastPublished} />
        </FailureNotice>
      )}
      {!active && refresh?.status === "cancelled" && (
        <div role="status" className="text-sm text-(--muted)">
          <p>The last refresh was cancelled before it published anything.</p>
          <StillShowing lastPublished={lastPublished} />
        </div>
      )}
      {actionError && (
        <p role="alert" className="text-sm font-medium text-(--danger)">
          {actionError.message}
        </p>
      )}
      {latest.isError && (
        <p role="alert" className="text-sm font-medium text-(--danger)">
          Could not load the refresh status: {latest.error.message}
        </p>
      )}
    </Card>
  )
}
