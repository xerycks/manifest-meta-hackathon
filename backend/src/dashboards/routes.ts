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
  createDashboardSchema,
  dashboardParamsSchema,
  panelInputSchema,
  panelParamsSchema,
  reorderPanelsSchema,
  updateDashboardSchema,
  updatePanelSchema,
  workspaceParamsSchema,
  type CreateDashboardInput,
  type PanelInput,
  type ReorderPanelsInput,
  type UpdateDashboardInput,
  type UpdatePanelInput,
} from "./schemas.js"
import type { Actor, DashboardsService } from "./service.js"

export interface DashboardsDeps {
  workspaces: WorkspacesRepository
  auth: AuthService
  sessionSecret: string
  dashboards: DashboardsService
}

function param(req: Request, name: "dashboardId" | "panelId"): string {
  const value = req.params[name]
  if (!value) throw AppError.badRequest(`Missing ${name}`)
  return value
}

function actor(req: Request): Actor {
  return { userId: currentUser(req).id, role: currentRole(req) }
}

/**
 * Dashboards for any member. Workspace-visible ones are everyone's to view;
 * private ones only their creator's (others, owners and admins included, get
 * 404). The creator or an owner or admin edits a dashboard and its panels.
 * They read application storage only; running a panel's saved query goes
 * through the saved-query routes.
 */
export function dashboardsRouter(deps: DashboardsDeps | null): Router {
  const router = Router()
  const collection = "/workspaces/:workspaceId/dashboards"
  const item = `${collection}/:dashboardId`
  const panels = `${item}/panels`
  const panel = `${panels}/:panelId`

  if (!deps) {
    router.use(collection, (_req, _res, next) => next(AppError.storageNotConfigured()))
    return router
  }

  const auth = requireAuth(deps.auth)
  const csrf = requireCsrf(deps.sessionSecret)
  const member = requireMembership(deps.workspaces)
  const service = deps.dashboards

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
    validate("body", createDashboardSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as CreateDashboardInput
      ok(res, await service.create(currentWorkspace(req).id, currentUser(req).id, input), 201)
    }),
  )

  router.get(
    item,
    auth,
    validate("params", dashboardParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(res, await service.get(currentWorkspace(req).id, currentUser(req).id, param(req, "dashboardId")))
    }),
  )

  router.patch(
    item,
    auth,
    csrf,
    validate("params", dashboardParamsSchema),
    member,
    validate("body", updateDashboardSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as UpdateDashboardInput
      ok(res, await service.update(currentWorkspace(req).id, param(req, "dashboardId"), input, actor(req)))
    }),
  )

  router.delete(
    item,
    auth,
    csrf,
    validate("params", dashboardParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      await service.remove(currentWorkspace(req).id, param(req, "dashboardId"), actor(req))
      ok(res, { deleted: true })
    }),
  )

  router.post(
    panels,
    auth,
    csrf,
    validate("params", dashboardParamsSchema),
    member,
    validate("body", panelInputSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as PanelInput
      ok(
        res,
        await service.addPanel(currentWorkspace(req).id, param(req, "dashboardId"), input, actor(req)),
        201,
      )
    }),
  )

  router.put(
    `${panels}/order`,
    auth,
    csrf,
    validate("params", dashboardParamsSchema),
    member,
    validate("body", reorderPanelsSchema),
    asyncHandler(async (req, res) => {
      const { panelIds } = req.body as ReorderPanelsInput
      ok(
        res,
        await service.reorder(currentWorkspace(req).id, param(req, "dashboardId"), panelIds, actor(req)),
      )
    }),
  )

  router.patch(
    panel,
    auth,
    csrf,
    validate("params", panelParamsSchema),
    member,
    validate("body", updatePanelSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as UpdatePanelInput
      ok(
        res,
        await service.updatePanel(
          currentWorkspace(req).id,
          param(req, "dashboardId"),
          param(req, "panelId"),
          input,
          actor(req),
        ),
      )
    }),
  )

  router.delete(
    panel,
    auth,
    csrf,
    validate("params", panelParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      await service.removePanel(
        currentWorkspace(req).id,
        param(req, "dashboardId"),
        param(req, "panelId"),
        actor(req),
      )
      ok(res, { deleted: true })
    }),
  )

  return router
}
