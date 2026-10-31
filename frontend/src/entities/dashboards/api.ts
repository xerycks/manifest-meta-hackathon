import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { savedQueriesKey } from "@/entities/saved-queries/api.ts"
import type { SavedQueryRun } from "@/entities/saved-queries/types.ts"
import { apiRequest } from "@/shared/api/client.ts"
import { retryServerErrors } from "@/shared/api/retry.ts"
import { workspacePath } from "@/shared/api/workspace-scope.ts"

import type {
  CreateDashboardInput,
  DashboardDetail,
  DashboardList,
  DashboardPanel,
  PanelInput,
  UpdateDashboardInput,
  UpdatePanelInput,
} from "./types.ts"

const dashboardsKey = (workspaceId: string | null) => ["dashboards", workspaceId] as const
const listKey = (workspaceId: string | null) => [...dashboardsKey(workspaceId), "list"] as const
const dashboardKey = (workspaceId: string | null, id: string) =>
  [...dashboardsKey(workspaceId), "item", id] as const

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

/** Sends every panel id in the new order; a 409 means panels changed meanwhile, and the reread shows them. */
export function useReorderPanels(workspaceId: string | null, dashboardId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (panelIds: string[]) =>
      apiRequest<DashboardDetail>(itemPath(requireWorkspace(workspaceId), dashboardId, "/panels/order"), {
        method: "PUT",
        body: { panelIds },
        workspaceId,
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(dashboardKey(workspaceId, dashboardId), saved)
      await queryClient.invalidateQueries({ queryKey: listKey(workspaceId) })
    },
    onError: () => queryClient.invalidateQueries({ queryKey: dashboardKey(workspaceId, dashboardId) }),
  })
}

/**
 * Runs a panel's saved query with its defaults through the saved query's own
 * run route, then rereads the dashboard so the panel shows the new latest
 * result. Aborting `signal` closes the request, which stops the query.
 */
export function useRunPanel(workspaceId: string | null, dashboardId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ savedQueryId, signal }: { savedQueryId: string; signal: AbortSignal }) =>
      apiRequest<SavedQueryRun>(
        workspacePath(
          requireWorkspace(workspaceId),
          `/saved-queries/${encodeURIComponent(savedQueryId)}/run`,
        ),
        { method: "POST", body: { parameters: {} }, workspaceId, signal },
      ),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardKey(workspaceId, dashboardId) }),
        queryClient.invalidateQueries({ queryKey: savedQueriesKey(workspaceId) }),
      ]),
  })
}
