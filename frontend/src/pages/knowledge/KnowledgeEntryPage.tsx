import { ArrowLeft, Pencil } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useDeleteKnowledgeEntry, useKnowledgeEntry } from "@/entities/knowledge/api.ts"
import { KNOWLEDGE_HREF } from "@/entities/knowledge/links.ts"
import type { KnowledgeEntry } from "@/entities/knowledge/types.ts"
import { errorMessage, isNotFound } from "@/features/browse-manifest/manifest-view.ts"
import { KnowledgeEntryForm } from "@/features/manage-knowledge/KnowledgeEntryForm.tsx"
import { canDeleteEntry, canEditEntry } from "@/features/manage-knowledge/knowledge-form.ts"
import { useSessionContext } from "@/shared/api/auth.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Button } from "@/shared/ui/button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Markdown } from "@/shared/ui/markdown.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {formatRelativeTime(iso)}
    </time>
  )
}

function DeleteEntry({ workspaceId, entry }: { workspaceId: string; entry: KnowledgeEntry }) {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const remove = useDeleteKnowledgeEntry(workspaceId, entry.id)
  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        Delete
      </Button>
    )
  }
  return (
    <div role="group" aria-label="Confirm deletion" className="w-full space-y-2 rounded-md border border-(--danger-border) p-3">
      <p className="text-sm">Delete “{entry.title}” for everyone in this workspace? This cannot be undone.</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="danger"
          autoFocus
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(undefined, {
              onSuccess: () =>
                navigate(KNOWLEDGE_HREF, { state: { notice: `Deleted “${entry.title}”.` } }),
            })
          }
        >
          {remove.isPending ? "Deleting…" : "Delete entry"}
        </Button>
        <Button variant="secondary" disabled={remove.isPending} onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
      {remove.error && <FailureNotice title="Not deleted" message={apiErrorMessage(remove.error)} />}
    </div>
  )
}

/** One knowledge entry; its author and owners or admins edit it in place. */
export function KnowledgeEntryPage() {
  const { entryId = "" } = useParams()
  return <KnowledgeEntryView key={entryId} entryId={entryId} />
}

function KnowledgeEntryView({ entryId }: { entryId: string }) {
  const session = useWorkspaceSession()
  const context = useSessionContext()
  const location = useLocation()
  const navigate = useNavigate()
  const entry = useKnowledgeEntry(session.workspaceId, entryId)
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState(() => (location.state as { notice?: string } | null)?.notice)
  const notFound = isNotFound(entry.error)
  const data = entry.data
  const canEdit = data ? canEditEntry(data, context.data?.user.id, session.workspaceRole) : false

  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

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
        <h1 className="mt-2 text-2xl font-semibold tracking-tight break-words">
          {data?.title ?? "Knowledge entry"}
        </h1>
      </div>

      {notice && (
        <p role="status" className="text-sm text-(--success)">
          {notice}
        </p>
      )}
      {(!session.workspaceId || entry.isPending) && <LoadingState label="Loading entry…" />}
      {notFound && (
        <EmptyState
          title="Entry not found"
          description="This entry does not exist in the current workspace. It may have been deleted, or it belongs to another workspace."
          action={
            <Link to={KNOWLEDGE_HREF} className="text-sm font-medium text-(--accent) hover:underline">
              Back to the knowledge base
            </Link>
          }
        />
      )}
      {entry.isError && !notFound && (
        <ErrorState
          title="Entry unavailable"
          message={errorMessage(entry.error)}
          onRetry={() => void entry.refetch()}
        />
      )}

      {data && session.workspaceId && editing && (
        <KnowledgeEntryForm
          workspaceId={session.workspaceId}
          entry={data}
          onSaved={(saved) => {
            setEditing(false)
            setNotice(`Saved “${saved.title}”.`)
          }}
          onCancel={() => setEditing(false)}
        />
      )}
      {data && session.workspaceId && !editing && (
        <article className="space-y-4">
          <div className="space-y-1 text-sm text-(--muted)">
            {data.connection ? (
              <p>
                About{" "}
                <Link
                  to={`/manifests/${data.connection.id}`}
                  className="font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
                >
                  {data.connection.name}
                </Link>
              </p>
            ) : (
              <p>Not about one source</p>
            )}
            <p>
              Added {data.createdBy && `by ${data.createdBy.name} `}
              <When iso={data.createdAt} />
              {data.version > 1 && (
                <>
                  {" "}· updated {data.updatedBy && `by ${data.updatedBy.name} `}
                  <When iso={data.updatedAt} />
                </>
              )}
            </p>
          </div>
          {data.body.trim() ? (
            <Markdown className="rounded-lg border border-(--border) p-4">{data.body}</Markdown>
          ) : (
            <p className="rounded-lg border border-dashed border-(--border) p-4 text-sm text-(--muted)">
              No definition written yet.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <Button
                variant="secondary"
                onClick={() => {
                  setNotice(undefined)
                  setEditing(true)
                }}
              >
                <Pencil aria-hidden className="size-4" />
                Edit
              </Button>
            )}
            {canDeleteEntry(session.workspaceRole) && (
              <DeleteEntry workspaceId={session.workspaceId} entry={data} />
            )}
          </div>
          {!canEdit && (
            <p className="text-sm text-(--muted)">
              Only the author or a workspace owner or admin can edit this entry.
            </p>
          )}
        </article>
      )}
    </div>
  )
}
