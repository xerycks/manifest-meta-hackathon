import type { NextFunction, Request, Response } from "express"

import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import type { User } from "./repository.js"
import type { AuthService } from "./service.js"
import { csrfTokenFor, safeEqual } from "./tokens.js"

export const SESSION_COOKIE = "manifest_session"
export const CSRF_HEADER = "x-manifest-csrf"

declare global {
  namespace Express {
    interface Request {
      user?: User
      sessionToken?: string
    }
  }
}

export function cookieFrom(req: Request, name: string): string {
  const header = req.headers.cookie
  if (!header) return ""
  for (const part of header.split(";")) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${name}=`)) {
      try {
        return decodeURIComponent(trimmed.slice(name.length + 1))
      } catch {
        return ""
      }
    }
  }
  return ""
}

export function sessionCookieOptions(secure: boolean, maxAgeMs: number) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.max(0, maxAgeMs),
  }
}

export function requireAuth(auth: AuthService) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const token = cookieFrom(req, SESSION_COOKIE)
    const { user } = await auth.authenticate(token)
    req.user = user
    req.sessionToken = token
    next()
  })
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/** Cookie-authenticated mutations must carry the per-session CSRF token. */
export function requireCsrf(sessionSecret: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) {
      next()
      return
    }
    const token = req.sessionToken
    const presented = req.get(CSRF_HEADER) ?? ""
    if (!token || !presented || !safeEqual(presented, csrfTokenFor(sessionSecret, token))) {
      next(AppError.csrf())
      return
    }
    next()
  }
}

export function currentUser(req: Request): User {
  if (!req.user) throw AppError.unauthorized()
  return req.user
}
