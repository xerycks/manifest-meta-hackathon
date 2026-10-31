import type { NextFunction, Request, Response } from "express"

import { currentUser } from "../auth/middleware.js"
import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import type { Workspace, WorkspaceRole, WorkspacesRepository } from "./repository.js"

declare global {
  namespace Express {
    interface Request {
      workspace?: Workspace
      workspaceRole?: WorkspaceRole
    }
  }
}

export const MANAGER_ROLES: WorkspaceRole[] = ["owner", "admin"]

/**
 * Membership is the workspace boundary: non-members get the same 404 as a
 * missing workspace, so ids and contents never leak across workspaces.
 * Every workspace-scoped feature router mounts this after requireAuth.
 */
export function requireMembership(workspaces: WorkspacesRepository, roles?: WorkspaceRole[]) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const user = currentUser(req)
    const workspaceId = req.params.workspaceId
    if (!workspaceId) throw AppError.badRequest("Missing workspace id")
    const role = await workspaces.roleFor(workspaceId, user.id)
    if (!role) throw AppError.notFound("Workspace not found")
    if (roles && !roles.includes(role)) {
      throw AppError.forbidden("Only workspace owners and admins can do this")
    }
    const workspace = await workspaces.getById(workspaceId)
    if (!workspace) throw AppError.notFound("Workspace not found")
    req.workspace = workspace
    req.workspaceRole = role
    next()
  })
}

export function currentWorkspace(req: Request): Workspace {
  if (!req.workspace) throw AppError.notFound("Workspace not found")
  return req.workspace
}
