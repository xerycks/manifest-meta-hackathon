import { Search } from "lucide-react"
import { useId, useState } from "react"
import { Link, useNavigate } from "react-router-dom"

import { useWorkspaceSearch } from "@/entities/manifests/api.ts"
import { cn } from "@/shared/lib/cn.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { useDebouncedValue } from "@/shared/lib/use-debounced-value.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Input } from "@/shared/ui/fields.tsx"

import { firstResultHref, groupSearchResults } from "./search-results.ts"

/**
 * Searches every source's tables, columns, and authored meaning, plus the
 * knowledge base, and links straight to what it finds. Enter opens the first result.
 */
export function ManifestSearch({ workspaceId }: { workspaceId: string | null }) {
  const id = useId()
  const navigate = useNavigate()
  const [input, setInput] = useState("")
  const query = useDebouncedValue(input.trim(), 250)
  const search = useWorkspaceSearch(workspaceId, query)
  const active = input.trim().length > 0
  const settled = active && query === input.trim() && !search.isPlaceholderData
  const groups = search.data && active ? groupSearchResults(search.data) : []
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)

  let status = ""
  if (active && !settled) status = "Searching…"
  else if (settled && search.isSuccess) {
    status = total === 0 ? `Nothing matches “${query}”.` : `${total} ${total === 1 ? "result" : "results"}. Press Enter to open the first.`
  }

  return (
    <div role="search" className="max-w-2xl">
      <label htmlFor={id} className="text-sm font-medium">
        Search tables, columns, and definitions
      </label>
      <div className="relative mt-1">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-(--muted)"
        />
        <Input
          id={id}
          type="search"
          className="pl-8"
          value={input}
          maxLength={100}
          placeholder="e.g. revenue, customer_id, active customer"
          aria-describedby={`${id}-status`}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !settled) return
            const href = firstResultHref(groups)
            if (href) navigate(href)
          }}
        />
      </div>
      <p id={`${id}-status`} role="status" className="mt-1 text-xs text-(--muted)">
        {status}
      </p>
      {active && search.isError && (
        <p role="alert" className="mt-2 text-sm text-(--danger)">
          Search failed. {apiErrorMessage(search.error)}
        </p>
      )}
      {groups.length > 0 && (
        <div className={cn("mt-3 space-y-4 rounded-lg border border-(--border) p-3", !settled && "opacity-60")}>
          {groups.map((group) => (
            <section key={group.id} aria-labelledby={`${id}-${group.id}`}>
              <h2 id={`${id}-${group.id}`} className="px-1 text-xs font-semibold tracking-wide text-(--muted) uppercase">
                {group.label}
              </h2>
              <ul className="mt-1 space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.key}>
                    <Link
                      to={item.href}
                      className="block rounded-md px-2 py-1.5 hover:bg-(--surface) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
                    >
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className={cn("text-sm font-medium break-all", item.removed && "text-(--muted) line-through")}>
                          {item.title}
                        </span>
                        {item.removed && <Badge>Removed</Badge>}
                        <span className="text-xs text-(--muted)">matched {item.matched}</span>
                      </span>
                      {item.context && <span className="block text-xs text-(--muted)">{item.context}</span>}
                      {item.snippet && (
                        <span className="mt-0.5 line-clamp-2 block text-sm leading-6">{item.snippet}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {search.data?.truncated && (
            <p className="px-1 text-xs text-(--muted)">
              Only the best matches of each kind are shown. Add words to narrow the search.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
