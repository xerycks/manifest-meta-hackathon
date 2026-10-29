import express, { type Express, type Request, type Response } from "express"

import type { Env } from "../config/env.js"
import { cors, errorHandler, notFoundHandler, requestId } from "../shared/http/middleware.js"
import { ok } from "../shared/http/respond.js"

export interface HealthResult {
  status: "ok"
  service: "manifest-backend"
  uptimeSeconds: number
}

export function createApp(env: Env): Express {
  const app = express()
  const startedAt = Date.now()

  app.disable("x-powered-by")
  app.use(requestId)
  app.use(cors(env))
  app.use(express.json({ limit: "1mb" }))

  const health = (_req: Request, res: Response) => {
    const result: HealthResult = {
      status: "ok",
      service: "manifest-backend",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }
    ok(res, result)
  }

  app.get("/health", health)
  app.get("/api/health", health)
  app.get("/api/v1/ping", (_req: Request, res: Response) => ok(res, { pong: true }))

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
