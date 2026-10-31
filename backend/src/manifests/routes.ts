import { Router, type Request } from "express"

import { currentUser, requireAuth, requireCsrf } from "../auth/middleware.js"
import type { AuthService } from "../auth/service.js"
import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import { ok } from "../shared/http/respond.js"
import { validate } from "../shared/http/validate.js"
import { currentWorkspace, MANAGER_ROLES, requireMembership } from "../workspaces/access.js"
import type { WorkspacesRepository } from "../workspaces/repository.js"
import {
  browseQuerySchema,
  connectionParamsSchema,
  objectParamsSchema,
  refreshParamsSchema,
  type BrowseQuery,
} from "./schemas.js"
import type { ManifestsService } from "./service.js"

export interface ManifestsDeps {
  workspaces: WorkspacesRepository
  auth: AuthService
  sessionSecret: string
  /** Null when CONNECTION_ENCRYPTION_KEY is missing: routes answer 503. */
  manifests: ManifestsService | null
}

/** Ids from params that validate() has already checked. */
function param(req: Request, name: "connectionId" | "refreshId" | "objectId"): string {
  const value = req.params[name]
  if (!value) throw AppError.badRequest(`Missing ${name}`)
  return value
}

export function manifestsRouter(deps: ManifestsDeps | null): Router {
  const router = Router()
  const base = "/workspaces/:workspaceId/connections/:connectionId/manifest"
  const refreshes = `${base}/refreshes`

  if (!deps) {
    router.use(base, (_req, _res, next) => next(AppError.storageNotConfigured()))
    return router
  }

  const auth = requireAuth(deps.auth)
  const csrf = requireCsrf(deps.sessionSecret)
  const member = requireMembership(deps.workspaces)
  const manager = requireMembership(deps.workspaces, MANAGER_ROLES)
  const service = deps.manifests

  if (!service) {
    router.use(
      base,
      auth,
      validate("params", connectionParamsSchema),
      member,
      (_req, _res, next) => next(AppError.connectionsNotConfigured()),
    )
    return router
  }

  router.get(
    base,
    auth,
    validate("params", connectionParamsSchema),
    member,
    validate("query", browseQuerySchema),
    asyncHandler(async (req, res) => {
      const { search } = req.query as BrowseQuery
      ok(res, await service.browse(currentWorkspace(req).id, param(req, "connectionId"), search))
    }),
  )

  router.get(
    `${base}/objects/:objectId`,
    auth,
    validate("params", objectParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(
        res,
        await service.object(
          currentWorkspace(req).id,
          param(req, "connectionId"),
          param(req, "objectId"),
        ),
      )
    }),
  )

  router.post(
    `${base}/refresh`,
    auth,
    csrf,
    validate("params", connectionParamsSchema),
    manager,
    asyncHandler(async (req, res) => {
      const refresh = await service.startRefresh(
        currentWorkspace(req).id,
        param(req, "connectionId"),
        currentUser(req).id,
        "manual",
      )
      ok(res, refresh, 202)
    }),
  )

  router.get(
    `${refreshes}/latest`,
    auth,
    validate("params", connectionParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(res, await service.latestRefresh(currentWorkspace(req).id, param(req, "connectionId")))
    }),
  )

  router.get(
    `${refreshes}/:refreshId`,
    auth,
    validate("params", refreshParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(
        res,
        await service.refresh(
          currentWorkspace(req).id,
          param(req, "connectionId"),
          param(req, "refreshId"),
        ),
      )
    }),
  )

  router.post(
    `${refreshes}/:refreshId/cancel`,
    auth,
    csrf,
    validate("params", refreshParamsSchema),
    manager,
    asyncHandler(async (req, res) => {
      ok(
        res,
        await service.cancelRefresh(
          currentWorkspace(req).id,
          param(req, "connectionId"),
          param(req, "refreshId"),
        ),
      )
    }),
  )

  return router
}
