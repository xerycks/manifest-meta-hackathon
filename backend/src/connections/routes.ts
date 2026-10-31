import { Router } from "express"
import { z } from "zod"

import { currentUser, requireAuth, requireCsrf } from "../auth/middleware.js"
import type { AuthService } from "../auth/service.js"
import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import { ok } from "../shared/http/respond.js"
import { validate } from "../shared/http/validate.js"
import { currentWorkspace, MANAGER_ROLES, requireMembership } from "../workspaces/access.js"
import type { WorkspacesRepository } from "../workspaces/repository.js"
import {
  createConnectionSchema,
  testConnectionSchema,
  updateConnectionSchema,
  type CreateConnectionInput,
  type TestConnectionInput,
  type UpdateConnectionInput,
} from "./schemas.js"
import type { ConnectionsService } from "./service.js"

/** A saved source whose readable contents may have changed (new, or other schemas or settings). */
export interface SourceSavedEvent {
  workspaceId: string
  connectionId: string
  userId: string
  trigger: "source_created" | "source_changed"
}

export interface ConnectionsDeps {
  workspaces: WorkspacesRepository
  auth: AuthService
  sessionSecret: string
  /** Null when CONNECTION_ENCRYPTION_KEY is missing: routes answer 503. */
  connections: ConnectionsService | null
  /** Runs after a save, before the response; it must not throw (e.g. starts metadata discovery). */
  onSourceSaved?: (event: SourceSavedEvent) => Promise<void>
}

const workspaceParamsSchema = z.object({ workspaceId: z.uuid() })
const connectionParamsSchema = z.object({ workspaceId: z.uuid(), connectionId: z.uuid() })

function connectionId(params: Record<string, string>): string {
  const id = params.connectionId
  if (!id) throw AppError.badRequest("Missing connection id")
  return id
}

export function connectionsRouter(deps: ConnectionsDeps | null): Router {
  const router = Router()
  const collection = "/workspaces/:workspaceId/connections"
  const item = `${collection}/:connectionId`

  if (!deps) {
    router.use(collection, (_req, _res, next) => next(AppError.storageNotConfigured()))
    return router
  }

  const auth = requireAuth(deps.auth)
  const csrf = requireCsrf(deps.sessionSecret)
  const member = requireMembership(deps.workspaces)
  const manager = requireMembership(deps.workspaces, MANAGER_ROLES)
  const service = deps.connections

  if (!service) {
    router.use(
      collection,
      auth,
      validate("params", workspaceParamsSchema),
      member,
      (_req, _res, next) => next(AppError.connectionsNotConfigured()),
    )
    return router
  }

  router.get(
    collection,
    auth,
    validate("params", workspaceParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(res, await service.list(currentWorkspace(req).id))
    }),
  )

  router.post(
    `${collection}/test`,
    auth,
    csrf,
    validate("params", workspaceParamsSchema),
    manager,
    validate("body", testConnectionSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as TestConnectionInput
      ok(res, await service.testDraft(currentWorkspace(req).id, input))
    }),
  )

  router.post(
    collection,
    auth,
    csrf,
    validate("params", workspaceParamsSchema),
    manager,
    validate("body", createConnectionSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as CreateConnectionInput
      const workspaceId = currentWorkspace(req).id
      const userId = currentUser(req).id
      const connection = await service.create(workspaceId, userId, input)
      await deps.onSourceSaved?.({
        workspaceId,
        connectionId: connection.id,
        userId,
        trigger: "source_created",
      })
      ok(res, connection, 201)
    }),
  )

  router.get(
    item,
    auth,
    validate("params", connectionParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(res, await service.get(currentWorkspace(req).id, connectionId(req.params)))
    }),
  )

  router.patch(
    item,
    auth,
    csrf,
    validate("params", connectionParamsSchema),
    manager,
    validate("body", updateConnectionSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as UpdateConnectionInput
      const workspaceId = currentWorkspace(req).id
      const connection = await service.update(workspaceId, connectionId(req.params), input)
      if (input.schemas !== undefined || input.config !== undefined) {
        await deps.onSourceSaved?.({
          workspaceId,
          connectionId: connection.id,
          userId: currentUser(req).id,
          trigger: "source_changed",
        })
      }
      ok(res, connection)
    }),
  )

  router.post(
    `${item}/test`,
    auth,
    csrf,
    validate("params", connectionParamsSchema),
    manager,
    asyncHandler(async (req, res) => {
      ok(res, await service.retest(currentWorkspace(req).id, connectionId(req.params)))
    }),
  )

  router.get(
    `${item}/schemas`,
    auth,
    validate("params", connectionParamsSchema),
    manager,
    asyncHandler(async (req, res) => {
      ok(res, await service.listSchemas(currentWorkspace(req).id, connectionId(req.params)))
    }),
  )

  router.delete(
    item,
    auth,
    csrf,
    validate("params", connectionParamsSchema),
    manager,
    asyncHandler(async (req, res) => {
      await service.remove(currentWorkspace(req).id, connectionId(req.params))
      ok(res, { deleted: true })
    }),
  )

  return router
}
