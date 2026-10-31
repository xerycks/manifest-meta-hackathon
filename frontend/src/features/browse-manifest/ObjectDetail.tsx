import { KeyRound } from "lucide-react"
import { useEffect, useRef, type ReactNode } from "react"
import { useLocation } from "react-router-dom"

import { columnAnchor } from "@/entities/manifests/links.ts"
import { ObjectLink } from "@/entities/manifests/ObjectLink.tsx"
import type { ManifestColumn, ManifestObjectDetail } from "@/entities/manifests/types.ts"
import { cn } from "@/shared/lib/cn.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Badge } from "@/shared/ui/badge.tsx"

import { FieldTable } from "./FieldTable.tsx"
import { columnReferences, describeSample, formatRowEstimate, KIND_LABELS } from "./manifest-view.ts"

/**
 * One table, view, or MongoDB collection: its columns (MongoDB: sampled
 * fields), keys, comments from the source, and relationships. Authored
 * meaning and its editors come in through the slots, so this layout stays
 * independent of who may edit.
 */
export function ObjectDetail({
  connectionId,
  detail,
  meaning,
  relationships,
  renderColumnMeaning,
  columnEditor,
}: {
  connectionId: string
  detail: ManifestObjectDetail
  /** The object's business context, under the header. */
  meaning: ReactNode
  /** Relationships to and from the object. */
  relationships: ReactNode
  /** A column's business meaning, in its row. */
  renderColumnMeaning: (column: ManifestColumn) => ReactNode
  /** The open column editor, if any, under the table. */
  columnEditor: ReactNode
}) {
  const { object, columns } = detail
  const heading = useRef<HTMLHeadingElement>(null)
  const { hash } = useLocation()
  const references = columnReferences(detail.outgoing)
  const sampled = object.details?.engine === "mongodb" ? object.details : null
  const rows = formatRowEstimate(
    object.estimatedRows,
    sampled ? { one: "document", many: "documents" } : undefined,
  )
  // A failed sample has nothing to describe; the notice below says why.
  const sample = sampled && !sampled.sampleFailure ? describeSample(sampled) : null
  const presentColumns = columns.filter((column) => column.present).length
  const targetColumn = columns.find((column) => hash === `#${columnAnchor(column.id)}`)

  useEffect(() => {
    // Following a link lands on the new object's heading, or on the column it names.
    const target = targetColumn ? document.getElementById(columnAnchor(targetColumn.id)) : null
    if (target) {
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: "center" })
    } else {
      heading.current?.focus()
    }
  }, [object.id, targetColumn?.id])

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
          {sampled?.collectionType === "timeseries" && <Badge>Time series</Badge>}
          {sampled?.capped && <Badge>Capped</Badge>}
          {!object.present && <Badge tone="danger">Removed from source</Badge>}
          <span>
            {presentColumns} {sampled ? "fields" : "columns"}
            {rows && ` · ${rows}`}
          </span>
        </div>
        {sample && (
          <div className="mt-2 text-sm text-(--muted)">
            <p>{sample.summary} Types and shares describe the sample, not every document.</p>
            {sample.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        )}
        {sampled?.sampleFailure && (
          <p className="mt-2 rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-sm text-(--warning)">
            The latest refresh could not sample this collection: {sampled.sampleFailure} The fields below
            are from an earlier sample.
          </p>
        )}
        {!object.present && object.removedAt && (
          <p className="mt-2 text-sm text-(--muted)">
            Not found by the refresh{" "}
            <time dateTime={object.removedAt}>{formatRelativeTime(object.removedAt)}</time>. It is
            kept here and returns with the same identity if it comes back.
          </p>
        )}
        {object.comment && (
          <p className="mt-3 max-w-3xl leading-7 whitespace-pre-wrap">
            <span className="sr-only">Source comment: </span>
            {object.comment}
          </p>
        )}
      </header>

      {meaning}

      <section>
        <h3 className="text-sm font-semibold">{sampled ? "Fields" : "Columns"}</h3>
        {sampled ? (
          columns.length > 0 ? (
            <FieldTable fields={columns} targetId={targetColumn?.id} renderMeaning={renderColumnMeaning} />
          ) : (
            <p className="mt-2 text-sm text-(--muted)">
              {sampled.sampleFailure
                ? "No fields have been sampled yet."
                : "No fields: the latest sample had no documents."}
            </p>
          )
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg border border-(--border)">
            <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
              <thead className="bg-(--surface) text-xs text-(--muted)">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Name</th>
                  <th scope="col" className="px-3 py-2 font-medium">Type</th>
                  <th scope="col" className="px-3 py-2 font-medium">Nulls</th>
                  <th scope="col" className="px-3 py-2 font-medium">References</th>
                  <th scope="col" className="px-3 py-2 font-medium">Meaning</th>
                  <th scope="col" className="px-3 py-2 font-medium">Source comment</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((column) => (
                  <tr
                    key={column.id}
                    className={cn(
                      "border-t border-(--border) align-top",
                      !column.present && "text-(--muted)",
                      column.id === targetColumn?.id && "bg-(--warning-surface)",
                    )}
                  >
                    <th
                      scope="row"
                      id={columnAnchor(column.id)}
                      tabIndex={-1}
                      className="px-3 py-2 font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)"
                    >
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
                    <td className="px-3 py-2">{renderColumnMeaning(column)}</td>
                    <td className="max-w-xs px-3 py-2 leading-6 whitespace-pre-wrap">
                      {column.comment}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {columnEditor && <div className="mt-3">{columnEditor}</div>}
      </section>

      {relationships}

      {object.viewDefinition && (
        <details className="rounded-lg border border-(--border)">
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)">
            {sampled ? "View pipeline" : "View definition"}
          </summary>
          <pre className="overflow-x-auto border-t border-(--border) bg-(--surface) p-3 text-xs leading-5">
            {object.viewDefinition}
          </pre>
        </details>
      )}
    </article>
  )
}
