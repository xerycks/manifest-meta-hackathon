export const KNOWLEDGE_HREF = "/manifests/knowledge"

export function knowledgeEntryHref(entryId: string): string {
  return `${KNOWLEDGE_HREF}/${encodeURIComponent(entryId)}`
}
