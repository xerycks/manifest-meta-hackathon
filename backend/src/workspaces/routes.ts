import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"

import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import { ok } from "../shared/http/respond.js"
import { validate } from "../shared/http/validate.js"
import {
  type Workspace,
  WorkspacesRepository,
  WorkspaceSettingsRepository,
} from "./repository.js"

export interface WorkspaceDeps {
  workspaces: WorkspacesRepository
  settings: WorkspaceSettingsRepository
}

declare global {
  namespace Express {
    interface Request {
      workspace?: Workspace
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

function requireWorkspace(deps: WorkspaceDeps) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const workspaceId = req.params.workspaceId
    if (!workspaceId) throw AppError.badRequest("Missing workspace id")
    const workspace = await deps.workspaces.getById(workspaceId)
    if (!workspace) throw AppError.notFound("Workspace not found")
    req.workspace = workspace
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

  router.get(
    "/workspaces",
    asyncHandler(async (_req, res) => {
      ok(res, await deps.workspaces.list())
    }),
  )

  router.post(
    "/workspaces",
    validate("body", createWorkspaceSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as z.infer<typeof createWorkspaceSchema>
      try {
        ok(res, await deps.workspaces.create(input), 201)
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
    validate("params", workspaceParamsSchema),
    requireWorkspace(deps),
    asyncHandler(async (req, res) => {
      ok(res, await deps.settings.list(currentWorkspace(req).id))
    }),
  )

  router.get(
    "/workspaces/:workspaceId/settings/:key",
    validate("params", settingParamsSchema),
    requireWorkspace(deps),
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
    validate("params", settingParamsSchema),
    validate("body", settingBodySchema),
    requireWorkspace(deps),
    asyncHandler(async (req, res) => {
      const key = req.params.key
      if (!key) throw AppError.badRequest("Missing setting key")
      const { value } = req.body as z.infer<typeof settingBodySchema>
      ok(res, await deps.settings.set(currentWorkspace(req).id, key, value ?? null))
    }),
  )

  return router
}
