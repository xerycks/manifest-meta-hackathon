import express, { Router, type Request } from "express"

import { currentUser, requireAuth, requireCsrf } from "../auth/middleware.js"
import type { AuthService } from "../auth/service.js"
import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import { EventStream } from "../shared/http/event-stream.js"
import { ok } from "../shared/http/respond.js"
import { validate } from "../shared/http/validate.js"
import { currentWorkspace, requireMembership } from "../workspaces/access.js"
import type { WorkspacesRepository } from "../workspaces/repository.js"
import {
  agentParamsSchema,
  answerRunSchema,
  conversationParamsSchema,
  conversationQuerySchema,
  listConversationsQuerySchema,
  renameConversationSchema,
  runEventsQuerySchema,
  runParamsSchema,
  startRunSchema,
  type AnswerRunInput,
  type ConversationQuery,
  type ListConversationsQuery,
  type RenameConversationInput,
  type RunEventsQuery,
  type StartRunInput,
} from "./contracts.js"
import type { AgentService } from "./service.js"

/**
 * Starting a run may carry up to three 256 KB files in base64, so its body
 * limit is larger than the app's 1 MB; the app skips its own JSON parser for
 * requests this matches.
 */
export const START_RUN_PATH = /^\/api\/v1\/workspaces\/[^/]+\/agent\/runs\/?$/
const START_RUN_BODY_LIMIT = "1200kb"

export interface AgentDeps {
  workspaces: WorkspacesRepository
  auth: AuthService
  sessionSecret: string
  /** Null without a usable model provider: routes answer 503. */
  agent: AgentService | null
  /** Heartbeat interval of event streams; shorter in tests. */
  heartbeatMs?: number
}

function param(req: Request, name: "runId" | "conversationId"): string {
  const id = req.params[name]
  if (!id) throw AppError.badRequest(`Missing ${name}`)
  return id
}

/**
 * The sequence a reconnecting EventSource last received, from its Last-Event-ID
 * header; ignored unless it is a sequence ?after= would accept.
 */
function lastEventId(req: Request): number {
  const parsed = runEventsQuerySchema.shape.after.safeParse(req.get("Last-Event-ID"))
  return parsed.success ? (parsed.data ?? 0) : 0
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
  const conversations = `${base}/conversations`
  const conversation = `${conversations}/:conversationId`

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
    express.json({ limit: START_RUN_BODY_LIMIT }),
    auth,
    csrf,
    validate("params", agentParamsSchema),
    member,
    validate("body", startRunSchema),
    asyncHandler(async (req, res) => {
      const input = req.body as StartRunInput
      const { run, created } = await agent.start(currentWorkspace(req), currentUser(req).id, input)
      // A question sent again with the same mutationId returns the run it started.
      ok(res, run, created ? 202 : 200)
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
      ok(res, await agent.get(currentWorkspace(req).id, currentUser(req).id, param(req, "runId"), after))
    }),
  )

  // Server-Sent Events: the stored events after ?after= (or Last-Event-ID when
  // reconnecting), then live ones, each with id = seq, until the terminal event.
  router.get(
    `${item}/events`,
    auth,
    validate("params", runParamsSchema),
    member,
    validate("query", runEventsQuerySchema),
    asyncHandler(async (req, res) => {
      const { after = 0 } = req.query as unknown as RunEventsQuery
      const stream = new EventStream(res, deps.heartbeatMs)
      try {
        const stop = await agent.follow(
          currentWorkspace(req).id,
          currentUser(req).id,
          param(req, "runId"),
          Math.max(after, lastEventId(req)),
          { send: (event) => stream.send(String(event.seq), event), end: () => stream.end() },
        )
        stream.whenClosed(stop)
        stream.open()
      } catch (error) {
        if (!stream.opened) throw error
        // Mid-stream: the client reconnects from the last event it received.
        console.error(`Agent run event stream failed (request ${req.requestId})`, error)
        stream.end()
      }
    }),
  )

  router.post(
    `${item}/answer`,
    auth,
    csrf,
    validate("params", runParamsSchema),
    member,
    validate("body", answerRunSchema),
    asyncHandler(async (req, res) => {
      const { answer } = req.body as AnswerRunInput
      ok(res, await agent.answer(currentWorkspace(req), currentUser(req).id, param(req, "runId"), answer))
    }),
  )

  router.post(
    `${item}/cancel`,
    auth,
    csrf,
    validate("params", runParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      ok(res, await agent.cancel(currentWorkspace(req).id, currentUser(req).id, param(req, "runId")))
    }),
  )

  // An interrupted question asked again, once, in its conversation.
  router.post(
    `${item}/retry`,
    auth,
    csrf,
    validate("params", runParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      const { run, created } = await agent.retry(
        currentWorkspace(req),
        currentUser(req).id,
        param(req, "runId"),
      )
      ok(res, run, created ? 202 : 200)
    }),
  )

  router.get(
    conversations,
    auth,
    validate("params", agentParamsSchema),
    member,
    validate("query", listConversationsQuerySchema),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as ListConversationsQuery
      ok(res, await agent.list(currentWorkspace(req).id, currentUser(req).id, query))
    }),
  )

  router.get(
    conversation,
    auth,
    validate("params", conversationParamsSchema),
    member,
    validate("query", conversationQuerySchema),
    asyncHandler(async (req, res) => {
      const { before } = req.query as unknown as ConversationQuery
      ok(
        res,
        await agent.conversation(
          currentWorkspace(req).id,
          currentUser(req).id,
          param(req, "conversationId"),
          before,
        ),
      )
    }),
  )

  router.patch(
    conversation,
    auth,
    csrf,
    validate("params", conversationParamsSchema),
    member,
    validate("body", renameConversationSchema),
    asyncHandler(async (req, res) => {
      const { title } = req.body as RenameConversationInput
      ok(
        res,
        await agent.rename(
          currentWorkspace(req).id,
          currentUser(req).id,
          param(req, "conversationId"),
          title,
        ),
      )
    }),
  )

  router.delete(
    conversation,
    auth,
    csrf,
    validate("params", conversationParamsSchema),
    member,
    asyncHandler(async (req, res) => {
      await agent.remove(currentWorkspace(req).id, currentUser(req).id, param(req, "conversationId"))
      ok(res, { deleted: true })
    }),
  )

  return router
}
