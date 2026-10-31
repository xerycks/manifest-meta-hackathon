import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"

import { ApiError, apiRequest } from "@/shared/api/client.ts"
import { retryServerErrors } from "@/shared/api/retry.ts"
import { workspacePath } from "@/shared/api/workspace-scope.ts"

import { endedRefreshId, isRefreshActive, refreshEndedSince } from "./refresh-state.ts"
import type { ConnectionManifest, ManifestObjectDetail, ManifestRefresh } from "./types.ts"

/** How often progress is polled while a refresh is queued or running. */
const REFRESH_POLL_MS = 1_000

const manifestKey = (workspaceId: string | null, connectionId: string) =>
  ["manifests", workspaceId, connectionId] as const
const browseKey = (workspaceId: string | null, connectionId: string) =>
  [...manifestKey(workspaceId, connectionId), "browse"] as const
const objectsKey = (workspaceId: string | null, connectionId: string) =>
  [...manifestKey(workspaceId, connectionId), "objects"] as const
const refreshKey = (workspaceId: string | null, connectionId: string) =>
  [...manifestKey(workspaceId, connectionId), "latest-refresh"] as const

function manifestPath(workspaceId: string, connectionId: string, subpath = ""): string {
  return workspacePath(workspaceId, `/connections/${encodeURIComponent(connectionId)}/manifest${subpath}`)
}

function requireWorkspace(workspaceId: string | null): string {
  if (!workspaceId) throw new Error("Select a workspace first")
  return workspaceId
}

/** Published schemas and objects; the previous result stays on screen while a search loads. */
export function useManifest(workspaceId: string | null, connectionId: string, search: string) {
  return useQuery({
    queryKey: [...browseKey(workspaceId, connectionId), search],
    enabled: workspaceId !== null,
    queryFn: ({ signal }) =>
      apiRequest<ConnectionManifest>(
        manifestPath(
          workspaceId as string,
          connectionId,
          search ? `?search=${encodeURIComponent(search)}` : "",
        ),
        { signal, workspaceId },
      ),
    // Keep the last result on screen while a search loads, but never another source's.
    placeholderData: (previous) => (previous?.connectionId === connectionId ? previous : undefined),
    retry: retryServerErrors,
  })
}

export function useManifestObject(
  workspaceId: string | null,
  connectionId: string,
  objectId: string | null,
) {
  return useQuery({
    queryKey: [...objectsKey(workspaceId, connectionId), objectId],
    enabled: workspaceId !== null && objectId !== null,
    queryFn: ({ signal }) =>
      apiRequest<ManifestObjectDetail>(
        manifestPath(
          workspaceId as string,
          connectionId,
          `/objects/${encodeURIComponent(objectId as string)}`,
        ),
        { signal, workspaceId },
      ),
    retry: retryServerErrors,
  })
}

/**
 * The newest refresh run, polled while it is active. When a run ends (one
 * watched here, or a newer one that ended elsewhere, e.g. after the source's
 * schemas changed), the published metadata is reloaded so cached results never
 * outlive the refresh that replaced them.
 */
export function useLatestRefresh(workspaceId: string | null, connectionId: string) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: refreshKey(workspaceId, connectionId),
    enabled: workspaceId !== null,
    queryFn: ({ signal }) =>
      apiRequest<ManifestRefresh | null>(
        manifestPath(workspaceId as string, connectionId, "/refreshes/latest"),
        { signal, workspaceId },
      ),
    refetchInterval: (current) => (isRefreshActive(current.state.data) ? REFRESH_POLL_MS : false),
    staleTime: 0,
    retry: retryServerErrors,
  })

  const ended = endedRefreshId(query.data)
  const previous = useRef(ended)
  useEffect(() => {
    const before = previous.current
    previous.current = ended
    if (refreshEndedSince(before, ended)) {
      void queryClient.invalidateQueries({ queryKey: browseKey(workspaceId, connectionId) })
      void queryClient.invalidateQueries({ queryKey: objectsKey(workspaceId, connectionId) })
    }
  }, [ended, queryClient, workspaceId, connectionId])

  return query
}

export function useStartRefresh(workspaceId: string | null, connectionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiRequest<ManifestRefresh>(
        manifestPath(requireWorkspace(workspaceId), connectionId, "/refresh"),
        { method: "POST", workspaceId },
      ),
    onSuccess: (refresh) => {
      queryClient.setQueryData(refreshKey(workspaceId, connectionId), refresh)
    },
    onError: (error) => {
      // Someone else's refresh is already running: show it.
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: refreshKey(workspaceId, connectionId) })
      }
    },
  })
}

export function useCancelRefresh(workspaceId: string | null, connectionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (refreshId: string) =>
      apiRequest<ManifestRefresh>(
        manifestPath(
          requireWorkspace(workspaceId),
          connectionId,
          `/refreshes/${encodeURIComponent(refreshId)}/cancel`,
        ),
        { method: "POST", workspaceId },
      ),
    onSuccess: (refresh) => {
      queryClient.setQueryData(refreshKey(workspaceId, connectionId), refresh)
    },
    // A refresh that finished first answers 409; either way show its real state.
    onError: () =>
      queryClient.invalidateQueries({ queryKey: refreshKey(workspaceId, connectionId) }),
  })
}
