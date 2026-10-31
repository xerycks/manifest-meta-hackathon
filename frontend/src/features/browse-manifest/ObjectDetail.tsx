import { ArrowRight, KeyRound } from "lucide-react"
import { useEffect, useRef } from "react"
import { Link } from "react-router-dom"

import type { ManifestObjectDetail, ManifestRelationship } from "@/entities/manifests/types.ts"
import { cn } from "@/shared/lib/cn.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Badge } from "@/shared/ui/badge.tsx"

import { columnReferences, formatRowEstimate, KIND_LABELS } from "./manifest-view.ts"

const linkClass =
  "rounded-sm font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"

function ObjectLink({
  connectionId,
  end,
}: {
  connectionId: string
  end: { objectId: string; schema: string; name: string; present: boolean }
}) {
  return (
    <Link to={`/manifests/${connectionId}/objects/${end.objectId}`} className={linkClass}>
      {end.schema}.{end.name}
      {!end.present && " (removed)"}
    </Link>
  )
}

function RelationshipList({
  title,
  empty,
  relationships,
  connectionId,
  direction,
}: {
  title: string
  empty: string
  relationships: ManifestRelationship[]
  connectionId: string
  direction: "outgoing" | "incoming"
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold">{title}</h3>
      {relationships.length === 0 ? (
        <p className="mt-1 text-sm text-(--muted)">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-sm">
          {relationships.map((relationship) => (
            <li
              key={relationship.id}
              className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", !relationship.present && "text-(--muted)")}
            >
              {direction === "outgoing" ? (
                <>
                  <code>{relationship.from.columns.join(", ")}</code>
                  <ArrowRight aria-label="references" className="size-3.5 text-(--muted)" />
                  <ObjectLink connectionId={connectionId} end={relationship.to} />
                  <code>({relationship.to.columns.join(", ")})</code>
                </>
              ) : (
                <>
                  <ObjectLink connectionId={connectionId} end={relationship.from} />
                  <code>({relationship.from.columns.join(", ")})</code>
                  <ArrowRight aria-label="references" className="size-3.5 text-(--muted)" />
                  <code>{relationship.to.columns.join(", ")}</code>
                </>
              )}
              {!relationship.present && <Badge>Removed</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** One table or view: its columns, keys, comments from the source, and relationships. */
export function ObjectDetail({
  connectionId,
  detail,
}: {
  connectionId: string
  detail: ManifestObjectDetail
}) {
  const { object, columns } = detail
  const heading = useRef<HTMLHeadingElement>(null)
  const references = columnReferences(detail.outgoing)
  const rows = formatRowEstimate(object.estimatedRows)

  useEffect(() => {
    // Following a link (in the list or a foreign key) lands on the new object's heading.
    heading.current?.focus()
  }, [object.id])

  return (
    <article className="space-y-6">
      <header>
        <p className="text-sm text-(--muted)">{object.schema}</p>
        <h2
          ref={heading}
          tabIndex={-1}
          className="text-xl font-semibold tracking-tight break-words focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          {object.name}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-(--muted)">
          <Badge>{KIND_LABELS[object.kind]}</Badge>
          {!object.present && <Badge tone="danger">Removed from source</Badge>}
          <span>
            {columns.filter((column) => column.present).length} columns
            {rows && ` · ${rows}`}
          </span>
        </div>
        {!object.present && object.removedAt && (
          <p className="mt-2 text-sm text-(--muted)">
            Not found by the refresh{" "}
            <time dateTime={object.removedAt}>{formatRelativeTime(object.removedAt)}</time>. It is
            kept here and returns with the same identity if it comes back.
          </p>
        )}
        {object.comment && (
          <p className="mt-3 max-w-3xl leading-7 whitespace-pre-wrap">{object.comment}</p>
        )}
      </header>

      <section>
        <h3 className="text-sm font-semibold">Columns</h3>
        <div className="mt-2 overflow-x-auto rounded-lg border border-(--border)">
          <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
            <thead className="bg-(--surface) text-xs text-(--muted)">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Name</th>
                <th scope="col" className="px-3 py-2 font-medium">Type</th>
                <th scope="col" className="px-3 py-2 font-medium">Nulls</th>
                <th scope="col" className="px-3 py-2 font-medium">References</th>
                <th scope="col" className="px-3 py-2 font-medium">Source comment</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => (
                <tr
                  key={column.id}
                  className={cn("border-t border-(--border) align-top", !column.present && "text-(--muted)")}
                >
                  <th scope="row" className="px-3 py-2 font-medium">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <code className={cn("break-all", !column.present && "line-through")}>{column.name}</code>
                      {column.isPrimaryKey && (
                        <Badge title="Primary key">
                          <KeyRound aria-hidden className="size-3" />
                          PK
                        </Badge>
                      )}
                      {!column.present && <Badge>Removed</Badge>}
                    </span>
                  </th>
                  <td className="px-3 py-2">
                    <code className="break-all">{column.dataType}</code>
                    {column.enumValues && (
                      <p className="mt-1 text-xs text-(--muted)">One of: {column.enumValues.join(", ")}</p>
                    )}
                    {column.defaultValue && (
                      <p className="mt-1 text-xs break-all text-(--muted)">
                        Default: <code>{column.defaultValue}</code>
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {column.nullable ? "Allowed" : "Not null"}
                  </td>
                  <td className="px-3 py-2">
                    {(references.get(column.name) ?? []).map((reference) => (
                      <p key={`${reference.objectId}.${reference.column}`}>
                        <ObjectLink connectionId={connectionId} end={reference} />
                        <span className="text-(--muted)"> ({reference.column})</span>
                      </p>
                    ))}
                  </td>
                  <td className="max-w-xs px-3 py-2 leading-6 whitespace-pre-wrap">
                    {column.comment}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <RelationshipList
          title="References"
          empty="No foreign keys from this object."
          relationships={detail.outgoing}
          connectionId={connectionId}
          direction="outgoing"
        />
        <RelationshipList
          title="Referenced by"
          empty="No foreign keys point at this object."
          relationships={detail.incoming}
          connectionId={connectionId}
          direction="incoming"
        />
      </div>

      {object.viewDefinition && (
        <details className="rounded-lg border border-(--border)">
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)">
            View definition
          </summary>
          <pre className="overflow-x-auto border-t border-(--border) bg-(--surface) p-3 text-xs leading-5">
            {object.viewDefinition}
          </pre>
        </details>
      )}
    </article>
  )
}
