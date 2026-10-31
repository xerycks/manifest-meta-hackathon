import type { Author } from "../manifests/types.ts"

/** A business definition, e.g. what counts as an "active customer". */
export interface KnowledgeEntry {
  id: string
  workspaceId: string
  title: string
  /** Markdown. */
  body: string
  /** The source this definition is about, if any. */
  connection: { id: string; name: string } | null
  /** Increases with every edit; saves send the version they started from. */
  version: number
  createdBy: Author | null
  updatedBy: Author | null
  createdAt: string
  updatedAt: string
}

export interface KnowledgeEntrySummary extends Omit<KnowledgeEntry, "body"> {
  /** The start of the body as plain text. */
  excerpt: string
}

export interface KnowledgeList {
  entries: KnowledgeEntrySummary[]
  nextOffset: number | null
}

export interface CreateKnowledgeEntryInput {
  title: string
  body: string
  connectionId: string | null
}

/** Omitted fields are kept. */
export interface UpdateKnowledgeEntryInput {
  version: number
  title?: string
  body?: string
  connectionId?: string | null
}
