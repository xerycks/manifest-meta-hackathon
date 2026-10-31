import { randomBytes } from "node:crypto"

import express, { type Express, type Request, type Response } from "express"
import type { Pool } from "pg"

import { agentLimits, createModelProvider } from "../agent/config.js"
import type { ModelProvider } from "../agent/provider.js"
import { AgentRunsRepository } from "../agent/repository.js"
import { agentRouter, START_RUN_PATH, type AgentDeps } from "../agent/routes.js"
import { AgentRunner } from "../agent/runner.js"
import { AgentService } from "../agent/service.js"
import { createAgentTools } from "../agent/tools.js"
import { createGoogleProvider, type GoogleProvider } from "../auth/google.js"
import {
  GoogleLoginAttemptsRepository,
  SessionsRepository,
  UsersRepository,
} from "../auth/repository.js"
import { authRouter, type AuthDeps } from "../auth/routes.js"
import { AuthService } from "../auth/service.js"
import type { Env } from "../config/env.js"
import { createSourceAdapters } from "../connections/adapters/index.js"
import type { SourceAdapters } from "../connections/adapters/types.js"
import { CredentialSealer } from "../connections/credentials.js"
import { ConnectionsRepository } from "../connections/repository.js"
import { connectionsRouter, type ConnectionsDeps } from "../connections/routes.js"
import { ConnectionsService } from "../connections/service.js"
import { DashboardRefresher } from "../dashboards/refresh.js"
import { DashboardsRepository } from "../dashboards/repository.js"
import { dashboardsRouter, type DashboardsDeps } from "../dashboards/routes.js"
import { DashboardsService } from "../dashboards/service.js"
import { KnowledgeRepository } from "../knowledge/repository.js"
import { knowledgeRouter, type KnowledgeDeps } from "../knowledge/routes.js"
import { KnowledgeService } from "../knowledge/service.js"
import { ManifestEditsRepository } from "../manifests/editor-repository.js"
import { ManifestEditorService } from "../manifests/editor-service.js"
import { ManifestsRepository } from "../manifests/repository.js"
import { manifestsRouter, type ManifestsDeps } from "../manifests/routes.js"
import { RefreshRunner } from "../manifests/runner.js"
import { ManifestsService } from "../manifests/service.js"
import { QueryExecutionsRepository } from "../queries/repository.js"
import { queriesRouter, type QueriesDeps } from "../queries/routes.js"
import { QueryRunner } from "../queries/runner.js"
import { QueryExecutor } from "../queries/service.js"
import { RoutineDispatcher } from "../routines/dispatcher.js"
import { RoutinesRepository } from "../routines/repository.js"
import { routinesRouter, type RoutinesDeps } from "../routines/routes.js"
import { RoutinesService } from "../routines/service.js"
import { SavedQueriesRepository } from "../saved-queries/repository.js"
import { savedQueriesRouter, type SavedQueriesDeps } from "../saved-queries/routes.js"
import { SavedQueriesService } from "../saved-queries/service.js"
import { SearchRepository } from "../search/repository.js"
import { searchRouter, type SearchDeps } from "../search/routes.js"
import { cors, errorHandler, notFoundHandler, requestId } from "../shared/http/middleware.js"
import { ok } from "../shared/http/respond.js"
import { WorkspacesRepository, WorkspaceSettingsRepository } from "../workspaces/repository.js"
import { workspacesRouter, type WorkspaceDeps } from "../workspaces/routes.js"

export interface HealthResult {
  status: "ok"
  service: "manifest-backend"
  uptimeSeconds: number
  storage: "configured" | "not-configured"
}

export interface AppDeps {
  pool?: Pool | null
  sessionSecret?: string
  googleProvider?: GoogleProvider | null
  /** Source adapters (and their pools); pass them in to close them on shutdown. */
  sources?: SourceAdapters
  /** Background manifest refreshes; pass it in to stop them on shutdown. */
  refreshes?: RefreshRunner
  /** Running source queries; pass it in to abort them on shutdown. */
  queries?: QueryRunner
  /** Questions being answered; pass it in to abort them on shutdown. */
  agents?: AgentRunner
  /** Dashboard refreshes; pass it in to stop them on shutdown (or to tune their retries in tests). */
  dashboardRefreshes?: DashboardRefresher
  /**
   * Runs routines; pass it in to start its schedule and stop it on shutdown
   * (or to tick it with a test clock). Without it, only manual runs happen.
   */
  routineDispatcher?: RoutineDispatcher
  /** Replaces the provider configured by AGENT_PROVIDER (null: none, so agent routes answer 503). */
  modelProvider?: ModelProvider | null
  /** Heartbeat interval of agent event streams (15 s by default); shorter in tests. */
  streamHeartbeatMs?: number
}

export function createApp(env: Env, deps: AppDeps = {}): Express {
  const app = express()
  const startedAt = Date.now()
  const pool = deps.pool ?? null

  const sessionSecret =
    deps.sessionSecret ?? env.SESSION_SECRET ?? randomBytes(32).toString("hex")

  let workspaceDeps: WorkspaceDeps | null = null
  let authDeps: AuthDeps | null = null
  let connectionsDeps: ConnectionsDeps | null = null
  let manifestsDeps: ManifestsDeps | null = null
  let knowledgeDeps: KnowledgeDeps | null = null
  let searchDeps: SearchDeps | null = null
  let queriesDeps: QueriesDeps | null = null
  let savedQueriesDeps: SavedQueriesDeps | null = null
  let dashboardsDeps: DashboardsDeps | null = null
  let routinesDeps: RoutinesDeps | null = null
  let agentDeps: AgentDeps | null = null
  if (pool) {
    const auth = new AuthService(new UsersRepository(pool), new SessionsRepository(pool))
    const workspaces = new WorkspacesRepository(pool)
    const google =
      deps.googleProvider !== undefined
        ? deps.googleProvider
        : env.googleEnabled
          ? createGoogleProvider({
              clientId: env.GOOGLE_CLIENT_ID as string,
              clientSecret: env.GOOGLE_CLIENT_SECRET as string,
              redirectUri:
                env.GOOGLE_REDIRECT_URI ?? `http://${env.HOST}:${env.PORT}/api/v1/auth/google/callback`,
            })
          : null
    const settings = new WorkspaceSettingsRepository(pool)
    workspaceDeps = { workspaces, settings, auth, sessionSecret }
    authDeps = {
      auth,
      attempts: new GoogleLoginAttemptsRepository(pool),
      workspaces,
      sessionSecret,
      google,
    }
    const connectionsRepository = new ConnectionsRepository(pool)
    const connections = env.CONNECTION_ENCRYPTION_KEY
      ? new ConnectionsService(
          connectionsRepository,
          new CredentialSealer(env.CONNECTION_ENCRYPTION_KEY),
          deps.sources ?? createSourceAdapters(),
        )
      : null
    const manifestsRepository = new ManifestsRepository(pool)
    const manifests = connections
      ? new ManifestsService(manifestsRepository, connections, deps.refreshes ?? new RefreshRunner())
      : null
    connectionsDeps = {
      workspaces,
      auth,
      sessionSecret,
      connections,
      // New sources and changed schema selections are discovered right away.
      ...(manifests ? { onSourceSaved: manifests.refreshAfterSave.bind(manifests) } : {}),
    }
    manifestsDeps = {
      workspaces,
      auth,
      sessionSecret,
      manifests,
      editor: manifests ? new ManifestEditorService(new ManifestEditsRepository(pool)) : null,
    }
    // Knowledge and search read only application storage, so they work without the key.
    const knowledge = new KnowledgeRepository(pool)
    knowledgeDeps = {
      workspaces,
      auth,
      sessionSecret,
      knowledge: new KnowledgeService(knowledge, connectionsRepository),
    }
    const search = new SearchRepository(pool)
    searchDeps = { workspaces, auth, search }
    const executions = new QueryExecutionsRepository(pool)
    const executor = connections
      ? new QueryExecutor(executions, connections, manifestsRepository, deps.queries ?? new QueryRunner())
      : null
    queriesDeps = { workspaces, auth, sessionSecret, executor }
    // Questions read metadata from storage; queries need the key, and tools say so without it.
    const provider = deps.modelProvider !== undefined ? deps.modelProvider : createModelProvider(env)
    const runs = new AgentRunsRepository(pool)
    const savedQueriesRepository = new SavedQueriesRepository(pool)
    const savedQueries = executor
      ? new SavedQueriesService({
          savedQueries: savedQueriesRepository,
          executions,
          executor,
          settings,
          runs,
        })
      : null
    savedQueriesDeps = { workspaces, auth, sessionSecret, savedQueries }
    // Dashboards show stored results, so they work without the key; refreshing panels needs it.
    dashboardsDeps = {
      workspaces,
      auth,
      sessionSecret,
      dashboards: new DashboardsService({
        dashboards: new DashboardsRepository(pool),
        savedQueries: savedQueriesRepository,
        executions,
        refreshes: savedQueries
          ? { refresher: deps.dashboardRefreshes ?? new DashboardRefresher(), runs: savedQueries }
          : null,
      }),
    }
    const agent = provider
      ? new AgentService({
          runs,
          connections: connectionsRepository,
          manifests: manifestsRepository,
          knowledge,
          settings,
          executions,
          tools: createAgentTools({
            connections: connectionsRepository,
            manifests: manifestsRepository,
            knowledge,
            search,
            executor,
            executions,
            runs,
          }),
          provider,
          runner: deps.agents ?? new AgentRunner(),
          limits: agentLimits(env),
        })
      : null
    agentDeps = {
      workspaces,
      auth,
      sessionSecret,
      runs,
      connections: connectionsRepository,
      ...(deps.streamHeartbeatMs !== undefined ? { heartbeatMs: deps.streamHeartbeatMs } : {}),
      agent,
    }
    // Routines run saved queries and questions, so they need the key like saved queries.
    const dispatcher = deps.routineDispatcher ?? new RoutineDispatcher()
    const routines = savedQueries
      ? new RoutinesService({
          routines: new RoutinesRepository(pool),
          savedQueries: savedQueriesRepository,
          savedQueryRuns: savedQueries,
          agent,
          connections: connectionsRepository,
          workspaces,
          settings,
          dispatcher,
          minIntervalMinutes: env.ROUTINE_MIN_INTERVAL_MINUTES,
        })
      : null
    if (routines) dispatcher.attach(routines)
    routinesDeps = { workspaces, auth, sessionSecret, routines }
  }

  app.disable("x-powered-by")
  app.use(requestId)
  app.use(cors(env))
  const json = express.json({ limit: "1mb" })
  // Starting a question parses its own, larger body (it may carry files).
  app.use((req, res, next) =>
    req.method === "POST" && START_RUN_PATH.test(req.path) ? next() : json(req, res, next),
  )

  const health = (_req: Request, res: Response) => {
    const result: HealthResult = {
      status: "ok",
      service: "manifest-backend",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      storage: workspaceDeps ? "configured" : "not-configured",
    }
    ok(res, result)
  }

  app.get("/health", health)
  app.get("/api/health", health)
  app.get("/api/v1/ping", (_req: Request, res: Response) => ok(res, { pong: true }))
  app.use("/api/v1", authRouter(env, authDeps))
  app.use("/api/v1", workspacesRouter(workspaceDeps))
  app.use("/api/v1", connectionsRouter(connectionsDeps))
  app.use("/api/v1", manifestsRouter(manifestsDeps))
  app.use("/api/v1", knowledgeRouter(knowledgeDeps))
  app.use("/api/v1", searchRouter(searchDeps))
  app.use("/api/v1", queriesRouter(queriesDeps))
  app.use("/api/v1", savedQueriesRouter(savedQueriesDeps))
  app.use("/api/v1", dashboardsRouter(dashboardsDeps))
  app.use("/api/v1", routinesRouter(routinesDeps))
  app.use("/api/v1", agentRouter(agentDeps))

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
