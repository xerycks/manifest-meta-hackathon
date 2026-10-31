import { Router, type Request } from "express"

import { currentUser, requireAuth, requireCsrf } from "../auth/middleware.js"
import type { AuthService } from "../auth/service.js"
import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import { ok } from "../shared/http/respond.js"
import { validate } from "../shared/http/validate.js"
import { currentWorkspace, MANAGER_ROLES, requireMembership } from "../workspaces/access.js"
import type { WorkspacesRepository } from "../workspaces/repository.js"
import type { ManifestScope } from "./editor-repository.js"
import {
  columnPatchSchema,
  columnParamsSchema,
  createRelationshipSchema,
  objectPatchSchema,
  relationshipParamsSchema,
  updateRelationshipSchema,
  type ColumnPatch,
  type CreateRelationshipInput,
  type ObjectPatch,
  type UpdateRelationshipInput,
} from "./editor-schemas.js"
import type { ManifestEditorService } from "./editor-service.js"
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
  /** Authored meaning; present whenever `manifests` is. */
  editor: ManifestEditorService | null
}

type IdParam = "connectionId" | "refreshId" | "objectId" | "columnId" | "relationshipId"

/** Ids from params that validate() has already checked. */
function param(req: Request, name: IdParam): string {
  const value = req.params[name]
  if (!value) throw AppError.badRequest(`Missing ${name}`)
  return value
}

function scopeOf(req: Request): ManifestScope {
  return { workspaceId: currentWorkspace(req).id, connectionId: param(req, "connectionId") }
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
  const editor = deps.editor

  if (!service || !editor) {
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

  // Authored meaning (owners and admins) -----------------------------------

  router.patch(
    `${base}/objects/:objectId`,
    auth,
    csrf,
    validate("params", objectParamsSchema),
    manager,
    validate("body", objectPatchSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as ObjectPatch
      const userId = currentUser(req).id
      ok(res, await editor.updateObject(scopeOf(req), param(req, "objectId"), input, userId))
    }),
  )

  router.patch(
    `${base}/columns/:columnId`,
    auth,
    csrf,
    validate("params", columnParamsSchema),
    manager,
    validate("body", columnPatchSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as ColumnPatch
      const userId = currentUser(req).id
      ok(res, await editor.updateColumn(scopeOf(req), param(req, "columnId"), input, userId))
    }),
  )

  router.post(
    `${base}/relationships`,
    auth,
    csrf,
    validate("params", connectionParamsSchema),
    manager,
    validate("body", createRelationshipSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as CreateRelationshipInput
      ok(res, await editor.createRelationship(scopeOf(req), input, currentUser(req).id), 201)
    }),
  )

  router.patch(
    `${base}/relationships/:relationshipId`,
    auth,
    csrf,
    validate("params", relationshipParamsSchema),
    manager,
    validate("body", updateRelationshipSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as UpdateRelationshipInput
      const id = param(req, "relationshipId")
      ok(res, await editor.updateRelationship(scopeOf(req), id, input, currentUser(req).id))
    }),
  )

  router.delete(
    `${base}/relationships/:relationshipId`,
    auth,
    csrf,
    validate("params", relationshipParamsSchema),
    manager,
    asyncHandler(async (req, res) => {
      await editor.deleteRelationship(scopeOf(req), param(req, "relationshipId"))
      ok(res, { deleted: true })
    }),
  )

  return router
}
