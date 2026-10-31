import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiRequest } from "@/shared/api/client.ts"
import { retryServerErrors } from "@/shared/api/retry.ts"
import { workspacePath } from "@/shared/api/workspace-scope.ts"

import type {
  CreateSavedQueryInput,
  RunValues,
  SavedQueryDetail,
  SavedQueryList,
  SavedQueryRun,
  SavedQueryRunPage,
  UpdateSavedQueryInput,
} from "./types.ts"

const PAGE_SIZE = 50
const RUNS_PAGE_SIZE = 10

export const savedQueriesKey = (workspaceId: string | null) => ["saved-queries", workspaceId] as const
const savedQueryKey = (workspaceId: string | null, id: string) =>
  [...savedQueriesKey(workspaceId), "item", id] as const

function requireWorkspace(workspaceId: string | null): string {
  if (!workspaceId) throw new Error("Select a workspace first")
  return workspaceId
}

const itemPath = (workspaceId: string, id: string, subpath = "") =>
  workspacePath(workspaceId, `/saved-queries/${encodeURIComponent(id)}${subpath}`)

/** Saved queries the user may see, recently updated first, one page at a time. */
export function useSavedQueries(workspaceId: string | null, search: string, connectionId: string) {
  return useInfiniteQuery({
    queryKey: [...savedQueriesKey(workspaceId), "list", search, connectionId],
    enabled: workspaceId !== null,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(pageParam) })
      if (search) params.set("search", search)
      if (connectionId) params.set("connectionId", connectionId)
      return apiRequest<SavedQueryList>(
        workspacePath(workspaceId as string, `/saved-queries?${params.toString()}`),
        { signal, workspaceId },
      )
    },
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    // Keep the last results on screen while a search loads, but never another workspace's.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === workspaceId ? previous : undefined,
    retry: retryServerErrors,
  })
}

/** The definition with its resolved defaults, warnings, and latest stored result. */
export function useSavedQuery(workspaceId: string | null, id: string) {
  return useQuery({
    queryKey: savedQueryKey(workspaceId, id),
    enabled: workspaceId !== null && id !== "",
    queryFn: ({ signal }) =>
      apiRequest<SavedQueryDetail>(itemPath(workspaceId as string, id), { signal, workspaceId }),
    retry: retryServerErrors,
  })
}

/** A saved query's runs, newest first. */
export function useSavedQueryRuns(workspaceId: string | null, id: string) {
  return useInfiniteQuery({
    queryKey: [...savedQueryKey(workspaceId, id), "runs"],
    enabled: workspaceId !== null,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      apiRequest<SavedQueryRunPage>(
        itemPath(workspaceId as string, id, `/runs?limit=${RUNS_PAGE_SIZE}&offset=${pageParam}`),
        { signal, workspaceId },
      ),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    retry: retryServerErrors,
  })
}

export function useCreateSavedQuery(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateSavedQueryInput) =>
      apiRequest<SavedQueryDetail>(workspacePath(requireWorkspace(workspaceId), "/saved-queries"), {
        method: "POST",
        body: input,
        workspaceId,
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(savedQueryKey(workspaceId, saved.id), saved)
      await queryClient.invalidateQueries({ queryKey: [...savedQueriesKey(workspaceId), "list"] })
    },
  })
}

/** A save rejected as stale reloads the saved query, so the page shows the newer version. */
export function useUpdateSavedQuery(workspaceId: string | null, id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: UpdateSavedQueryInput) =>
      apiRequest<SavedQueryDetail>(itemPath(requireWorkspace(workspaceId), id), {
        method: "PATCH",
        body: patch,
        workspaceId,
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(savedQueryKey(workspaceId, id), saved)
      await queryClient.invalidateQueries({ queryKey: [...savedQueriesKey(workspaceId), "list"] })
    },
    onError: () => queryClient.invalidateQueries({ queryKey: savedQueryKey(workspaceId, id) }),
  })
}

export function useDeleteSavedQuery(workspaceId: string | null, id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiRequest<{ deleted: true }>(itemPath(requireWorkspace(workspaceId), id), {
        method: "DELETE",
        workspaceId,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: savedQueryKey(workspaceId, id), refetchType: "none" })
      await queryClient.invalidateQueries({ queryKey: [...savedQueriesKey(workspaceId), "list"] })
    },
  })
}

/**
 * Runs the saved query and resolves when it ends, with every returned row.
 * Aborting `signal` closes the request, which also stops the query on the source.
 */
export function useRunSavedQuery(workspaceId: string | null, id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ parameters, signal }: { parameters: RunValues; signal: AbortSignal }) =>
      apiRequest<SavedQueryRun>(itemPath(requireWorkspace(workspaceId), id, "/run"), {
        method: "POST",
        body: { parameters },
        workspaceId,
        signal,
      }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: savedQueryKey(workspaceId, id) }),
        queryClient.invalidateQueries({ queryKey: [...savedQueriesKey(workspaceId), "list"] }),
      ]),
  })
}
