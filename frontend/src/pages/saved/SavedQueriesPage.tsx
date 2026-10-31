import { Lock, Search } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useConnections } from "@/entities/connections/api.ts"
import { useSavedQueries } from "@/entities/saved-queries/api.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { useDebouncedValue } from "@/shared/lib/use-debounced-value.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button } from "@/shared/ui/button.tsx"
import { Input, Select } from "@/shared/ui/fields.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

/** Saved queries the user may see: searchable, filterable by source, recently updated first. */
export function SavedQueriesPage() {
  const session = useWorkspaceSession()
  const location = useLocation()
  const navigate = useNavigate()
  const searchId = useId()
  const sourceId = useId()
  const [notice] = useState(() => (location.state as { notice?: string } | null)?.notice)
  const [searchInput, setSearchInput] = useState("")
  const [connectionId, setConnectionId] = useState("")
  const search = useDebouncedValue(searchInput.trim(), 250)
  const connections = useConnections(session.workspaceId)
  const savedQueries = useSavedQueries(session.workspaceId, search, connectionId)
  const listed = savedQueries.data?.pages.flatMap((page) => page.savedQueries) ?? []
  const searching =
    search !== searchInput.trim() || (savedQueries.isPlaceholderData && savedQueries.isFetching)
  const filtered = Boolean(search || connectionId)

  useEffect(() => {
    // Show a confirmation once; reloading the page should not repeat it.
    if (location.state) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  return (
    <div className="space-y-6">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Saved queries</h1>
        <p className="mt-1 leading-7 text-(--muted)">
          Queries kept with their source, ready to reopen, rerun with other dates, and download. Save one
          from an answer's evidence on Ask, or from a source's query console.
        </p>
      </div>

      {notice && (
        <p role="status" className="text-sm text-(--success)">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap items-start gap-4">
        <div className="w-full max-w-md">
          <label htmlFor={searchId} className="text-sm font-medium">
            Search saved queries
          </label>
          <div className="relative mt-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-(--muted)"
            />
            <Input
              id={searchId}
              type="search"
              className="pl-8"
              value={searchInput}
              maxLength={100}
              placeholder="Name or description…"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
          <p role="status" className="mt-1 text-xs text-(--muted)">
            {searching ? "Searching…" : ""}
          </p>
        </div>
        <div className="w-full max-w-xs">
          <label htmlFor={sourceId} className="text-sm font-medium">
            Source
          </label>
          <Select
            id={sourceId}
            className="mt-1"
            value={connectionId}
            disabled={!connections.data}
            onChange={(event) => setConnectionId(event.target.value)}
          >
            <option value="">All sources</option>
            {connections.data?.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {(!session.workspaceId || savedQueries.isPending) && <LoadingState label="Loading saved queries…" />}
      {savedQueries.isLoadingError && (
        <ErrorState
          title="Saved queries unavailable"
          message={apiErrorMessage(savedQueries.error)}
          onRetry={() => void savedQueries.refetch()}
        />
      )}
      {savedQueries.isSuccess && listed.length === 0 && (
        <EmptyState
          title={filtered ? "No matching saved queries" : "No saved queries yet"}
          description={
            filtered
              ? "Nothing you can see matches this search and source."
              : "On Ask, open an answer's evidence and choose Save as query; owners and admins can also save from a source's query console."
          }
          action={
            filtered ? undefined : (
              <Link to="/ask" className="text-sm font-medium text-(--accent) hover:underline">
                Ask a question
              </Link>
            )
          }
        />
      )}
      {listed.length > 0 && (
        <ul className="space-y-3">
          {listed.map((item) => (
            <li key={item.id}>
              <Link
                to={`/saved/${encodeURIComponent(item.id)}`}
                className="block rounded-lg border border-(--border) bg-white p-4 hover:bg-(--surface) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{item.name}</span>
                  <Badge>{item.source.name}</Badge>
                  {item.visibility === "private" && (
                    <Badge>
                      <Lock aria-hidden className="size-3" />
                      Only you
                    </Badge>
                  )}
                  {item.parameters.length > 0 && (
                    <Badge>
                      {item.parameters.length} {item.parameters.length === 1 ? "parameter" : "parameters"}
                    </Badge>
                  )}
                </span>
                {item.excerpt && (
                  <span className="mt-1 line-clamp-2 block text-sm leading-6 text-(--muted)">
                    {item.excerpt}
                  </span>
                )}
                <span className="mt-2 block text-xs text-(--muted)">
                  {item.lastRunAt ? `Last run ${formatRelativeTime(item.lastRunAt)}` : "Not run yet"}
                  {" · updated "}
                  {formatRelativeTime(item.updatedAt)}
                  {item.updatedBy && ` by ${item.updatedBy.name}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {savedQueries.hasNextPage && (
        <Button
          variant="secondary"
          disabled={savedQueries.isFetchingNextPage}
          onClick={() => void savedQueries.fetchNextPage()}
        >
          {savedQueries.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      )}
      {savedQueries.isFetchNextPageError && (
        <p role="alert" className="text-sm text-(--danger)">
          More saved queries could not be loaded. {apiErrorMessage(savedQueries.error)}
        </p>
      )}
    </div>
  )
}
