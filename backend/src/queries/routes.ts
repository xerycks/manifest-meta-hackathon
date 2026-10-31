import { Router, type Request } from "express"

import { currentUser, requireAuth, requireCsrf } from "../auth/middleware.js"
import type { AuthService } from "../auth/service.js"
import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import { ok } from "../shared/http/respond.js"
import { validate } from "../shared/http/validate.js"
import { currentRole, currentWorkspace, MANAGER_ROLES, requireMembership } from "../workspaces/access.js"
import type { WorkspacesRepository } from "../workspaces/repository.js"
import { resultCsv } from "./csv.js"
import {
  executionParamsSchema,
  historyQuerySchema,
  queryParamsSchema,
  runQuerySchema,
  type ExecutionRecord,
  type HistoryQuery,
  type RunQueryInput,
} from "./schemas.js"
import type { QueryExecutor } from "./service.js"

export interface QueriesDeps {
  workspaces: WorkspacesRepository
  auth: AuthService
  sessionSecret: string
  /** Null when CONNECTION_ENCRYPTION_KEY is missing: routes answer 503. */
  executor: QueryExecutor | null
}

/** Ids from params that validate() has already checked. */
function param(req: Request, name: "connectionId" | "executionId"): string {
  const value = req.params[name]
  if (!value) throw AppError.badRequest(`Missing ${name}`)
  return value
}

/** Why an export holds fewer rows than matched: the query's own limit, the stored snapshot, or both. */
function truncation(record: ExecutionRecord): string | null {
  const reasons = [record.truncatedBy, record.partialResult ? "snapshot" : null].filter(Boolean)
  return reasons.length > 0 ? reasons.join(", ") : null
}

export function queriesRouter(deps: QueriesDeps | null): Router {
  const router = Router()
  const base = "/workspaces/:workspaceId/connections/:connectionId/queries"
  const item = `${base}/:executionId`

  if (!deps) {
    router.use(base, (_req, _res, next) => next(AppError.storageNotConfigured()))
    return router
  }

  const auth = requireAuth(deps.auth)
  const csrf = requireCsrf(deps.sessionSecret)
  const member = requireMembership(deps.workspaces)
  const manager = requireMembership(deps.workspaces, MANAGER_ROLES)
  const executor = deps.executor

  if (!executor) {
    router.use(
      base,
      auth,
      validate("params", queryParamsSchema),
      member,
      (_req, _res, next) => next(AppError.connectionsNotConfigured()),
    )
    return router
  }

  // Developer console: owners and admins run read queries directly.
  router.post(
    base,
    auth,
    csrf,
    validate("params", queryParamsSchema),
    manager,
    validate("body", runQuerySchema),
    asyncHandler(async (req, res) => {
      const input = req.body as RunQueryInput
      // A client that goes away before the answer cancels the query on the source.
      const disconnected = new AbortController()
      res.on("close", () => {
        if (!res.writableFinished) disconnected.abort("disconnected")
      })
      const record = await executor.execute({
        workspaceId: currentWorkspace(req).id,
        userId: currentUser(req).id,
        connectionId: param(req, "connectionId"),
        origin: "console",
        id: input.id,
        query: input.query,
        limits: {
          ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        },
        signal: disconnected.signal,
      })
      if (record.status === "rejected") {
        throw AppError.queryRejected(record.error?.message ?? "This query is not allowed.", {
          executionId: record.id,
          reason: record.error?.reason ?? null,
          name: record.error?.name ?? null,
        })
      }
      ok(res, record)
    }),
  )

  router.get(
    base,
    auth,
    validate("params", queryParamsSchema),
    manager,
    validate("query", historyQuerySchema),
    asyncHandler(async (req, res) => {
      const { limit } = req.query as unknown as HistoryQuery
      ok(res, await executor.history(currentWorkspace(req).id, param(req, "connectionId"), limit))
    }),
  )

  // Any member may read an execution, e.g. through an answer's evidence link.
  router.get(
    item,
    auth,
    validate("params", executionParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(
        res,
        await executor.get(
          currentWorkspace(req).id,
          param(req, "connectionId"),
          param(req, "executionId"),
        ),
      )
    }),
  )

  // The stored rows of any run a member may open, as CSV: the same cells the
  // run's page shows, in its column order.
  router.get(
    `${item}/export.csv`,
    auth,
    validate("params", executionParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      const record = await executor.get(
        currentWorkspace(req).id,
        param(req, "connectionId"),
        param(req, "executionId"),
      )
      if (!record.result) {
        throw AppError.conflict("Only a query run that succeeded has rows to export.", {
          status: record.status,
        })
      }
      const truncated = truncation(record)
      const day = record.createdAt.slice(0, 10)
      const filename = `manifest-query-${day}-${record.id.slice(0, 8)}${truncated ? "-partial" : ""}.csv`
      res.setHeader("Content-Type", "text/csv; charset=utf-8")
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
      res.setHeader("Cache-Control", "private, no-store")
      res.setHeader("X-Content-Type-Options", "nosniff")
      if (truncated) res.setHeader("X-Manifest-Truncated", truncated)
      res.status(200).send(resultCsv(record.result))
    }),
  )

  router.post(
    `${item}/cancel`,
    auth,
    csrf,
    validate("params", executionParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(
        res,
        await executor.cancel({
          workspaceId: currentWorkspace(req).id,
          connectionId: param(req, "connectionId"),
          executionId: param(req, "executionId"),
          userId: currentUser(req).id,
          role: currentRole(req),
        }),
      )
    }),
  )

  return router
}
