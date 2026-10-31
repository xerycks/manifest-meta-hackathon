import { z } from "zod"

import type { Author } from "../auth/repository.js"
import { MANAGER_ROLES } from "../workspaces/access.js"
import type { WorkspaceRole } from "../workspaces/repository.js"

/** A business definition, e.g. what counts as an "active customer". */
export interface KnowledgeEntry {
  id: string
  workspaceId: string
  title: string
  /** Markdown. */
  body: string
  /** The source this definition is about, if any. */
  connection: { id: string; name: string } | null
  /** Increases with every edit; a save names the version it started from. */
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
  /** The offset of the next page, or null on the last one. */
  nextOffset: number | null
}

export const workspaceParamsSchema = z.object({ workspaceId: z.uuid() })
export const entryParamsSchema = workspaceParamsSchema.extend({ entryId: z.uuid() })

const titleSchema = z
  .string()
  .trim()
  .min(1, "Enter a title")
  .max(200, "The title can be at most 200 characters")
const bodySchema = z
  .string()
  .max(50_000, "The entry can be at most 50,000 characters")
  .transform((value) => value.trimEnd())
const connectionIdSchema = z.uuid("Choose a source from the list").nullable()

export const createEntrySchema = z.strictObject({
  title: titleSchema,
  body: bodySchema.default(""),
  connectionId: connectionIdSchema.optional(),
})

export const updateEntrySchema = z
  .strictObject({
    version: z.number().int().min(1).max(2_147_483_647),
    title: titleSchema.optional(),
    body: bodySchema.optional(),
    connectionId: connectionIdSchema.optional(),
  })
  .refine(
    (input) =>
      input.title !== undefined || input.body !== undefined || input.connectionId !== undefined,
    "Change at least one field",
  )

export const listQuerySchema = z.strictObject({
  search: z
    .string()
    .trim()
    .max(100, "Search for at most 100 characters")
    .optional()
    .transform((value) => value || undefined),
  connectionId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})

export type CreateEntryInput = z.infer<typeof createEntrySchema>
export type UpdateEntryInput = z.infer<typeof updateEntrySchema>
export type ListQuery = z.infer<typeof listQuerySchema>

/** Any member adds entries and edits their own; owners and admins edit any. */
export function canEditEntry(
  entry: Pick<KnowledgeEntry, "createdBy">,
  userId: string,
  role: WorkspaceRole,
): boolean {
  return MANAGER_ROLES.includes(role) || entry.createdBy?.id === userId
}
