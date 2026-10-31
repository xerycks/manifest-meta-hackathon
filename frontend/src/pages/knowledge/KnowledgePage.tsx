import { ArrowLeft, Plus, Search } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useKnowledgeEntries } from "@/entities/knowledge/api.ts"
import { knowledgeEntryHref } from "@/entities/knowledge/links.ts"
import { errorMessage } from "@/features/browse-manifest/manifest-view.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { useDebouncedValue } from "@/shared/lib/use-debounced-value.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button, buttonVariants } from "@/shared/ui/button.tsx"
import { Input } from "@/shared/ui/fields.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

/** The workspace's business definitions: searchable, newest first. Any member can add one. */
export function KnowledgePage() {
  const session = useWorkspaceSession()
  const location = useLocation()
  const navigate = useNavigate()
  const searchId = useId()
  const [notice] = useState(() => (location.state as { notice?: string } | null)?.notice)
  const [searchInput, setSearchInput] = useState("")
  const search = useDebouncedValue(searchInput.trim(), 250)
  const entries = useKnowledgeEntries(session.workspaceId, search)
  const listed = entries.data?.pages.flatMap((page) => page.entries) ?? []
  const searching = search !== searchInput.trim() || (entries.isPlaceholderData && entries.isFetching)

  useEffect(() => {
    // Show a confirmation once; reloading the page should not repeat it.
    if (location.state) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

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
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <h1 className="text-2xl font-semibold tracking-tight">Knowledge base</h1>
            <p className="mt-1 leading-7 text-(--muted)">
              Business definitions everyone works from, such as what counts as an active customer
              or how net revenue is calculated.
            </p>
          </div>
          <Link to="/manifests/knowledge/new" className={buttonVariants()}>
            <Plus aria-hidden className="size-4" />
            New entry
          </Link>
        </div>
      </div>

      {notice && (
        <p role="status" className="text-sm text-(--success)">
          {notice}
        </p>
      )}

      <div className="max-w-md">
        <label htmlFor={searchId} className="text-sm font-medium">
          Search definitions
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
            placeholder="Term or text…"
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <p role="status" className="mt-1 text-xs text-(--muted)">
          {searching ? "Searching…" : ""}
        </p>
      </div>

      {(!session.workspaceId || entries.isPending) && <LoadingState label="Loading entries…" />}
      {entries.isLoadingError && (
        <ErrorState
          title="Knowledge base unavailable"
          message={errorMessage(entries.error)}
          onRetry={() => void entries.refetch()}
        />
      )}
      {entries.isSuccess && listed.length === 0 && (
        <EmptyState
          title={search ? "No matching entries" : "No entries yet"}
          description={
            search
              ? `Nothing in the knowledge base mentions “${search}”.`
              : "Write down the definitions your team relies on, so everyone reads the data the same way."
          }
          action={
            search ? undefined : (
              <Link to="/manifests/knowledge/new" className={buttonVariants({ variant: "secondary" })}>
                Add the first entry
              </Link>
            )
          }
        />
      )}
      {listed.length > 0 && (
        <ul className="space-y-3">
          {listed.map((entry) => (
            <li key={entry.id}>
              <Link
                to={knowledgeEntryHref(entry.id)}
                className="block rounded-lg border border-(--border) bg-white p-4 hover:bg-(--surface) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{entry.title}</span>
                  {entry.connection && <Badge>{entry.connection.name}</Badge>}
                </span>
                {entry.excerpt && (
                  <span className="mt-1 line-clamp-2 block text-sm leading-6 text-(--muted)">
                    {entry.excerpt}
                  </span>
                )}
                <span className="mt-2 block text-xs text-(--muted)">
                  Updated {formatRelativeTime(entry.updatedAt)}
                  {entry.updatedBy && ` by ${entry.updatedBy.name}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {entries.hasNextPage && (
        <Button
          variant="secondary"
          disabled={entries.isFetchingNextPage}
          onClick={() => void entries.fetchNextPage()}
        >
          {entries.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      )}
      {entries.isFetchNextPageError && (
        <p role="alert" className="text-sm text-(--danger)">
          More entries could not be loaded. {errorMessage(entries.error)}
        </p>
      )}
    </div>
  )
}
