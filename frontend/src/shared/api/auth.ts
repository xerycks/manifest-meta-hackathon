import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import type { WorkspaceRole } from "@/app/organization-role.ts"

import { ApiError, apiRequest, setCsrfToken } from "./client.ts"
import type { Workspace } from "./workspaces.ts"

export interface SessionUser {
  id: string
  email: string
  name: string
}

export interface WorkspaceMembership extends Workspace {
  role: WorkspaceRole
}

export interface SessionContext {
  user: SessionUser
  csrfToken: string
  memberships: WorkspaceMembership[]
}

export interface AuthConfig {
  google: boolean
  devLogin: boolean
  storage: "configured" | "not-configured"
}

export const CONTEXT_QUERY_KEY = ["context"] as const

export function useSessionContext() {
  return useQuery({
    queryKey: CONTEXT_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const context = await apiRequest<SessionContext>("/api/v1/context", { signal })
      setCsrfToken(context.csrfToken)
      return context
    },
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 401 || error.status === 503)) {
        return false
      }
      return failureCount < 2
    },
  })
}

export function useAuthConfig() {
  return useQuery({
    queryKey: ["auth-config"],
    queryFn: ({ signal }) => apiRequest<AuthConfig>("/api/v1/auth/config", { signal }),
    retry: 1,
  })
}

export function useDevLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { email: string; name?: string }) => {
      const context = await apiRequest<SessionContext>("/api/v1/auth/dev", {
        method: "POST",
        body: input,
      })
      setCsrfToken(context.csrfToken)
      return context
    },
    onSuccess: (context) => {
      queryClient.setQueryData(CONTEXT_QUERY_KEY, context)
    },
  })
}

export function useSignOut() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiRequest<{ signedOut: true }>("/api/v1/session", { method: "DELETE" }),
    onSettled: async () => {
      setCsrfToken(null)
      queryClient.removeQueries({ queryKey: CONTEXT_QUERY_KEY })
      await queryClient.invalidateQueries({ queryKey: CONTEXT_QUERY_KEY })
    },
  })
}
