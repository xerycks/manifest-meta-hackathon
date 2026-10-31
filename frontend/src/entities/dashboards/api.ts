import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { savedQueriesKey } from "@/entities/saved-queries/api.ts"
import { apiRequest } from "@/shared/api/client.ts"
import { retryServerErrors } from "@/shared/api/retry.ts"
import { workspacePath } from "@/shared/api/workspace-scope.ts"

import { refreshUnderway } from "./refresh-state.ts"
import type {
  CreateDashboardInput,
  DashboardDetail,
  DashboardList,
  DashboardPanel,
  DashboardRefresh,
  PanelInput,
  SaveLayoutInput,
  UpdateDashboardInput,
  UpdatePanelInput,
} from "./types.ts"

const dashboardsKey = (workspaceId: string | null) => ["dashboards", workspaceId] as const
const listKey = (workspaceId: string | null) => [...dashboardsKey(workspaceId), "list"] as const
const dashboardKey = (workspaceId: string | null, id: string) =>
  [...dashboardsKey(workspaceId), "item", id] as const
const refreshKey = (workspaceId: string | null, id: string) =>
  [...dashboardKey(workspaceId, id), "refresh"] as const

/** How often a refreshing dashboard asks for progress. */
const PROGRESS_INTERVAL_MS = 1_000

function requireWorkspace(workspaceId: string | null): string {
  if (!workspaceId) throw new Error("Select a workspace first")
  return workspaceId
}

const itemPath = (workspaceId: string, id: string, subpath = "") =>
  workspacePath(workspaceId, `/dashboards/${encodeURIComponent(id)}${subpath}`)

/** Every dashboard the user may see (a workspace has at most 200), recently updated first. */
export function useDashboards(workspaceId: string | null) {
  return useQuery({
    queryKey: listKey(workspaceId),
    enabled: workspaceId !== null,
    queryFn: ({ signal }) =>
      apiRequest<DashboardList>(workspacePath(workspaceId as string, "/dashboards"), { signal, workspaceId }),
    retry: retryServerErrors,
  })
}

/**
 * The dashboard with its panels and their latest stored results. Opening it
 * always rereads, since saved queries may have run elsewhere since.
 */
export function useDashboard(workspaceId: string | null, id: string) {
  return useQuery({
    queryKey: dashboardKey(workspaceId, id),
    enabled: workspaceId !== null,
    staleTime: 0,
    queryFn: ({ signal }) =>
      apiRequest<DashboardDetail>(itemPath(workspaceId as string, id), { signal, workspaceId }),
    retry: retryServerErrors,
  })
}

export function useCreateDashboard(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateDashboardInput) =>
      apiRequest<DashboardDetail>(workspacePath(requireWorkspace(workspaceId), "/dashboards"), {
        method: "POST",
        body: input,
        workspaceId,
      }),
    onSuccess: async (created) => {
      queryClient.setQueryData(dashboardKey(workspaceId, created.id), created)
      await queryClient.invalidateQueries({ queryKey: listKey(workspaceId) })
    },
  })
}

/** A save rejected as stale reloads the dashboard, so the page shows the newer version. */
export function useUpdateDashboard(workspaceId: string | null, id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: UpdateDashboardInput) =>
      apiRequest<DashboardDetail>(itemPath(requireWorkspace(workspaceId), id), {
        method: "PATCH",
        body: patch,
        workspaceId,
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(dashboardKey(workspaceId, id), saved)
      await queryClient.invalidateQueries({ queryKey: listKey(workspaceId) })
    },
    onError: () => queryClient.invalidateQueries({ queryKey: dashboardKey(workspaceId, id) }),
  })
}

export function useDeleteDashboard(workspaceId: string | null, id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiRequest<{ deleted: true }>(itemPath(requireWorkspace(workspaceId), id), {
        method: "DELETE",
        workspaceId,
      }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: dashboardKey(workspaceId, id) })
      await queryClient.invalidateQueries({ queryKey: listKey(workspaceId) })
    },
  })
}

/** Panel changes reread the dashboard (and the list, whose panel counts and dates move). */
function usePanelMutation<V, R>(
  workspaceId: string | null,
  request: (workspaceId: string, variables: V) => Promise<R>,
  dashboardOf: (variables: V) => string,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (variables: V) => request(requireWorkspace(workspaceId), variables),
    onSettled: (_result, _error, variables) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardKey(workspaceId, dashboardOf(variables)) }),
        queryClient.invalidateQueries({ queryKey: listKey(workspaceId) }),
      ]),
  })
}

export function useAddPanel(workspaceId: string | null) {
  return usePanelMutation(
    workspaceId,
    (workspace, { dashboardId, input }: { dashboardId: string; input: PanelInput }) =>
      apiRequest<DashboardPanel>(itemPath(workspace, dashboardId, "/panels"), {
        method: "POST",
        body: input,
        workspaceId: workspace,
      }),
    (variables) => variables.dashboardId,
  )
}

export function useUpdatePanel(workspaceId: string | null, dashboardId: string) {
  return usePanelMutation(
    workspaceId,
    (workspace, { panelId, patch }: { panelId: string; patch: UpdatePanelInput }) =>
      apiRequest<DashboardPanel>(itemPath(workspace, dashboardId, `/panels/${encodeURIComponent(panelId)}`), {
        method: "PATCH",
        body: patch,
        workspaceId: workspace,
      }),
    () => dashboardId,
  )
}

export function useDeletePanel(workspaceId: string | null, dashboardId: string) {
  return usePanelMutation(
    workspaceId,
    (workspace, panelId: string) =>
      apiRequest<{ deleted: true }>(
        itemPath(workspace, dashboardId, `/panels/${encodeURIComponent(panelId)}`),
        {
          method: "DELETE",
          workspaceId: workspace,
        },
      ),
    () => dashboardId,
  )
}

/**
 * Saves every panel's box. A 409 means the layout or the panels changed
 * meanwhile; the dashboard is reread so the page shows the current layout.
 */
export function useSaveLayout(workspaceId: string | null, dashboardId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SaveLayoutInput) =>
      apiRequest<DashboardDetail>(itemPath(requireWorkspace(workspaceId), dashboardId, "/layout"), {
        method: "PUT",
        body: input,
        workspaceId,
      }),
    onSuccess: (saved) => queryClient.setQueryData(dashboardKey(workspaceId, dashboardId), saved),
    onError: () => queryClient.invalidateQueries({ queryKey: dashboardKey(workspaceId, dashboardId) }),
  })
}

/**
 * The dashboard's refresh progress, asked for every second while a refresh
 * or a panel's run is under way: as the dashboard read says (`underway`),
 * or as this query's own last answer, or a refresh just started, says.
 */
export function useRefreshProgress(workspaceId: string | null, dashboardId: string, underway: boolean) {
  return useQuery<DashboardRefresh, Error, DashboardRefresh, ReturnType<typeof refreshKey>>({
    queryKey: refreshKey(workspaceId, dashboardId),
    enabled: (query) =>
      workspaceId !== null &&
      (underway || (query.state.data !== undefined && refreshUnderway(query.state.data))),
    queryFn: ({ signal }) =>
      apiRequest<DashboardRefresh>(itemPath(workspaceId as string, dashboardId, "/refresh"), {
        signal,
        workspaceId,
      }),
    refetchInterval: (query) =>
      query.state.data && !refreshUnderway(query.state.data) ? false : PROGRESS_INTERVAL_MS,
    retry: retryServerErrors,
  })
}

/** Rereads the dashboard (new results and statuses) and the saved queries whose runs moved. */
export function useRefreshedDashboard(workspaceId: string | null, dashboardId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: dashboardKey(workspaceId, dashboardId), exact: true }),
      queryClient.invalidateQueries({ queryKey: savedQueriesKey(workspaceId) }),
    ])
}

/** Refreshes every panel, or the listed ones; answers at once with the progress, which is then polled. */
export function useStartRefresh(workspaceId: string | null, dashboardId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (panelIds?: string[]) =>
      apiRequest<DashboardRefresh>(itemPath(requireWorkspace(workspaceId), dashboardId, "/refresh"), {
        method: "POST",
        body: panelIds ? { panelIds } : {},
        workspaceId,
      }),
    onSuccess: (progress) => queryClient.setQueryData(refreshKey(workspaceId, dashboardId), progress),
  })
}

/** Cancels the dashboard's refresh; answers once its queries have stopped. */
export function useCancelRefresh(workspaceId: string | null, dashboardId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiRequest<DashboardRefresh>(itemPath(requireWorkspace(workspaceId), dashboardId, "/refresh"), {
        method: "DELETE",
        workspaceId,
      }),
    onSuccess: (progress) => queryClient.setQueryData(refreshKey(workspaceId, dashboardId), progress),
  })
}
