import express, { type Express, type Request, type Response } from "express"

import type { Env } from "../config/env.js"

export interface HealthResult {
  status: "ok"
  service: "manifest-backend"
  uptimeSeconds: number
}

export function createApp(env: Env): Express {
  const app = express()
  const startedAt = Date.now()

  app.disable("x-powered-by")
  app.use(express.json({ limit: "1mb" }))

  app.use((req: Request, res: Response, next) => {
    const origin = req.headers.origin
    if (origin && env.CORS_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin)
      res.setHeader("Vary", "Origin")
      res.setHeader("Access-Control-Allow-Credentials", "true")
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Workspace-Id")
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
      if (req.method === "OPTIONS") {
        res.status(204).end()
        return
      }
    }
    next()
  })

  const health = (_req: Request, res: Response) => {
    const result: HealthResult = {
      status: "ok",
      service: "manifest-backend",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }
    res.json({ success: true, result })
  }

  app.get("/health", health)
  app.get("/api/health", health)

  return app
}
