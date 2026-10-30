import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"

import {
  CONTEXT_QUERY_KEY,
  useAuthConfig,
  useDevLogin,
  useSessionContext,
} from "@/shared/api/auth.ts"
import { authErrorMessage } from "@/shared/api/auth-errors.ts"
import { ApiError, buildUrl, SESSION_EXPIRED_EVENT, setCsrfToken } from "@/shared/api/client.ts"
import { useCreateWorkspace } from "@/shared/api/workspaces.ts"
import { Button } from "@/shared/ui/button.tsx"
import { Card, CardDescription, CardTitle } from "@/shared/ui/card.tsx"
import { Input, Label } from "@/shared/ui/fields.tsx"
import { ErrorState, LoadingState } from "@/shared/ui/states.tsx"

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Request failed."
}

function GoogleMark() {
  return (
    <svg aria-hidden width="18" height="18" viewBox="0 0 48 48">
      <path
        fill="#4285F4"
        d="M43.6 24.5c0-1.4-.1-2.8-.4-4.2H24v8h11c-.5 2.6-1.9 4.8-4.1 6.3v5.2h6.6c3.9-3.6 6.1-8.9 6.1-15.3Z"
      />
      <path
        fill="#34A853"
        d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.6-5.2c-1.8 1.2-4.1 1.9-6.9 1.9-5.3 0-9.7-3.5-11.3-8.2H5.9v5.3C9.3 39.5 16.1 44 24 44Z"
      />
      <path
        fill="#FBBC05"
        d="M12.7 27.6a12 12 0 0 1 0-7.2v-5.3H5.9a20 20 0 0 0 0 17.8l6.8-5.3Z"
      />
      <path
        fill="#EA4335"
        d="M24 12.2c3 0 5.6 1 7.6 3l5.7-5.7A19.1 19.1 0 0 0 24 4C16.1 4 9.3 8.5 5.9 15.1l6.8 5.3C14.3 15.7 18.7 12.2 24 12.2Z"
      />
    </svg>
  )
}

function SignInScreen({ initialError }: { initialError: string }) {
  const config = useAuthConfig()
  const devLogin = useDevLogin()
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")

  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`
  const googleUrl = buildUrl(`/api/v1/auth/google?returnTo=${encodeURIComponent(returnTo)}`)

  const onDevLogin = (event: FormEvent) => {
    event.preventDefault()
    devLogin.mutate({ email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}) })
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <p className="text-base font-semibold tracking-tight">Manifest</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="mt-1 text-sm leading-6 text-(--muted)">
            Sign in to open your workspace.
          </p>
        </div>

        {initialError && <ErrorState title="Sign-in did not finish" message={initialError} />}

        {config.isPending && <LoadingState label="Checking sign-in options…" />}

        {config.isSuccess && config.data.google && (
          <a
            href={googleUrl}
            className="flex w-full items-center justify-center gap-3 rounded-md border border-(--border) bg-white px-4 py-2.5 text-sm font-medium hover:bg-(--surface) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
          >
            <GoogleMark />
            Continue with Google
          </a>
        )}

        {config.isSuccess && !config.data.google && !config.data.devLogin && (
          <ErrorState
            title="Sign-in is not configured"
            message="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the backend, or enable ALLOW_DEV_LOGIN for local development."
          />
        )}

        {config.isSuccess && config.data.devLogin && (
          <Card>
            <CardTitle className="text-sm">Local development sign-in</CardTitle>
            <CardDescription>
              No password — for local use only. This is disabled in production.
            </CardDescription>
            <form onSubmit={onDevLogin} className="mt-4 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="dev-email">Email</Label>
                <Input
                  id="dev-email"
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.example"
                  autoComplete="email"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dev-name">Name (optional)</Label>
                <Input
                  id="dev-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Ada Analyst"
                  autoComplete="name"
                />
              </div>
              {devLogin.isError && (
                <ErrorState title="Could not sign in" message={errorMessage(devLogin.error)} />
              )}
              <Button type="submit" className="w-full" disabled={devLogin.isPending || !email}>
                {devLogin.isPending ? "Signing in…" : "Sign in for local development"}
              </Button>
            </form>
          </Card>
        )}
      </div>
    </main>
  )
}

function OnboardingScreen({ email }: { email: string }) {
  const queryClient = useQueryClient()
  const createWorkspace = useCreateWorkspace()
  const [name, setName] = useState("")

  const onCreate = (event: FormEvent) => {
    event.preventDefault()
    const slug = slugify(name)
    if (!slug) return
    createWorkspace.mutate(
      { name: name.trim(), slug },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: CONTEXT_QUERY_KEY })
        },
      },
    )
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Create your workspace</h1>
          <p className="mt-1 text-sm leading-6 text-(--muted)">
            You are signed in as {email}. Your first workspace is yours — you become its owner.
          </p>
        </div>
        <form onSubmit={onCreate} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="onboarding-workspace">Workspace name</Label>
            <Input
              id="onboarding-workspace"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Sales analytics"
              required
            />
          </div>
          {createWorkspace.isError && (
            <ErrorState
              title="Could not create workspace"
              message={errorMessage(createWorkspace.error)}
            />
          )}
          <Button type="submit" className="w-full" disabled={createWorkspace.isPending || !name.trim()}>
            {createWorkspace.isPending ? "Creating…" : "Create workspace"}
          </Button>
        </form>
      </div>
    </main>
  )
}

/** Google identity (or local dev sign-in) opens a server-managed HttpOnly session. */
export function SessionGate({ children }: { children: ReactNode }) {
  const context = useSessionContext()
  const queryClient = useQueryClient()
  const [authError] = useState(() =>
    authErrorMessage(new URLSearchParams(window.location.search).get("auth_error")),
  )

  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has("auth_error")) {
      url.searchParams.delete("auth_error")
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
    }
    const onExpired = () => {
      setCsrfToken(null)
      void queryClient.invalidateQueries({ queryKey: CONTEXT_QUERY_KEY })
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") void context.refetch()
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
      document.removeEventListener("visibilitychange", onVisible)
    }
    // context.refetch is stable enough for this listener registration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient])

  if (context.isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <LoadingState label="Opening Manifest…" />
      </main>
    )
  }

  if (context.isError) {
    const error = context.error
    if (error instanceof ApiError && error.status === 401) {
      return <SignInScreen initialError={authError} />
    }
    return (
      <main className="flex min-h-dvh items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <ErrorState
            title="Workspace unavailable"
            message={errorMessage(error)}
            onRetry={() => void context.refetch()}
          />
        </div>
      </main>
    )
  }

  if (context.data.memberships.length === 0) {
    return <OnboardingScreen email={context.data.user.email} />
  }

  return <>{children}</>
}
