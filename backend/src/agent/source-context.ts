import type { Connection, ConnectionsRepository } from "../connections/repository.js"
import type { KnowledgeRepository } from "../knowledge/repository.js"
import type { ManifestsRepository } from "../manifests/repository.js"
import type { ManifestOutlineEntry } from "../manifests/schemas.js"

/** Objects read per source for the outline; the rest are found with the metadata tools. */
const OUTLINE_OBJECTS = 500
const KNOWLEDGE_TITLES = 50
/** Characters of manifest outline in the instructions, shared evenly by the sources. */
export const OUTLINE_BUDGET = 12_000

export interface SourceOutline {
  source: Connection
  objects: ManifestOutlineEntry[]
  /** The source has more objects than were read. */
  more: boolean
}

export interface SourceContext {
  sources: SourceOutline[]
  knowledge: { id: string; title: string }[]
  moreKnowledge: boolean
}

export interface SourceContextDeps {
  connections: ConnectionsRepository
  manifests: ManifestsRepository
  knowledge: KnowledgeRepository
}

/** The sources in scope (null: every source), their manifest outlines, and knowledge titles. */
export async function loadSourceContext(
  deps: SourceContextDeps,
  workspaceId: string,
  scope: string[] | null,
): Promise<SourceContext> {
  const inScope = (id: string) => !scope || scope.includes(id)
  const sources = (await deps.connections.list(workspaceId)).filter((source) => inScope(source.id))
  const [outlines, knowledge] = await Promise.all([
    Promise.all(
      sources.map(async (source) => {
        const objects = await deps.manifests.outline(
          workspaceId,
          source.id,
          source.schemas,
          OUTLINE_OBJECTS + 1,
        )
        return { source, objects: objects.slice(0, OUTLINE_OBJECTS), more: objects.length > OUTLINE_OBJECTS }
      }),
    ),
    deps.knowledge.list(workspaceId, { search: undefined, limit: KNOWLEDGE_TITLES, offset: 0 }),
  ])
  return {
    sources: outlines,
    knowledge: knowledge.entries
      .filter((entry) => !entry.connection || inScope(entry.connection.id))
      .map((entry) => ({ id: entry.id, title: entry.title })),
    moreKnowledge: knowledge.nextOffset !== null,
  }
}

const ENGINES = { postgres: "PostgreSQL", mongodb: "MongoDB" } as const

function objectLine(object: ManifestOutlineEntry): string {
  const kind =
    object.kind === "table" || object.kind === "collection" ? "" : ` (${object.kind.replace("_", " ")})`
  const facts = [
    object.label ? `“${object.label}”` : null,
    object.rowMeaning,
    `${object.columnCount} ${object.kind === "collection" ? "fields" : "columns"}`,
  ].filter(Boolean)
  return `    - ${object.name}${kind} · ${facts.join(" · ")}`
}

/** Header lines are always kept; object lines stop at the source's share of the budget. */
function formatSource(outline: SourceOutline, budget: number): string[] {
  const { source } = outline
  const mongo = source.engine === "mongodb"
  const lines = [
    `### ${source.name}`,
    `- id: ${source.id}`,
    `- engine: ${ENGINES[source.engine]}; status: ${source.status}${
      source.status === "failed" && source.lastError ? ` (last test: ${source.lastError})` : ""
    }`,
    `- ${mongo ? "databases" : "schemas"}: ${source.schemas.join(", ")}`,
    `- queries: ${source.capabilities.summary}`,
  ]
  if (outline.objects.length === 0) {
    lines.push("- outline: nothing published yet (the first metadata refresh may still be running)")
    return lines
  }
  lines.push(`- outline (${mongo ? "database → collections" : "schema → tables and views"}):`)
  let used = 0
  let shown = 0
  let schema: string | null = null
  for (const object of outline.objects) {
    const entry = [...(object.schema !== schema ? [`  ${object.schema}`] : []), objectLine(object)]
    const size = entry.reduce((total, line) => total + line.length + 1, 0)
    if (used + size > budget) break
    lines.push(...entry)
    used += size
    shown += 1
    schema = object.schema
  }
  const rest = outline.objects.length - shown
  if (rest > 0 || outline.more) {
    lines.push(
      `  … ${rest}${outline.more ? "+" : ""} more not listed here; use search_metadata or describe_object to find them.`,
    )
  }
  return lines
}

/** The sources section of the instructions, with the outline held to `budget` characters. */
export function formatSourceContext(context: SourceContext, budget = OUTLINE_BUDGET): string {
  const sections = ["## Sources"]
  if (context.sources.length === 0) {
    sections.push("No sources are available for this question. Say so in a partial answer.")
  }
  const share = Math.floor(budget / Math.max(1, context.sources.length))
  for (const outline of context.sources) sections.push(formatSource(outline, share).join("\n"))
  if (context.knowledge.length > 0) {
    sections.push(
      [
        "## Knowledge base entries (read them with read_knowledge)",
        ...context.knowledge.map((entry) => `- ${entry.title} (id: ${entry.id})`),
        ...(context.moreKnowledge ? ["- … more entries; use search_metadata to find them"] : []),
      ].join("\n"),
    )
  }
  return sections.join("\n\n")
}
