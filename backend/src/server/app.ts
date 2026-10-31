import { randomBytes } from "node:crypto"

import express, { type Express, type Request, type Response } from "express"
import type { Pool } from "pg"

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
    workspaceDeps = {
      workspaces,
      settings: new WorkspaceSettingsRepository(pool),
      auth,
      sessionSecret,
    }
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
    knowledgeDeps = {
      workspaces,
      auth,
      sessionSecret,
      knowledge: new KnowledgeService(new KnowledgeRepository(pool), connectionsRepository),
    }
    searchDeps = { workspaces, auth, search: new SearchRepository(pool) }
    queriesDeps = {
      workspaces,
      auth,
      sessionSecret,
      executor: connections
        ? new QueryExecutor(
            new QueryExecutionsRepository(pool),
            connections,
            manifestsRepository,
            deps.queries ?? new QueryRunner(),
          )
        : null,
    }
  }

  app.disable("x-powered-by")
  app.use(requestId)
  app.use(cors(env))
  app.use(express.json({ limit: "1mb" }))

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

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
