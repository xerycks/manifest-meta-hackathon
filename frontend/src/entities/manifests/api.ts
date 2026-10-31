import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"

import { ApiError, apiRequest } from "@/shared/api/client.ts"
import { retryServerErrors } from "@/shared/api/retry.ts"
import { workspacePath } from "@/shared/api/workspace-scope.ts"

import { endedRefreshId, isRefreshActive, refreshEndedSince } from "./refresh-state.ts"
import type {
  ColumnPatch,
  ConnectionManifest,
  CreateRelationshipInput,
  ManifestColumn,
  ManifestObject,
  ManifestObjectDetail,
  ManifestRefresh,
  ManifestRelationship,
  ObjectPatch,
  SearchResults,
  UpdateRelationshipInput,
} from "./types.ts"

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
/** Workspace-wide search results; anything that changes names or meaning invalidates them. */
export const searchKey = (workspaceId: string | null) => ["search", workspaceId] as const

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
      void queryClient.invalidateQueries({ queryKey: searchKey(workspaceId) })
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

/** Workspace-wide search over manifests and the knowledge base; the last results stay while typing. */
export function useWorkspaceSearch(workspaceId: string | null, query: string) {
  return useQuery({
    queryKey: [...searchKey(workspaceId), query],
    enabled: workspaceId !== null && query.length > 0,
    queryFn: ({ signal }) =>
      apiRequest<SearchResults>(
        workspacePath(workspaceId as string, `/search?q=${encodeURIComponent(query)}`),
        { signal, workspaceId },
      ),
    // Keep the last results on screen while typing, but never another workspace's.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === workspaceId ? previous : undefined,
    retry: retryServerErrors,
  })
}

/**
 * After an edit (or a save rejected as stale) the source's listing, details,
 * and search are reloaded, so the page shows the latest saved version while
 * an open editor keeps its draft.
 */
function useReloadManifest(workspaceId: string | null, connectionId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: browseKey(workspaceId, connectionId) }),
      queryClient.invalidateQueries({ queryKey: objectsKey(workspaceId, connectionId) }),
      queryClient.invalidateQueries({ queryKey: searchKey(workspaceId) }),
    ])
}

export function useUpdateObject(workspaceId: string | null, connectionId: string) {
  const reload = useReloadManifest(workspaceId, connectionId)
  return useMutation({
    mutationFn: ({ objectId, patch }: { objectId: string; patch: ObjectPatch }) =>
      apiRequest<ManifestObject>(
        manifestPath(requireWorkspace(workspaceId), connectionId, `/objects/${encodeURIComponent(objectId)}`),
        { method: "PATCH", body: patch, workspaceId },
      ),
    onSettled: reload,
  })
}

export function useUpdateColumn(workspaceId: string | null, connectionId: string) {
  const reload = useReloadManifest(workspaceId, connectionId)
  return useMutation({
    mutationFn: ({ columnId, patch }: { columnId: string; patch: ColumnPatch }) =>
      apiRequest<ManifestColumn>(
        manifestPath(requireWorkspace(workspaceId), connectionId, `/columns/${encodeURIComponent(columnId)}`),
        { method: "PATCH", body: patch, workspaceId },
      ),
    onSettled: reload,
  })
}

export function useCreateRelationship(workspaceId: string | null, connectionId: string) {
  const reload = useReloadManifest(workspaceId, connectionId)
  return useMutation({
    mutationFn: (input: CreateRelationshipInput) =>
      apiRequest<ManifestRelationship>(
        manifestPath(requireWorkspace(workspaceId), connectionId, "/relationships"),
        { method: "POST", body: input, workspaceId },
      ),
    onSuccess: reload,
  })
}

export function useUpdateRelationship(workspaceId: string | null, connectionId: string) {
  const reload = useReloadManifest(workspaceId, connectionId)
  return useMutation({
    mutationFn: ({ relationshipId, patch }: { relationshipId: string; patch: UpdateRelationshipInput }) =>
      apiRequest<ManifestRelationship>(
        manifestPath(
          requireWorkspace(workspaceId),
          connectionId,
          `/relationships/${encodeURIComponent(relationshipId)}`,
        ),
        { method: "PATCH", body: patch, workspaceId },
      ),
    onSettled: reload,
  })
}

export function useDeleteRelationship(workspaceId: string | null, connectionId: string) {
  const reload = useReloadManifest(workspaceId, connectionId)
  return useMutation({
    mutationFn: (relationshipId: string) =>
      apiRequest<{ deleted: true }>(
        manifestPath(
          requireWorkspace(workspaceId),
          connectionId,
          `/relationships/${encodeURIComponent(relationshipId)}`,
        ),
        { method: "DELETE", workspaceId },
      ),
    onSuccess: reload,
  })
}
