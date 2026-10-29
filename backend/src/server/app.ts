import express, { type Express, type Request, type Response } from "express"
import type { Pool } from "pg"

import type { Env } from "../config/env.js"
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
  workspaces?: WorkspaceDeps | null
}

export function createApp(env: Env, deps: AppDeps = {}): Express {
  const app = express()
  const startedAt = Date.now()

  const workspaceDeps: WorkspaceDeps | null =
    deps.workspaces !== undefined
      ? deps.workspaces
      : deps.pool
        ? {
            workspaces: new WorkspacesRepository(deps.pool),
            settings: new WorkspaceSettingsRepository(deps.pool),
          }
        : null

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
  app.use("/api/v1", workspacesRouter(workspaceDeps))

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
