import { ArrowLeft, ExternalLink, Lock, Pencil } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { queryKind, queryText } from "@/entities/queries/query-text.ts"
import { ResultNotice } from "@/entities/queries/ResultTable.tsx"
import { useDeleteSavedQuery, useSavedQuery } from "@/entities/saved-queries/api.ts"
import {
  canChangeSavedQuery,
  describeParameterValue,
  describeResolved,
  PARAMETER_TYPE_LABELS,
} from "@/entities/saved-queries/parameters.ts"
import type { SavedQueryDetail } from "@/entities/saved-queries/types.ts"
import { RunHistory } from "@/features/saved-query/RunHistory.tsx"
import { RunPanel } from "@/features/saved-query/RunPanel.tsx"
import { SavedQueryEditor } from "@/features/saved-query/SavedQueryEditor.tsx"
import { ApiError } from "@/shared/api/client.ts"
import { useSessionContext } from "@/shared/api/auth.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button } from "@/shared/ui/button.tsx"
import { Card } from "@/shared/ui/card.tsx"
import { CopyButton } from "@/shared/ui/copy-button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Markdown } from "@/shared/ui/markdown.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

const LINK =
  "inline-flex items-center gap-1 rounded-md font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {formatRelativeTime(iso)}
    </time>
  )
}

function DeleteSavedQuery({
  workspaceId,
  savedQuery,
}: {
  workspaceId: string
  savedQuery: SavedQueryDetail
}) {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const remove = useDeleteSavedQuery(workspaceId, savedQuery.id)
  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        Delete
      </Button>
    )
  }
  return (
    <div
      role="group"
      aria-label="Confirm deletion"
      className="w-full space-y-2 rounded-md border border-(--danger-border) p-3"
    >
      <p className="text-sm">
        Delete “{savedQuery.name}”
        {savedQuery.visibility === "workspace" ? " for everyone in this workspace" : ""}? Its earlier runs stay in
        the source's history until they are pruned. This cannot be undone.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="danger"
          autoFocus
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(undefined, {
              onSuccess: () => navigate("/saved", { state: { notice: `Deleted “${savedQuery.name}”.` } }),
            })
          }
        >
          {remove.isPending ? "Deleting…" : "Delete saved query"}
        </Button>
        <Button variant="secondary" disabled={remove.isPending} onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
      {remove.error && <FailureNotice title="Not deleted" message={apiErrorMessage(remove.error)} />}
    </div>
  )
}

function Definition({ savedQuery }: { savedQuery: SavedQueryDetail }) {
  const text = queryText(savedQuery.query)
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {queryKind(savedQuery.query)} on {savedQuery.source.name}
        </h2>
        <CopyButton text={text} label="the query" />
      </div>
      <pre className="max-h-96 overflow-auto rounded-md bg-(--surface) p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
        <code>{text}</code>
      </pre>
      {savedQuery.parameters.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="pb-1 text-left text-xs text-(--muted)">
              Parameters (defaults resolve in {savedQuery.timeZone} when the query runs)
            </caption>
            <thead className="text-xs text-(--muted)">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">Parameter</th>
                <th scope="col" className="py-1 pr-3 font-medium">Type</th>
                <th scope="col" className="py-1 pr-3 font-medium">Default</th>
                <th scope="col" className="py-1 font-medium">Resolves to now</th>
              </tr>
            </thead>
            <tbody>
              {savedQuery.parameters.map((parameter) => {
                const resolved = savedQuery.defaults.find((item) => item.name === parameter.name)
                return (
                  <tr key={parameter.name} className="border-t border-(--border) align-top">
                    <td className="py-1.5 pr-3">
                      {parameter.label}{" "}
                      <code className="font-mono text-xs text-(--muted)">{parameter.name}</code>
                      {!parameter.required && <span className="text-xs text-(--muted)"> (optional)</span>}
                    </td>
                    <td className="py-1.5 pr-3">{PARAMETER_TYPE_LABELS[parameter.type]}</td>
                    <td className="py-1.5 pr-3">{describeParameterValue(parameter.default)}</td>
                    <td className="py-1.5">
                      {resolved && resolved.value !== null ? describeResolved(resolved) : "Chosen when run"}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

/** One saved query: its definition, a parameter form to run it, the result, and its run history. */
export function SavedQueryPage() {
  const { savedQueryId = "" } = useParams()
  return <SavedQueryView key={savedQueryId} savedQueryId={savedQueryId} />
}

function SavedQueryView({ savedQueryId }: { savedQueryId: string }) {
  const session = useWorkspaceSession()
  const context = useSessionContext()
  const location = useLocation()
  const navigate = useNavigate()
  const savedQuery = useSavedQuery(session.workspaceId, savedQueryId)
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState(() => (location.state as { notice?: string } | null)?.notice)
  const data = savedQuery.data
  // Malformed ids fail validation; either way the saved query does not exist here.
  const notFound =
    savedQuery.error instanceof ApiError &&
    (savedQuery.error.status === 404 || savedQuery.error.status === 422)
  const canChange = data ? canChangeSavedQuery(data, context.data?.user.id, session.workspaceRole) : false

  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/saved"
          className="inline-flex items-center gap-1.5 rounded-md text-sm text-(--muted) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Saved queries
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight break-words">
          {data?.name ?? "Saved query"}
        </h1>
        {data && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-(--muted)">
            <Badge>{data.source.name}</Badge>
            {data.visibility === "private" && (
              <Badge>
                <Lock aria-hidden className="size-3" />
                Only you
              </Badge>
            )}
            <span>
              Saved {data.createdBy && `by ${data.createdBy.name} `}
              <When iso={data.createdAt} />
              {data.version > 1 && (
                <>
                  {" "}
                  · updated {data.updatedBy && `by ${data.updatedBy.name} `}
                  <When iso={data.updatedAt} />
                </>
              )}
            </span>
          </div>
        )}
      </div>

      {notice && (
        <p role="status" className="text-sm text-(--success)">
          {notice}
        </p>
      )}
      {(!session.workspaceId || savedQuery.isPending) && <LoadingState label="Loading the saved query…" />}
      {notFound && (
        <EmptyState
          title="Saved query not found"
          description="It does not exist in this workspace, it is private to someone else, or it was deleted (removing a source removes its saved queries)."
          action={
            <Link to="/saved" className="text-sm font-medium text-(--accent) hover:underline">
              Back to saved queries
            </Link>
          }
        />
      )}
      {savedQuery.isError && !notFound && (
        <ErrorState
          title="Saved query unavailable"
          message={apiErrorMessage(savedQuery.error)}
          onRetry={() => void savedQuery.refetch()}
        />
      )}

      {data && session.workspaceId && editing && (
        <Card>
          <SavedQueryEditor
            workspaceId={session.workspaceId}
            engine={data.source.engine}
            sourceName={data.source.name}
            target={{ kind: "edit", savedQuery: data }}
            onSaved={(saved) => {
              setEditing(false)
              setNotice(`Saved “${saved.name}”.`)
            }}
            onCancel={() => setEditing(false)}
          />
        </Card>
      )}
      {data && session.workspaceId && !editing && (
        <>
          {data.description.trim() && (
            <Markdown className="max-w-3xl rounded-lg border border-(--border) p-4">
              {data.description}
            </Markdown>
          )}
          {data.origin && (
            <p className="text-sm text-(--muted)">
              Saved from an answer's evidence.{" "}
              <Link
                to={`/sources/${encodeURIComponent(data.source.id)}/queries/${encodeURIComponent(data.origin.executionId)}`}
                className={LINK}
              >
                Open the query run it cited
                <ExternalLink aria-hidden className="size-3.5" />
              </Link>
            </p>
          )}
          <Definition savedQuery={data} />
          {data.warnings.map((warning) => (
            <ResultNotice key={warning.code}>{warning.message}</ResultNotice>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            {canChange ? (
              <>
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
                <DeleteSavedQuery workspaceId={session.workspaceId} savedQuery={data} />
              </>
            ) : (
              <p className="text-sm text-(--muted)">
                Only its creator or a workspace owner or admin can change this saved query.
              </p>
            )}
          </div>
          <Card>
            <RunPanel key={data.version} workspaceId={session.workspaceId} savedQuery={data} />
          </Card>
          <RunHistory workspaceId={session.workspaceId} savedQuery={data} />
        </>
      )}
    </div>
  )
}
