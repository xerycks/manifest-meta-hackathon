import { KeyRound } from "lucide-react"
import type { ReactNode } from "react"

import { columnAnchor } from "@/entities/manifests/links.ts"
import type { ManifestColumn } from "@/entities/manifests/types.ts"
import { cn } from "@/shared/lib/cn.ts"
import { Badge } from "@/shared/ui/badge.tsx"

import {
  formatElementTypes,
  hasMixedTypes,
  presenceParts,
  presenceSummary,
  splitFieldPath,
} from "./manifest-view.ts"

/**
 * The fields sampled from a MongoDB collection: nested fields indented under
 * their parent, every type seen with its share of the sample, and how often
 * the field was missing.
 */
export function FieldTable({
  fields,
  targetId,
  renderMeaning,
}: {
  fields: ManifestColumn[]
  /** The field a link pointed at, highlighted. */
  targetId: string | undefined
  renderMeaning: (field: ManifestColumn) => ReactNode
}) {
  const described = fields.some((field) => field.comment)
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-(--border)">
      <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
        <thead className="bg-(--surface) text-xs text-(--muted)">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Field</th>
            <th scope="col" className="px-3 py-2 font-medium">Types in sample</th>
            <th scope="col" className="px-3 py-2 font-medium">Meaning</th>
            {described && (
              <th scope="col" className="px-3 py-2 font-medium">Validator description</th>
            )}
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => {
            const details = field.details
            const depth = details?.depth ?? 0
            const { parent, leaf } = splitFieldPath(field.name, depth)
            return (
              <tr
                key={field.id}
                className={cn(
                  "border-t border-(--border) align-top",
                  !field.present && "text-(--muted)",
                  field.id === targetId && "bg-(--warning-surface)",
                )}
              >
                <th
                  scope="row"
                  id={columnAnchor(field.id)}
                  tabIndex={-1}
                  className="px-3 py-2 font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)"
                >
                  <span
                    className="flex flex-wrap items-center gap-1.5"
                    style={{ paddingInlineStart: `${depth * 1.25}rem` }}
                  >
                    <code className={cn("break-all", !field.present && "line-through")}>
                      {parent && <span className="font-normal text-(--muted)">{parent}</span>}
                      {leaf}
                    </code>
                    {field.isPrimaryKey && (
                      <Badge title="Every document's unique id">
                        <KeyRound aria-hidden className="size-3" />
                        id
                      </Badge>
                    )}
                    {!field.present && (
                      <Badge title="Not seen in the documents sampled by the latest refresh">
                        Not in latest sample
                      </Badge>
                    )}
                  </span>
                </th>
                <td className="px-3 py-2">
                  {details ? (
                    <>
                      <p className="sr-only">{presenceSummary(details)}</p>
                      <div aria-hidden className="flex flex-wrap gap-1">
                        {presenceParts(details).map((part) => (
                          <Badge key={part.label} tone={part.tone === "warning" ? "warning" : "neutral"}>
                            <code>{part.label}</code> {part.share}
                          </Badge>
                        ))}
                        {hasMixedTypes(details) && <Badge tone="warning">Mixed types</Badge>}
                      </div>
                      {details.arrayElementTypes && details.arrayElementTypes.length > 0 && (
                        <p className="mt-1 text-xs text-(--muted)">
                          Array elements: <code>{formatElementTypes(details.arrayElementTypes)}</code>
                        </p>
                      )}
                    </>
                  ) : (
                    <code className="break-all">{field.dataType}</code>
                  )}
                </td>
                <td className="px-3 py-2">{renderMeaning(field)}</td>
                {described && (
                  <td className="max-w-xs px-3 py-2 leading-6 whitespace-pre-wrap">{field.comment}</td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
