import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"

import { currentUser, requireAuth, requireCsrf } from "../auth/middleware.js"
import type { AuthService } from "../auth/service.js"
import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import { ok } from "../shared/http/respond.js"
import { validate } from "../shared/http/validate.js"
import {
  type Workspace,
  type WorkspaceRole,
  WorkspacesRepository,
  WorkspaceSettingsRepository,
} from "./repository.js"

export interface WorkspaceDeps {
  workspaces: WorkspacesRepository
  settings: WorkspaceSettingsRepository
  auth: AuthService
  sessionSecret: string
}

declare global {
  namespace Express {
    interface Request {
      workspace?: Workspace
      workspaceRole?: WorkspaceRole
    }
  }
}

const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, "Use lowercase letters, numbers, and hyphens")
  .max(64)

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema,
})

const workspaceParamsSchema = z.object({
  workspaceId: z.uuid(),
})

const settingParamsSchema = z.object({
  workspaceId: z.uuid(),
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
})

const settingBodySchema = z.object({
  value: z.unknown(),
})

/**
 * Membership is the workspace boundary: non-members get the same 404 as a
 * missing workspace, so ids and contents never leak across workspaces.
 */
function requireMembership(deps: WorkspaceDeps, roles?: WorkspaceRole[]) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const user = currentUser(req)
    const workspaceId = req.params.workspaceId
    if (!workspaceId) throw AppError.badRequest("Missing workspace id")
    const role = await deps.workspaces.roleFor(workspaceId, user.id)
    if (!role) throw AppError.notFound("Workspace not found")
    if (roles && !roles.includes(role)) {
      throw AppError.forbidden("Only workspace owners and admins can do this")
    }
    const workspace = await deps.workspaces.getById(workspaceId)
    if (!workspace) throw AppError.notFound("Workspace not found")
    req.workspace = workspace
    req.workspaceRole = role
    next()
  })
}

function currentWorkspace(req: Request): Workspace {
  if (!req.workspace) throw AppError.notFound("Workspace not found")
  return req.workspace
}

export function workspacesRouter(deps: WorkspaceDeps | null): Router {
  const router = Router()

  if (!deps) {
    router.use("/workspaces", (_req, _res, next) => next(AppError.storageNotConfigured()))
    return router
  }

  const auth = requireAuth(deps.auth)
  const csrf = requireCsrf(deps.sessionSecret)

  router.get(
    "/workspaces",
    auth,
    asyncHandler(async (req, res) => {
      ok(res, await deps.workspaces.listForUser(currentUser(req).id))
    }),
  )

  router.post(
    "/workspaces",
    auth,
    csrf,
    validate("body", createWorkspaceSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof createWorkspaceSchema>
      try {
        ok(res, await deps.workspaces.createWithOwner(input, currentUser(req).id), 201)
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code: unknown }).code === "23505"
        ) {
          throw AppError.conflict(`A workspace with slug "${input.slug}" already exists`)
        }
        throw error
      }
    }),
  )

  router.get(
    "/workspaces/:workspaceId/settings",
    auth,
    validate("params", workspaceParamsSchema),
    requireMembership(deps),
    asyncHandler(async (req, res) => {
      ok(res, await deps.settings.list(currentWorkspace(req).id))
    }),
  )

  router.get(
    "/workspaces/:workspaceId/settings/:key",
    auth,
    validate("params", settingParamsSchema),
    requireMembership(deps),
    asyncHandler(async (req, res) => {
      const key = req.params.key
      if (!key) throw AppError.badRequest("Missing setting key")
      const setting = await deps.settings.get(currentWorkspace(req).id, key)
      if (!setting) throw AppError.notFound(`No setting "${key}" in this workspace`)
      ok(res, setting)
    }),
  )

  router.put(
    "/workspaces/:workspaceId/settings/:key",
    auth,
    csrf,
    validate("params", settingParamsSchema),
    validate("body", settingBodySchema),
    requireMembership(deps, ["owner", "admin"]),
    asyncHandler(async (req, res) => {
      const key = req.params.key
      if (!key) throw AppError.badRequest("Missing setting key")
      const { value } = req.body as z.infer<typeof settingBodySchema>
      ok(res, await deps.settings.set(currentWorkspace(req).id, key, value ?? null))
    }),
  )

  return router
}
