import type { WorkspaceRole } from "../../app/organization-role.ts"
import type {
  CreateKnowledgeEntryInput,
  KnowledgeEntry,
  UpdateKnowledgeEntryInput,
} from "../../entities/knowledge/types.ts"
import { changedKeys, type DraftFields, type DraftState } from "../../shared/lib/draft.ts"

export type KnowledgeField = "title" | "body" | "connectionId"

export const TITLE_MAX = 200
export const BODY_MAX = 50_000

export const EMPTY_ENTRY: DraftFields<KnowledgeField> = { title: "", body: "", connectionId: "" }

/** An entry as the form edits it; "" means no linked source. */
export function entryFields(entry: KnowledgeEntry): DraftFields<KnowledgeField> {
  return { title: entry.title, body: entry.body, connectionId: entry.connection?.id ?? "" }
}

/** A problem with the title that the server would reject, or null. */
export function titleProblem(title: string): string | null {
  const trimmed = title.trim()
  if (!trimmed) return "Enter a title."
  if (trimmed.length > TITLE_MAX) return `The title can be at most ${TITLE_MAX} characters.`
  return null
}

export function newEntry(draft: DraftFields<KnowledgeField>): CreateKnowledgeEntryInput {
  return { title: draft.title.trim(), body: draft.body, connectionId: draft.connectionId || null }
}

/** Only the changed fields; an emptied body stays an empty string, an unlinked source is null. */
export function entryPatch(state: DraftState<KnowledgeField>): UpdateKnowledgeEntryInput {
  const patch: UpdateKnowledgeEntryInput = { version: state.version }
  for (const key of changedKeys(state.base, state.draft)) {
    if (key === "title") patch.title = state.draft.title.trim()
    if (key === "body") patch.body = state.draft.body
    if (key === "connectionId") patch.connectionId = state.draft.connectionId || null
  }
  return patch
}

/** Mirrors the server: anyone edits their own entries, owners and admins edit any. */
export function canEditEntry(
  entry: Pick<KnowledgeEntry, "createdBy">,
  userId: string | undefined,
  role: WorkspaceRole | null,
): boolean {
  return role === "owner" || role === "admin" || (userId !== undefined && entry.createdBy?.id === userId)
}

/** Only owners and admins remove entries. */
export function canDeleteEntry(role: WorkspaceRole | null): boolean {
  return role === "owner" || role === "admin"
}
