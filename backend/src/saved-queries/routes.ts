import { Router, type Request } from "express"

import { currentUser, requireAuth, requireCsrf } from "../auth/middleware.js"
import type { AuthService } from "../auth/service.js"
import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import { ok } from "../shared/http/respond.js"
import { validate } from "../shared/http/validate.js"
import { currentRole, currentWorkspace, requireMembership } from "../workspaces/access.js"
import type { WorkspacesRepository } from "../workspaces/repository.js"
import {
  createSavedQuerySchema,
  listRunsSchema,
  listSavedQueriesSchema,
  runSavedQuerySchema,
  savedQueryParamsSchema,
  updateSavedQuerySchema,
  workspaceParamsSchema,
  type CreateSavedQueryInput,
  type ListRunsQuery,
  type ListSavedQueriesQuery,
  type RunSavedQueryInput,
  type UpdateSavedQueryInput,
} from "./schemas.js"
import type { SavedQueriesService } from "./service.js"

export interface SavedQueriesDeps {
  workspaces: WorkspacesRepository
  auth: AuthService
  sessionSecret: string
  /** Null when CONNECTION_ENCRYPTION_KEY is missing: routes answer 503. */
  savedQueries: SavedQueriesService | null
}

function savedQueryId(req: Request): string {
  const id = req.params.savedQueryId
  if (!id) throw AppError.badRequest("Missing saved query id")
  return id
}

/**
 * Saved queries for any member. Workspace-visible ones are everyone's to read
 * and run; private ones only their creator's (others get 404). The creator or
 * an owner or admin edits and deletes.
 */
export function savedQueriesRouter(deps: SavedQueriesDeps | null): Router {
  const router = Router()
  const collection = "/workspaces/:workspaceId/saved-queries"
  const item = `${collection}/:savedQueryId`

  if (!deps) {
    router.use(collection, (_req, _res, next) => next(AppError.storageNotConfigured()))
    return router
  }

  const auth = requireAuth(deps.auth)
  const csrf = requireCsrf(deps.sessionSecret)
  const member = requireMembership(deps.workspaces)
  const service = deps.savedQueries

  if (!service) {
    router.use(collection, auth, validate("params", workspaceParamsSchema), member, (_req, _res, next) =>
      next(AppError.connectionsNotConfigured()),
    )
    return router
  }

  router.get(
    collection,
    auth,
    validate("params", workspaceParamsSchema),
    member,
    validate("query", listSavedQueriesSchema),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as ListSavedQueriesQuery
      ok(res, await service.list(currentWorkspace(req).id, currentUser(req).id, query))
    }),
  )

  router.post(
    collection,
    auth,
    csrf,
    validate("params", workspaceParamsSchema),
    member,
    validate("body", createSavedQuerySchema),
    asyncHandler(async (req, res) => {
      const input = req.body as CreateSavedQueryInput
      ok(res, await service.create(currentWorkspace(req).id, currentUser(req).id, input), 201)
    }),
  )

  router.get(
    item,
    auth,
    validate("params", savedQueryParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(res, await service.get(currentWorkspace(req).id, currentUser(req).id, savedQueryId(req)))
    }),
  )

  router.patch(
    item,
    auth,
    csrf,
    validate("params", savedQueryParamsSchema),
    member,
    validate("body", updateSavedQuerySchema),
    asyncHandler(async (req, res) => {
      const input = req.body as UpdateSavedQueryInput
      ok(
        res,
        await service.update(currentWorkspace(req).id, savedQueryId(req), input, {
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
    validate("params", savedQueryParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      await service.remove(currentWorkspace(req).id, savedQueryId(req), {
        userId: currentUser(req).id,
        role: currentRole(req),
      })
      ok(res, { deleted: true })
    }),
  )

  router.post(
    `${item}/run`,
    auth,
    csrf,
    validate("params", savedQueryParamsSchema),
    member,
    validate("body", runSavedQuerySchema),
    asyncHandler(async (req, res) => {
      const { parameters } = req.body as RunSavedQueryInput
      // A client that goes away before the answer cancels the query on the source.
      const disconnected = new AbortController()
      res.on("close", () => {
        if (!res.writableFinished) disconnected.abort("disconnected")
      })
      ok(
        res,
        await service.run(
          currentWorkspace(req).id,
          currentUser(req).id,
          savedQueryId(req),
          parameters,
          disconnected.signal,
        ),
      )
    }),
  )

  router.get(
    `${item}/runs`,
    auth,
    validate("params", savedQueryParamsSchema),
    member,
    validate("query", listRunsSchema),
    asyncHandler(async (req, res) => {
      const page = req.query as unknown as ListRunsQuery
      ok(res, await service.runs(currentWorkspace(req).id, currentUser(req).id, savedQueryId(req), page))
    }),
  )

  return router
}
