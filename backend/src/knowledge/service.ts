import type { ConnectionsRepository } from "../connections/repository.js"
import { AppError } from "../shared/http/errors.js"
import { isUniqueViolation } from "../shared/postgres/errors.js"
import type { WorkspaceRole } from "../workspaces/repository.js"
import type { KnowledgeRepository } from "./repository.js"
import {
  canEditEntry,
  type CreateEntryInput,
  type KnowledgeEntry,
  type KnowledgeList,
  type ListQuery,
  type UpdateEntryInput,
} from "./schemas.js"

export const MAX_KNOWLEDGE_ENTRIES = 2_000

const NOT_FOUND = "Knowledge entry not found"

function titleTaken(title: string): AppError {
  return AppError.conflict(`An entry titled “${title}” already exists. Edit that one instead.`)
}

export class KnowledgeService {
  constructor(
    private readonly entries: KnowledgeRepository,
    private readonly connections: ConnectionsRepository,
  ) {}

  list(workspaceId: string, query: ListQuery): Promise<KnowledgeList> {
    return this.entries.list(workspaceId, query)
  }

  async get(workspaceId: string, id: string): Promise<KnowledgeEntry> {
    const entry = await this.entries.get(workspaceId, id)
    if (!entry) throw AppError.notFound(NOT_FOUND)
    return entry
  }

  async create(workspaceId: string, userId: string, input: CreateEntryInput): Promise<KnowledgeEntry> {
    if ((await this.entries.count(workspaceId)) >= MAX_KNOWLEDGE_ENTRIES) {
      throw AppError.conflict(
        `A workspace can have at most ${MAX_KNOWLEDGE_ENTRIES.toLocaleString("en-US")} knowledge entries.`,
      )
    }
    const connectionId = input.connectionId ?? null
    await this.assertSourceInWorkspace(workspaceId, connectionId)
    try {
      return await this.entries.insert({
        workspaceId,
        title: input.title,
        body: input.body,
        connectionId,
        userId,
      })
    } catch (error) {
      throw isUniqueViolation(error) ? titleTaken(input.title) : error
    }
  }

  /** Authors edit their own entries; owners and admins edit any. */
  async update(
    workspaceId: string,
    id: string,
    input: UpdateEntryInput,
    actor: { userId: string; role: WorkspaceRole },
  ): Promise<KnowledgeEntry> {
    const entry = await this.get(workspaceId, id)
    if (!canEditEntry(entry, actor.userId, actor.role)) {
      throw AppError.forbidden("Only the author or a workspace owner or admin can edit this entry")
    }
    await this.assertSourceInWorkspace(workspaceId, input.connectionId)
    const { version, ...changes } = input
    let result
    try {
      result = await this.entries.update(workspaceId, id, version, changes, actor.userId)
    } catch (error) {
      throw isUniqueViolation(error) ? titleTaken(input.title ?? entry.title) : error
    }
    if (result.status === "missing") throw AppError.notFound(NOT_FOUND)
    if (result.status === "stale") throw AppError.stale("entry", result.current)
    return result.record
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    if (!(await this.entries.delete(workspaceId, id))) throw AppError.notFound(NOT_FOUND)
  }

  private async assertSourceInWorkspace(
    workspaceId: string,
    connectionId: string | null | undefined,
  ): Promise<void> {
    if (!connectionId) return
    if (!(await this.connections.get(workspaceId, connectionId))) {
      throw AppError.validation("Choose a source from this workspace.", { field: "connectionId" })
    }
  }
}
