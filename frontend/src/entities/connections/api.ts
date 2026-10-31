import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiRequest } from "@/shared/api/client.ts"
import { retryServerErrors } from "@/shared/api/retry.ts"
import { workspacePath } from "@/shared/api/workspace-scope.ts"

import type {
  Connection,
  ConnectionTestResult,
  CreateConnectionInput,
  TestConnectionInput,
  UpdateConnectionInput,
} from "./types.ts"

// Query keys hold ids only — never connection settings or passwords.
const connectionsKey = (workspaceId: string | null) => ["connections", workspaceId] as const
const connectionKey = (workspaceId: string | null, connectionId: string) =>
  [...connectionsKey(workspaceId), connectionId] as const

function requireWorkspace(workspaceId: string | null): string {
  if (!workspaceId) throw new Error("Select a workspace first")
  return workspaceId
}

export function useConnections(workspaceId: string | null) {
  return useQuery({
    queryKey: connectionsKey(workspaceId),
    enabled: workspaceId !== null,
    queryFn: ({ signal }) =>
      apiRequest<Connection[]>(workspacePath(workspaceId as string, "/connections"), {
        signal,
        workspaceId,
      }),
    retry: retryServerErrors,
  })
}

export function useConnection(workspaceId: string | null, connectionId: string) {
  return useQuery({
    queryKey: connectionKey(workspaceId, connectionId),
    enabled: workspaceId !== null,
    queryFn: ({ signal }) =>
      apiRequest<Connection>(
        workspacePath(workspaceId as string, `/connections/${encodeURIComponent(connectionId)}`),
        { signal, workspaceId },
      ),
    retry: retryServerErrors,
  })
}

/** Schemas currently on the server, read with the saved settings (owners and admins). */
export function useConnectionSchemas(
  workspaceId: string | null,
  connectionId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...connectionKey(workspaceId, connectionId), "schemas"],
    enabled: enabled && workspaceId !== null,
    queryFn: ({ signal }) =>
      apiRequest<string[]>(
        workspacePath(
          workspaceId as string,
          `/connections/${encodeURIComponent(connectionId)}/schemas`,
        ),
        { signal, workspaceId },
      ),
    retry: false,
  })
}

// Mutations that carry a password drop their variables as soon as the form unmounts.

export function useTestConnection(workspaceId: string | null) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: TestConnectionInput) => {
      const id = requireWorkspace(workspaceId)
      return apiRequest<ConnectionTestResult>(workspacePath(id, "/connections/test"), {
        method: "POST",
        body: input,
        workspaceId: id,
      })
    },
  })
}

export function useCreateConnection(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (input: CreateConnectionInput) => {
      const id = requireWorkspace(workspaceId)
      return apiRequest<Connection>(workspacePath(id, "/connections"), {
        method: "POST",
        body: input,
        workspaceId: id,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectionsKey(workspaceId) }),
  })
}

export function useUpdateConnection(workspaceId: string | null, connectionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (input: UpdateConnectionInput) => {
      const id = requireWorkspace(workspaceId)
      return apiRequest<Connection>(
        workspacePath(id, `/connections/${encodeURIComponent(connectionId)}`),
        { method: "PATCH", body: input, workspaceId: id },
      )
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectionsKey(workspaceId) }),
  })
}

export function useRetestConnection(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (connectionId: string) => {
      const id = requireWorkspace(workspaceId)
      return apiRequest<{ connection: Connection; test: ConnectionTestResult }>(
        workspacePath(id, `/connections/${encodeURIComponent(connectionId)}/test`),
        { method: "POST", workspaceId: id },
      )
    },
    // A failed retest is recorded on the source too, so refresh either way.
    onSettled: () => queryClient.invalidateQueries({ queryKey: connectionsKey(workspaceId) }),
  })
}

export function useDeleteConnection(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (connectionId: string) => {
      const id = requireWorkspace(workspaceId)
      return apiRequest<{ deleted: true }>(
        workspacePath(id, `/connections/${encodeURIComponent(connectionId)}`),
        { method: "DELETE", workspaceId: id },
      )
    },
    onSuccess: (_result, connectionId) => {
      queryClient.removeQueries({ queryKey: connectionKey(workspaceId, connectionId) })
      return queryClient.invalidateQueries({ queryKey: connectionsKey(workspaceId) })
    },
  })
}
