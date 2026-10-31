import { z } from "zod"

import type { ManifestObjectKind } from "../connections/adapters/types.js"
import { plainText, snippet } from "../shared/text.js"

export const searchParamsSchema = z.object({ workspaceId: z.uuid() })

export const searchQuerySchema = z.strictObject({
  q: z
    .string()
    .trim()
    .min(1, "Enter something to search for")
    .max(100, "Search for at most 100 characters"),
  /** Results per group. */
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export type SearchQuery = z.infer<typeof searchQuerySchema>

/** Which field of a hit contained the search text. */
export type SearchField =
  | "name"
  | "label"
  | "description"
  | "rowMeaning"
  | "valueNotes"
  | "title"
  | "body"

export interface ObjectHit {
  connectionId: string
  connectionName: string
  objectId: string
  schema: string
  name: string
  label: string | null
  kind: ManifestObjectKind
  present: boolean
  matched: SearchField
  /** Plain text around the match, or the start of the description. */
  snippet: string | null
}

export interface ColumnHit {
  connectionId: string
  connectionName: string
  objectId: string
  objectSchema: string
  objectName: string
  columnId: string
  name: string
  label: string | null
  dataType: string
  /** Both the column and its table are still in the source. */
  present: boolean
  matched: SearchField
  snippet: string | null
}

export interface KnowledgeHit {
  entryId: string
  title: string
  connection: { id: string; name: string } | null
  matched: SearchField
  snippet: string | null
}

export interface SearchResults {
  query: string
  objects: ObjectHit[]
  columns: ColumnHit[]
  knowledge: KnowledgeHit[]
  /** True when a group had more matches than it lists. */
  truncated: boolean
}

const SNIPPET_LENGTH = 160
const LONG_FIELDS = new Set<SearchField>(["description", "rowMeaning", "valueNotes", "body"])

/**
 * The first field (in priority order) that contains `query`, ignoring case,
 * and a snippet: around the match for long text, otherwise the start of
 * `context` (e.g. the description of an object found by name).
 */
export function describeMatch(
  fields: [SearchField, string | null][],
  query: string,
  context: string | null,
): { matched: SearchField; snippet: string | null } {
  const needle = query.toLowerCase()
  const hit = fields.find(([, value]) => value?.toLowerCase().includes(needle))
  const [matched, value] = hit ?? fields[0] ?? ["name", null]
  if (LONG_FIELDS.has(matched) && value) {
    return { matched, snippet: snippet(plainText(value), query, SNIPPET_LENGTH) }
  }
  const text = context ? plainText(context) : ""
  return { matched, snippet: text ? snippet(text, null, SNIPPET_LENGTH) : null }
}
