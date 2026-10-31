import { Router, type Request } from "express"

import { currentUser, requireAuth, requireCsrf } from "../auth/middleware.js"
import type { AuthService } from "../auth/service.js"
import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import { ok } from "../shared/http/respond.js"
import { validate } from "../shared/http/validate.js"
import { currentWorkspace, requireMembership } from "../workspaces/access.js"
import type { WorkspacesRepository } from "../workspaces/repository.js"
import {
  agentParamsSchema,
  runEventsQuerySchema,
  runParamsSchema,
  startRunSchema,
  type RunEventsQuery,
  type StartRunInput,
} from "./contracts.js"
import type { AgentService } from "./service.js"

export interface AgentDeps {
  workspaces: WorkspacesRepository
  auth: AuthService
  sessionSecret: string
  /** Null without a usable model provider: routes answer 503. */
  agent: AgentService | null
}

function runId(req: Request): string {
  const id = req.params.runId
  if (!id) throw AppError.badRequest("Missing run id")
  return id
}

/**
 * Questions for any member of the workspace. Conversations and runs are
 * private: other users get the same 404 as a missing run.
 */
export function agentRouter(deps: AgentDeps | null): Router {
  const router = Router()
  const base = "/workspaces/:workspaceId/agent"
  const runs = `${base}/runs`
  const item = `${runs}/:runId`

  if (!deps) {
    router.use(base, (_req, _res, next) => next(AppError.storageNotConfigured()))
    return router
  }

  const auth = requireAuth(deps.auth)
  const csrf = requireCsrf(deps.sessionSecret)
  const member = requireMembership(deps.workspaces)
  const agent = deps.agent

  if (!agent) {
    router.use(base, auth, validate("params", agentParamsSchema), member, (_req, _res, next) =>
      next(AppError.agentNotConfigured()),
    )
    return router
  }

  router.post(
    runs,
    auth,
    csrf,
    validate("params", agentParamsSchema),
    member,
    validate("body", startRunSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as StartRunInput
      ok(res, await agent.start(currentWorkspace(req), currentUser(req).id, input), 202)
    }),
  )

  router.get(
    item,
    auth,
    validate("params", runParamsSchema),
    member,
    validate("query", runEventsQuerySchema),
    asyncHandler(async (req, res) => {
      const { after } = req.query as unknown as RunEventsQuery
      ok(res, await agent.get(currentWorkspace(req).id, currentUser(req).id, runId(req), after))
    }),
  )

  router.post(
    `${item}/cancel`,
    auth,
    csrf,
    validate("params", runParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(res, await agent.cancel(currentWorkspace(req).id, currentUser(req).id, runId(req)))
    }),
  )

  return router
}
