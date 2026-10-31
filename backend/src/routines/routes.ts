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
  createRoutineSchema,
  listRunsSchema,
  routineParamsSchema,
  runRoutineSchema,
  schedulePreviewSchema,
  updateRoutineSchema,
  workspaceParamsSchema,
  type CreateRoutineInput,
  type ListRunsQuery,
  type RunRoutineInput,
  type SchedulePreviewQuery,
  type UpdateRoutineInput,
} from "./schemas.js"
import type { Actor, RoutinesService } from "./service.js"

export interface RoutinesDeps {
  workspaces: WorkspacesRepository
  auth: AuthService
  sessionSecret: string
  /** Null when CONNECTION_ENCRYPTION_KEY is missing: routes answer 503. */
  routines: RoutinesService | null
}

function routineId(req: Request): string {
  const id = req.params.routineId
  if (!id) throw AppError.badRequest("Missing routine id")
  return id
}

function actor(req: Request): Actor {
  return { userId: currentUser(req).id, role: currentRole(req) }
}

/**
 * Routines for any member to view and create. The routine's owner, or a
 * workspace owner or admin, changes, pauses, resumes, runs, and deletes it.
 */
export function routinesRouter(deps: RoutinesDeps | null): Router {
  const router = Router()
  const collection = "/workspaces/:workspaceId/routines"
  const item = `${collection}/:routineId`

  if (!deps) {
    router.use(collection, (_req, _res, next) => next(AppError.storageNotConfigured()))
    return router
  }

  const auth = requireAuth(deps.auth)
  const csrf = requireCsrf(deps.sessionSecret)
  const member = requireMembership(deps.workspaces)
  const service = deps.routines

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
    asyncHandler(async (req, res) => {
      ok(res, await service.list(currentWorkspace(req).id, currentUser(req).id))
    }),
  )

  router.post(
    collection,
    auth,
    csrf,
    validate("params", workspaceParamsSchema),
    member,
    validate("body", createRoutineSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as CreateRoutineInput
      ok(res, await service.create(currentWorkspace(req).id, currentUser(req).id, input), 201)
    }),
  )

  // Before the item routes, which would read "schedule-preview" as a routine id.
  router.get(
    `${collection}/schedule-preview`,
    auth,
    validate("params", workspaceParamsSchema),
    member,
    validate("query", schedulePreviewSchema),
    asyncHandler(async (req, res) => {
      const { cron, timeZone } = req.query as unknown as SchedulePreviewQuery
      ok(res, await service.preview(currentWorkspace(req).id, cron, timeZone))
    }),
  )

  router.get(
    item,
    auth,
    validate("params", routineParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(res, await service.get(currentWorkspace(req).id, currentUser(req).id, routineId(req)))
    }),
  )

  router.patch(
    item,
    auth,
    csrf,
    validate("params", routineParamsSchema),
    member,
    validate("body", updateRoutineSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as UpdateRoutineInput
      ok(res, await service.update(currentWorkspace(req).id, routineId(req), input, actor(req)))
    }),
  )

  router.delete(
    item,
    auth,
    csrf,
    validate("params", routineParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      await service.remove(currentWorkspace(req).id, routineId(req), actor(req))
      ok(res, { deleted: true })
    }),
  )

  router.post(
    `${item}/pause`,
    auth,
    csrf,
    validate("params", routineParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(res, await service.pause(currentWorkspace(req).id, routineId(req), actor(req)))
    }),
  )

  router.post(
    `${item}/resume`,
    auth,
    csrf,
    validate("params", routineParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(res, await service.resume(currentWorkspace(req).id, routineId(req), actor(req)))
    }),
  )

  router.post(
    `${item}/run`,
    auth,
    csrf,
    validate("params", routineParamsSchema),
    member,
    validate("body", runRoutineSchema),
    asyncHandler(async (req, res) => {
      const { mutationId } = req.body as RunRoutineInput
      const { run, created } = await service.runNow(
        currentWorkspace(req).id,
        routineId(req),
        mutationId,
        actor(req),
      )
      // Sending the same mutationId again returns the run it started.
      ok(res, run, created ? 202 : 200)
    }),
  )

  router.get(
    `${item}/runs`,
    auth,
    validate("params", routineParamsSchema),
    member,
    validate("query", listRunsSchema),
    asyncHandler(async (req, res) => {
      const page = req.query as unknown as ListRunsQuery
      ok(res, await service.runs(currentWorkspace(req).id, currentUser(req).id, routineId(req), page))
    }),
  )

  return router
}
