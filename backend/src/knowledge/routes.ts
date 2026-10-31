import { Router, type Request } from "express"

import { currentUser, requireAuth, requireCsrf } from "../auth/middleware.js"
import type { AuthService } from "../auth/service.js"
import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import { ok } from "../shared/http/respond.js"
import { validate } from "../shared/http/validate.js"
import {
  currentRole,
  currentWorkspace,
  MANAGER_ROLES,
  requireMembership,
} from "../workspaces/access.js"
import type { WorkspacesRepository } from "../workspaces/repository.js"
import {
  createEntrySchema,
  entryParamsSchema,
  listQuerySchema,
  updateEntrySchema,
  workspaceParamsSchema,
  type CreateEntryInput,
  type ListQuery,
  type UpdateEntryInput,
} from "./schemas.js"
import type { KnowledgeService } from "./service.js"

export interface KnowledgeDeps {
  workspaces: WorkspacesRepository
  auth: AuthService
  sessionSecret: string
  knowledge: KnowledgeService
}

function entryId(req: Request): string {
  const id = req.params.entryId
  if (!id) throw AppError.badRequest("Missing entry id")
  return id
}

/**
 * The workspace knowledge base. Every member reads and adds entries and edits
 * their own; owners and admins edit and remove any entry.
 */
export function knowledgeRouter(deps: KnowledgeDeps | null): Router {
  const router = Router()
  const collection = "/workspaces/:workspaceId/knowledge"
  const item = `${collection}/:entryId`

  if (!deps) {
    router.use(collection, (_req, _res, next) => next(AppError.storageNotConfigured()))
    return router
  }

  const auth = requireAuth(deps.auth)
  const csrf = requireCsrf(deps.sessionSecret)
  const member = requireMembership(deps.workspaces)
  const manager = requireMembership(deps.workspaces, MANAGER_ROLES)
  const service = deps.knowledge

  router.get(
    collection,
    auth,
    validate("params", workspaceParamsSchema),
    member,
    validate("query", listQuerySchema),
    asyncHandler(async (req, res) => {
      ok(res, await service.list(currentWorkspace(req).id, req.query as unknown as ListQuery))
    }),
  )

  router.post(
    collection,
    auth,
    csrf,
    validate("params", workspaceParamsSchema),
    member,
    validate("body", createEntrySchema),
    asyncHandler(async (req, res) => {
      const input = req.body as CreateEntryInput
      ok(res, await service.create(currentWorkspace(req).id, currentUser(req).id, input), 201)
    }),
  )

  router.get(
    item,
    auth,
    validate("params", entryParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(res, await service.get(currentWorkspace(req).id, entryId(req)))
    }),
  )

  router.patch(
    item,
    auth,
    csrf,
    validate("params", entryParamsSchema),
    member,
    validate("body", updateEntrySchema),
    asyncHandler(async (req, res) => {
      const input = req.body as UpdateEntryInput
      ok(
        res,
        await service.update(currentWorkspace(req).id, entryId(req), input, {
          userId: currentUser(req).id,
          role: currentRole(req),
        }),
      )
    }),
  )

  router.delete(
    item,
    auth,
    csrf,
    validate("params", entryParamsSchema),
    manager,
    asyncHandler(async (req, res) => {
      await service.remove(currentWorkspace(req).id, entryId(req))
      ok(res, { deleted: true })
    }),
  )

  return router
}
