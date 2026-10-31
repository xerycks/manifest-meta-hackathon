import { Search } from "lucide-react"
import { useId } from "react"
import { NavLink } from "react-router-dom"

import type { ConnectionManifest } from "@/entities/manifests/types.ts"
import { cn } from "@/shared/lib/cn.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Input } from "@/shared/ui/fields.tsx"

import { KIND_LABELS } from "./manifest-view.ts"

function objectLinkClass({ isActive }: { isActive: boolean }): string {
  return cn(
    "flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)",
    isActive ? "bg-(--surface) font-medium text-(--foreground)" : "hover:bg-(--surface)",
  )
}

/** Searchable schemas → tables and views of one source; each object links to its detail. */
export function ObjectList({
  connectionId,
  manifest,
  search,
  onSearchChange,
  searching,
}: {
  connectionId: string
  manifest: ConnectionManifest
  search: string
  onSearchChange: (value: string) => void
  /** True while results for a new search are loading. */
  searching: boolean
}) {
  const searchId = useId()
  const total = manifest.schemas.reduce((sum, schema) => sum + schema.objects.length, 0)

  return (
    <nav aria-label="Tables and views" className="space-y-4">
      <div>
        <label htmlFor={searchId} className="text-sm font-medium">
          Find a table or view
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
            value={search}
            maxLength={100}
            placeholder="Name or label contains…"
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
        <p role="status" className="mt-1 text-xs text-(--muted)">
          {searching ? "Searching…" : search.trim() ? `${total} matching` : ""}
        </p>
      </div>

      {manifest.schemas.map((schema, index) => (
        <section key={schema.name} aria-labelledby={`${searchId}-schema-${index}`}>
          <h2
            id={`${searchId}-schema-${index}`}
            className="px-2.5 text-xs font-semibold tracking-wide text-(--muted) uppercase"
          >
            {schema.name}
            <span className="sr-only"> schema</span>
          </h2>
          {schema.objects.length === 0 ? (
            <p className="mt-1 px-2.5 text-sm text-(--muted)">
              {search.trim() ? "No matches" : "No tables or views"}
            </p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {schema.objects.map((object) => (
                <li key={object.id}>
                  <NavLink
                    to={`/manifests/${connectionId}/objects/${object.id}`}
                    className={objectLinkClass}
                  >
                    <span className="min-w-0">
                      <span
                        className={cn("block truncate", !object.present && "text-(--muted) line-through")}
                      >
                        {object.name}
                      </span>
                      {object.label && (
                        <span className="block truncate text-xs font-normal text-(--muted)">
                          {object.label}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-(--muted)">
                      {!object.present ? (
                        <Badge>Removed</Badge>
                      ) : (
                        object.kind !== "table" && <Badge>{KIND_LABELS[object.kind]}</Badge>
                      )}
                      <span>
                        {object.columnCount}
                        <span className="sr-only"> columns</span>
                      </span>
                    </span>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {manifest.truncated && (
        <p className="px-2.5 text-sm text-(--muted)">
          Only the first part of a very large manifest is listed. Search to find the rest.
        </p>
      )}
    </nav>
  )
}
