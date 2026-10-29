import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiRequest } from "./client.ts"
import { workspacePath } from "./workspace-scope.ts"

export interface Workspace {
  id: string
  slug: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface WorkspaceSetting {
  key: string
  value: unknown
  updatedAt: string
}

export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: ({ signal }) => apiRequest<Workspace[]>("/api/v1/workspaces", { signal }),
    retry: 1,
  })
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; slug: string }) =>
      apiRequest<Workspace>("/api/v1/workspaces", { method: "POST", body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
  })
}

export function useWorkspaceSetting(workspaceId: string | null, key: string) {
  return useQuery({
    queryKey: ["workspace-setting", workspaceId, key],
    enabled: workspaceId !== null,
    queryFn: ({ signal }) =>
      apiRequest<WorkspaceSetting>(workspacePath(workspaceId as string, `/settings/${key}`), {
        signal,
        workspaceId,
      }),
    retry: 1,
  })
}

export function useSetWorkspaceSetting(workspaceId: string | null, key: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (value: unknown) => {
      if (!workspaceId) throw new Error("Select a workspace first")
      return apiRequest<WorkspaceSetting>(workspacePath(workspaceId, `/settings/${key}`), {
        method: "PUT",
        body: { value },
        workspaceId,
      })
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["workspace-setting", workspaceId, key] }),
  })
}
