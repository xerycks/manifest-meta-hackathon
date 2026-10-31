import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { apiRequest } from "@/shared/api/client.ts"
import { retryServerErrors } from "@/shared/api/retry.ts"
import { workspacePath } from "@/shared/api/workspace-scope.ts"

import { runUnderway } from "./status.ts"
import type {
  CreateRoutineInput,
  RoutineDetail,
  RoutineList,
  RoutineRun,
  RoutineRunPage,
  SchedulePreview,
  UpdateRoutineInput,
} from "./types.ts"

const RUNS_PAGE_SIZE = 20
/** How often a page with a run under way rereads it. */
const RUNNING_INTERVAL_MS = 2_000

const routinesKey = (workspaceId: string | null) => ["routines", workspaceId] as const
const listKey = (workspaceId: string | null) => [...routinesKey(workspaceId), "list"] as const
const routineKey = (workspaceId: string | null, id: string) =>
  [...routinesKey(workspaceId), "item", id] as const

function requireWorkspace(workspaceId: string | null): string {
  if (!workspaceId) throw new Error("Select a workspace first")
  return workspaceId
}

const itemPath = (workspaceId: string, id: string, subpath = "") =>
  workspacePath(workspaceId, `/routines/${encodeURIComponent(id)}${subpath}`)

/** Every routine of the workspace (at most 100), by name; rereads while one is running. */
export function useRoutines(workspaceId: string | null) {
  return useQuery({
    queryKey: listKey(workspaceId),
    enabled: workspaceId !== null,
    queryFn: ({ signal }) =>
      apiRequest<RoutineList>(workspacePath(workspaceId as string, "/routines"), { signal, workspaceId }),
    refetchInterval: (query) =>
      query.state.data?.routines.some((routine) => runUnderway(routine.lastStatus))
        ? RUNNING_INTERVAL_MS
        : false,
    retry: retryServerErrors,
  })
}

export function useRoutine(workspaceId: string | null, id: string) {
  return useQuery({
    queryKey: routineKey(workspaceId, id),
    enabled: workspaceId !== null && id !== "",
    queryFn: ({ signal }) =>
      apiRequest<RoutineDetail>(itemPath(workspaceId as string, id), { signal, workspaceId }),
    refetchInterval: (query) =>
      runUnderway(query.state.data?.lastStatus ?? null) ? RUNNING_INTERVAL_MS : false,
    retry: retryServerErrors,
  })
}

/** The routine's runs, newest first; rereads while one is queued or running. */
export function useRoutineRuns(workspaceId: string | null, id: string) {
  return useInfiniteQuery({
    queryKey: [...routineKey(workspaceId, id), "runs"],
    enabled: workspaceId !== null,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      apiRequest<RoutineRunPage>(
        itemPath(workspaceId as string, id, `/runs?limit=${RUNS_PAGE_SIZE}&offset=${pageParam}`),
        { signal, workspaceId },
      ),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.runs.some((run) => runUnderway(run.status)))
        ? RUNNING_INTERVAL_MS
        : false,
    retry: retryServerErrors,
  })
}

/** The schedule in words and its next runs in the zone; a schedule the server refuses fails with why. */
export function useSchedulePreview(workspaceId: string | null, cron: string, timeZone: string) {
  return useQuery({
    queryKey: [...routinesKey(workspaceId), "preview", cron, timeZone],
    enabled: workspaceId !== null && cron.trim() !== "" && timeZone.trim() !== "",
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ cron, timeZone })
      return apiRequest<SchedulePreview>(
        workspacePath(workspaceId as string, `/routines/schedule-preview?${params.toString()}`),
        { signal, workspaceId },
      )
    },
    placeholderData: keepPreviousData,
    retry: retryServerErrors,
  })
}

export function useCreateRoutine(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateRoutineInput) =>
      apiRequest<RoutineDetail>(workspacePath(requireWorkspace(workspaceId), "/routines"), {
        method: "POST",
        body: input,
        workspaceId,
      }),
    onSuccess: async (created) => {
      queryClient.setQueryData(routineKey(workspaceId, created.id), created)
      await queryClient.invalidateQueries({ queryKey: listKey(workspaceId) })
    },
  })
}

/** A save rejected as stale rereads the routine, so the page shows the newer version. */
export function useUpdateRoutine(workspaceId: string | null, id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: UpdateRoutineInput) =>
      apiRequest<RoutineDetail>(itemPath(requireWorkspace(workspaceId), id), {
        method: "PATCH",
        body: patch,
        workspaceId,
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(routineKey(workspaceId, id), saved)
      await queryClient.invalidateQueries({ queryKey: listKey(workspaceId) })
    },
    onError: () => queryClient.invalidateQueries({ queryKey: routineKey(workspaceId, id) }),
  })
}

/** Pauses or resumes a routine (by id, so list rows can share one mutation). */
export function useSetRoutinePaused(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      apiRequest<RoutineDetail>(
        itemPath(requireWorkspace(workspaceId), id, paused ? "/pause" : "/resume"),
        { method: "POST", workspaceId },
      ),
    onSuccess: async (routine) => {
      queryClient.setQueryData(routineKey(workspaceId, routine.id), routine)
      await queryClient.invalidateQueries({ queryKey: listKey(workspaceId) })
    },
  })
}

export function useDeleteRoutine(workspaceId: string | null, id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiRequest<{ deleted: true }>(itemPath(requireWorkspace(workspaceId), id), {
        method: "DELETE",
        workspaceId,
      }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: routineKey(workspaceId, id) })
      await queryClient.invalidateQueries({ queryKey: listKey(workspaceId) })
    },
  })
}

/**
 * Starts a run now. The caller picks the mutation id once per click, so the
 * same request sent twice returns the run already started instead of a second one.
 */
export function useRunRoutine(workspaceId: string | null, id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (mutationId: string) =>
      apiRequest<RoutineRun>(itemPath(requireWorkspace(workspaceId), id, "/run"), {
        method: "POST",
        body: { mutationId },
        workspaceId,
      }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: routineKey(workspaceId, id) }),
        queryClient.invalidateQueries({ queryKey: listKey(workspaceId) }),
      ]),
  })
}
