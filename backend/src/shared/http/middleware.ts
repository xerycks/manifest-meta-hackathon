import { randomUUID } from "node:crypto"

import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express"

import type { Env } from "../../config/env.js"
import { AppError } from "./errors.js"

declare global {
  namespace Express {
    interface Request {
      requestId: string
    }
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.headers["x-request-id"]
  req.requestId = typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID()
  res.setHeader("X-Request-Id", req.requestId)
  next()
}

export function cors(env: Env): RequestHandler {
  return (req: Request, res: Response, next) => {
    const origin = req.headers.origin
    if (origin && env.CORS_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin)
      res.setHeader("Vary", "Origin")
      res.setHeader("Access-Control-Allow-Credentials", "true")
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, X-Workspace-Id, X-Request-Id, X-Manifest-CSRF",
      )
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
      if (req.method === "OPTIONS") {
        res.status(204).end()
        return
      }
    }
    next()
  }
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`No route matches ${req.method} ${req.path}`))
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof AppError) {
    for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value)
    res.status(error.status).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
        requestId: req.requestId,
      },
    })
    return
  }

  // Body-parser failures (malformed JSON, oversized payloads) are client errors.
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : NaN
  if (status === 400 || status === 413) {
    res.status(status).json({
      success: false,
      error: {
        code: "BAD_REQUEST",
        message: status === 413 ? "Request body is too large" : "Malformed request body",
        requestId: req.requestId,
      },
    })
    return
  }

  console.error(`[${req.requestId}] Unhandled error`, error)
  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again.",
      requestId: req.requestId,
    },
  })
}
