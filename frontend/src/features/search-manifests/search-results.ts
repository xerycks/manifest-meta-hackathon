import { knowledgeEntryHref } from "../../entities/knowledge/links.ts"
import { columnHref, objectHref } from "../../entities/manifests/links.ts"
import type { SearchField, SearchResults } from "../../entities/manifests/types.ts"

export const MATCH_LABELS: Record<SearchField, string> = {
  name: "name",
  label: "label",
  description: "description",
  rowMeaning: "row meaning",
  valueNotes: "value notes",
  title: "term",
  body: "definition",
}

export interface SearchResultItem {
  key: string
  href: string
  title: string
  /** Where it lives, e.g. the source and type. */
  context: string
  /** Which field matched, in words. */
  matched: string
  snippet: string | null
  /** No longer in the source. */
  removed: boolean
}

export interface SearchResultGroup {
  id: "objects" | "columns" | "knowledge"
  label: string
  items: SearchResultItem[]
}

/** Search results as linked groups (tables, views, and collections; columns and fields; knowledge entries); empty groups are dropped. */
export function groupSearchResults(results: SearchResults): SearchResultGroup[] {
  const groups: SearchResultGroup[] = [
    {
      id: "objects",
      label: "Tables, views, and collections",
      items: results.objects.map((hit) => ({
        key: `object:${hit.objectId}`,
        href: objectHref(hit.connectionId, hit.objectId),
        title: `${hit.schema}.${hit.name}`,
        context: [hit.connectionName, hit.label].filter(Boolean).join(" · "),
        matched: MATCH_LABELS[hit.matched],
        snippet: hit.snippet,
        removed: !hit.present,
      })),
    },
    {
      id: "columns",
      label: "Columns and fields",
      items: results.columns.map((hit) => ({
        key: `column:${hit.columnId}`,
        href: columnHref(hit.connectionId, hit.objectId, hit.columnId),
        title: `${hit.objectSchema}.${hit.objectName}.${hit.name}`,
        context: [hit.connectionName, hit.dataType, hit.label].filter(Boolean).join(" · "),
        matched: MATCH_LABELS[hit.matched],
        snippet: hit.snippet,
        removed: !hit.present,
      })),
    },
    {
      id: "knowledge",
      label: "Knowledge base",
      items: results.knowledge.map((hit) => ({
        key: `knowledge:${hit.entryId}`,
        href: knowledgeEntryHref(hit.entryId),
        title: hit.title,
        context: hit.connection?.name ?? "Not about one source",
        matched: MATCH_LABELS[hit.matched],
        snippet: hit.snippet,
        removed: false,
      })),
    },
  ]
  return groups.filter((group) => group.items.length > 0)
}

/** Where Enter in the search box goes: the first result shown. */
export function firstResultHref(groups: SearchResultGroup[]): string | null {
  return groups[0]?.items[0]?.href ?? null
}
