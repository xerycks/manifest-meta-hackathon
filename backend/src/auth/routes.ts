import { Router, type Request, type Response } from "express"
import { z } from "zod"

import type { Env } from "../config/env.js"
import { asyncHandler } from "../shared/http/async-handler.js"
import { AppError } from "../shared/http/errors.js"
import { ok } from "../shared/http/respond.js"
import { validate } from "../shared/http/validate.js"
import { WorkspacesRepository } from "../workspaces/repository.js"
import { GoogleIdentityRejected, type GoogleProvider } from "./google.js"
import {
  cookieFrom,
  currentUser,
  requireAuth,
  requireCsrf,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "./middleware.js"
import { GoogleLoginAttemptsRepository } from "./repository.js"
import { SESSION_TTL_MS, type AuthService } from "./service.js"
import {
  csrfTokenFor,
  newToken,
  openSealedText,
  safeReturnTo,
  sealText,
  tokenDigest,
} from "./tokens.js"

const ATTEMPT_COOKIE = "manifest_google_attempt"
const ATTEMPT_TTL_MS = 10 * 60 * 1000
const randomValue = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

const devLoginSchema = z.object({
  email: z.email(),
  name: z.string().trim().max(120).optional(),
})

const callbackSchema = z.object({
  state: randomValue,
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(256).optional(),
})

export interface AuthDeps {
  auth: AuthService
  attempts: GoogleLoginAttemptsRepository
  workspaces: WorkspacesRepository
  sessionSecret: string
  google: GoogleProvider | null
}

export function authRouter(env: Env, deps: AuthDeps | null): Router {
  const router = Router()
  const secure = env.APP_ORIGIN.startsWith("https:") || env.NODE_ENV === "production"

  router.get("/auth/config", (_req: Request, res: Response) => {
    ok(res, {
      google: Boolean(deps?.google),
      devLogin: Boolean(deps) && env.devLoginEnabled,
      storage: deps ? "configured" : "not-configured",
    })
  })

  if (!deps) {
    router.use("/auth", (_req, _res, next) => next(AppError.storageNotConfigured()))
    router.use("/context", (_req, _res, next) => next(AppError.storageNotConfigured()))
    router.use("/session", (_req, _res, next) => next(AppError.storageNotConfigured()))
    return router
  }

  const { auth, attempts, workspaces, sessionSecret, google } = deps

  function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
    res.cookie(
      SESSION_COOKIE,
      token,
      sessionCookieOptions(secure, Math.min(SESSION_TTL_MS, expiresAt.getTime() - Date.now())),
    )
  }

  async function contextResult(req: Request) {
    const user = currentUser(req)
    const token = req.sessionToken ?? ""
    return {
      user: { id: user.id, email: user.email, name: user.name },
      csrfToken: csrfTokenFor(sessionSecret, token),
      memberships: await workspaces.listForUser(user.id),
    }
  }

  router.get("/auth/google", asyncHandler(async (req, res) => {
    if (!google) throw AppError.googleUnavailable()
    const state = newToken()
    const browser = newToken()
    const nonce = newToken()
    const pkce = await google.createPkce()
    await attempts.begin({
      stateHash: tokenDigest(state),
      browserHash: tokenDigest(browser),
      nonce,
      sealedVerifier: sealText(sessionSecret, pkce.verifier),
      returnTo: safeReturnTo(req.query.returnTo),
      expiresAt: new Date(Date.now() + ATTEMPT_TTL_MS),
    })
    res.cookie(ATTEMPT_COOKIE, browser, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/api/v1/auth/google",
      maxAge: ATTEMPT_TTL_MS,
    })
    res.setHeader("Referrer-Policy", "no-referrer")
    res.redirect(302, google.authorizationUrl({ state, nonce, codeChallenge: pkce.challenge }))
  }))

  router.get("/auth/google/callback", asyncHandler(async (req, res) => {
    if (!google) throw AppError.googleUnavailable()
    res.setHeader("Referrer-Policy", "no-referrer")
    res.clearCookie(ATTEMPT_COOKIE, { path: "/api/v1/auth/google" })
    let returnTo = "/"
    try {
      const query = callbackSchema.safeParse(req.query)
      const browser = randomValue.safeParse(cookieFrom(req, ATTEMPT_COOKIE))
      if (!query.success || !browser.success) {
        throw new GoogleIdentityRejected("Invalid sign-in attempt")
      }
      const attempt = await attempts.consume(
        tokenDigest(query.data.state),
        tokenDigest(browser.data),
      )
      if (!attempt) throw new GoogleIdentityRejected("Expired or consumed sign-in attempt")
      returnTo = safeReturnTo(attempt.returnTo)
      if (query.data.error) {
        const target = new URL(returnTo, env.APP_ORIGIN)
        target.searchParams.set("auth_error", "google_cancelled")
        res.redirect(303, target.href)
        return
      }
      if (!query.data.code) throw new GoogleIdentityRejected("Missing authorization code")
      const identity = await google.exchange({
        code: query.data.code,
        verifier: openSealedText(sessionSecret, attempt.sealedVerifier),
        nonce: attempt.nonce,
      })
      const previous = cookieFrom(req, SESSION_COOKIE)
      const session = await auth.signInWithIdentity(identity)
      if (previous) await auth.logout(previous)
      setSessionCookie(res, session.token, session.expiresAt)
      res.redirect(303, new URL(returnTo, env.APP_ORIGIN).href)
    } catch (error) {
      const failure =
        error instanceof GoogleIdentityRejected ? "google_account_rejected" : "google_unavailable"
      const target = new URL(returnTo, env.APP_ORIGIN)
      target.searchParams.set("auth_error", failure)
      res.redirect(303, target.href)
    }
  }))

  if (env.devLoginEnabled) {
    router.post(
      "/auth/dev",
      validate("body", devLoginSchema),
      asyncHandler(async (req, res) => {
        const input = req.body as z.infer<typeof devLoginSchema>
        const previous = cookieFrom(req, SESSION_COOKIE)
        const session = await auth.signInWithIdentity({
          email: input.email,
          name: input.name ?? "",
        })
        if (previous) await auth.logout(previous)
        setSessionCookie(res, session.token, session.expiresAt)
        req.user = session.user
        req.sessionToken = session.token
        ok(res, await contextResult(req))
      }),
    )
  }

  router.get(
    "/context",
    requireAuth(auth),
    asyncHandler(async (req, res) => {
      ok(res, await contextResult(req))
    }),
  )

  router.delete(
    "/session",
    requireAuth(auth),
    requireCsrf(sessionSecret),
    asyncHandler(async (req, res) => {
      await auth.logout(req.sessionToken ?? "")
      res.clearCookie(SESSION_COOKIE, { path: "/" })
      ok(res, { signedOut: true })
    }),
  )

  return router
}
