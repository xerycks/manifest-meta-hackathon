import { Router } from "express"

import { requireAuth } from "../auth/middleware.js"
import type { AuthService } from "../auth/service.js"
import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import { ok } from "../shared/http/respond.js"
import { validate } from "../shared/http/validate.js"
import { currentWorkspace, requireMembership } from "../workspaces/access.js"
import type { WorkspacesRepository } from "../workspaces/repository.js"
import type { SearchRepository } from "./repository.js"
import { searchParamsSchema, searchQuerySchema, type SearchQuery } from "./schemas.js"

export interface SearchDeps {
  workspaces: WorkspacesRepository
  auth: AuthService
  search: SearchRepository
}

/** GET /workspaces/:workspaceId/search?q= for any member. */
export function searchRouter(deps: SearchDeps | null): Router {
  const router = Router()
  const path = "/workspaces/:workspaceId/search"

  if (!deps) {
    router.use(path, (_req, _res, next) => next(AppError.storageNotConfigured()))
    return router
  }

  router.get(
    path,
    requireAuth(deps.auth),
    validate("params", searchParamsSchema),
    requireMembership(deps.workspaces),
    validate("query", searchQuerySchema),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as SearchQuery
      ok(res, await deps.search.search(currentWorkspace(req).id, query))
    }),
  )

  return router
}
