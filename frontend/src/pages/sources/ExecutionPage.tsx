import { ArrowLeft } from "lucide-react"
import { Link, useParams } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useConnection } from "@/entities/connections/api.ts"
import { useQueryExecution } from "@/entities/queries/api.ts"
import { CsvDownloadButton } from "@/entities/queries/CsvDownloadButton.tsx"
import { queryKind, queryText } from "@/entities/queries/query-text.ts"
import { ResultTable } from "@/entities/queries/ResultTable.tsx"
import { describeOutcome, STATUS_LABELS } from "@/entities/queries/run-outcome.ts"
import type { QueryOrigin } from "@/entities/queries/types.ts"
import { ApiError } from "@/shared/api/client.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Card } from "@/shared/ui/card.tsx"
import { CopyButton } from "@/shared/ui/copy-button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

const ORIGINS: Record<QueryOrigin, string> = {
  console: "Run from the query console",
  agent: "Run to answer a question",
  saved_query: "Run from a saved query",
  dashboard: "Run for a dashboard",
  routine: "Run by a routine",
}

/** One recorded query run: the query as it ran, how it ended, and its stored rows. Any member may open it. */
export function ExecutionPage() {
  const { connectionId = "", executionId = "" } = useParams()
  const session = useWorkspaceSession()
  const connection = useConnection(session.workspaceId, connectionId)
  const execution = useQueryExecution(session.workspaceId, connectionId, executionId)
  const record = execution.data
  const notFound =
    execution.error instanceof ApiError && (execution.error.status === 404 || execution.error.status === 422)
  const outcome = record ? describeOutcome(record) : null

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/sources/${encodeURIComponent(connectionId)}`}
          className="inline-flex items-center gap-1.5 rounded-md text-sm text-(--muted) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          <ArrowLeft aria-hidden className="size-4" />
          {connection.data?.name ?? "Source"}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Query run</h1>
        {record && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-(--muted)">
            <Badge tone={STATUS_LABELS[record.status].tone}>{STATUS_LABELS[record.status].label}</Badge>
            <span>
              {ORIGINS[record.origin]} · {formatRelativeTime(record.createdAt)}
              {record.durationMs !== null ? ` · ${record.durationMs.toLocaleString("en-US")} ms` : ""}
            </span>
          </div>
        )}
      </div>

      {(!session.workspaceId || execution.isPending) && <LoadingState label="Loading the query run…" />}
      {notFound && (
        <EmptyState
          title="Query run not found"
          description="It does not exist in this workspace, or it was removed with older history. Runs that an answer cites are always kept."
        />
      )}
      {execution.isError && !notFound && (
        <ErrorState
          title="The query run could not be loaded"
          message={execution.error.message}
          onRetry={() => void execution.refetch()}
        />
      )}
      {record && (
        <>
          <Card className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{queryKind(record.query)}</h2>
              <CopyButton text={queryText(record.query)} label="the query" />
            </div>
            <pre className="max-h-96 overflow-auto rounded-md bg-(--surface) p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
              <code>{queryText(record.query)}</code>
            </pre>
            {record.query.language === "sql" && record.query.params && record.query.params.length > 0 && (
              <p className="text-xs text-(--muted)">
                Parameter values:{" "}
                {record.query.params.map((value, index) => `$${index + 1} = ${JSON.stringify(value)}`).join(", ")}
              </p>
            )}
            {record.parameters && Object.keys(record.parameters).length > 0 && (
              <p className="text-xs text-(--muted)">
                Ran with{" "}
                {Object.entries(record.parameters)
                  .map(([name, value]) => `${name} = ${value ?? "no value"}`)
                  .join(", ")}
              </p>
            )}
            <p className="text-xs text-(--muted)">
              Limits: {record.limits.maxRows.toLocaleString("en-US")} rows, {record.limits.timeoutMs / 1000}{" "}
              seconds
            </p>
            {record.savedQueryId && (
              <Link
                to={`/saved/${encodeURIComponent(record.savedQueryId)}`}
                className="inline-block rounded-md text-xs font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
              >
                Open the saved query
              </Link>
            )}
          </Card>
          {outcome && <FailureNotice title={outcome.title} message={outcome.message} />}
          {record.status === "running" && (
            <p className="text-sm text-(--muted)">
              This query is still running. Reload the page once it ends.
            </p>
          )}
          {record.result && (
            <section aria-labelledby="execution-result" className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="execution-result" className="text-sm font-semibold">
                  Result
                </h2>
                {session.workspaceId && (
                  <CsvDownloadButton
                    workspaceId={session.workspaceId}
                    connectionId={record.connectionId}
                    executionId={record.id}
                    name={`${connection.data?.name ?? "query"} run`}
                    createdAt={record.createdAt}
                    partial={record.truncated || record.partialResult}
                  />
                )}
              </div>
              <ResultTable
                result={record.result}
                partial={record.partialResult}
                label="Stored query result"
              />
            </section>
          )}
        </>
      )}
    </div>
  )
}
