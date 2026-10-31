import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { searchKey } from "@/entities/manifests/api.ts"
import { apiRequest } from "@/shared/api/client.ts"
import { retryServerErrors } from "@/shared/api/retry.ts"
import { workspacePath } from "@/shared/api/workspace-scope.ts"

import type {
  CreateKnowledgeEntryInput,
  KnowledgeEntry,
  KnowledgeList,
  UpdateKnowledgeEntryInput,
} from "./types.ts"

const PAGE_SIZE = 50

const knowledgeKey = (workspaceId: string | null) => ["knowledge", workspaceId] as const
const entryKey = (workspaceId: string | null, entryId: string) =>
  [...knowledgeKey(workspaceId), "entry", entryId] as const

function requireWorkspace(workspaceId: string | null): string {
  if (!workspaceId) throw new Error("Select a workspace first")
  return workspaceId
}

const entryPath = (workspaceId: string, entryId: string) =>
  workspacePath(workspaceId, `/knowledge/${encodeURIComponent(entryId)}`)

/** Entries newest first (title matches first while searching), one page at a time. */
export function useKnowledgeEntries(workspaceId: string | null, search: string) {
  return useInfiniteQuery({
    queryKey: [...knowledgeKey(workspaceId), "list", search],
    enabled: workspaceId !== null,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(pageParam) })
      if (search) params.set("search", search)
      return apiRequest<KnowledgeList>(
        workspacePath(workspaceId as string, `/knowledge?${params.toString()}`),
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

export function useKnowledgeEntry(workspaceId: string | null, entryId: string) {
  return useQuery({
    queryKey: entryKey(workspaceId, entryId),
    enabled: workspaceId !== null,
    queryFn: ({ signal }) =>
      apiRequest<KnowledgeEntry>(entryPath(workspaceId as string, entryId), { signal, workspaceId }),
    retry: retryServerErrors,
  })
}

/** Lists and search show entry titles and excerpts, so every change reloads them. */
function useReloadLists(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [...knowledgeKey(workspaceId), "list"] }),
      queryClient.invalidateQueries({ queryKey: searchKey(workspaceId) }),
    ])
}

export function useCreateKnowledgeEntry(workspaceId: string | null) {
  const queryClient = useQueryClient()
  const reloadLists = useReloadLists(workspaceId)
  return useMutation({
    mutationFn: (input: CreateKnowledgeEntryInput) =>
      apiRequest<KnowledgeEntry>(workspacePath(requireWorkspace(workspaceId), "/knowledge"), {
        method: "POST",
        body: input,
        workspaceId,
      }),
    onSuccess: async (entry) => {
      queryClient.setQueryData(entryKey(workspaceId, entry.id), entry)
      await reloadLists()
    },
  })
}

/** A save rejected as stale reloads the entry, so the page shows the newer version. */
export function useUpdateKnowledgeEntry(workspaceId: string | null, entryId: string) {
  const queryClient = useQueryClient()
  const reloadLists = useReloadLists(workspaceId)
  return useMutation({
    mutationFn: (patch: UpdateKnowledgeEntryInput) =>
      apiRequest<KnowledgeEntry>(entryPath(requireWorkspace(workspaceId), entryId), {
        method: "PATCH",
        body: patch,
        workspaceId,
      }),
    onSuccess: async (entry) => {
      queryClient.setQueryData(entryKey(workspaceId, entryId), entry)
      await reloadLists()
    },
    onError: () => queryClient.invalidateQueries({ queryKey: entryKey(workspaceId, entryId) }),
  })
}

/**
 * The caller leaves the entry's page on success; lists and search are reloaded,
 * and the cached entry is marked stale so going back does not show it as current.
 */
export function useDeleteKnowledgeEntry(workspaceId: string | null, entryId: string) {
  const queryClient = useQueryClient()
  const reloadLists = useReloadLists(workspaceId)
  return useMutation({
    mutationFn: () =>
      apiRequest<{ deleted: true }>(entryPath(requireWorkspace(workspaceId), entryId), {
        method: "DELETE",
        workspaceId,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: entryKey(workspaceId, entryId),
        refetchType: "none",
      })
      await reloadLists()
    },
  })
}
