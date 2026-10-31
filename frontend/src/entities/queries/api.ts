import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiRequest } from "@/shared/api/client.ts"
import { retryServerErrors } from "@/shared/api/retry.ts"
import { workspacePath } from "@/shared/api/workspace-scope.ts"

import type { ExecutionRecord, ExecutionSummary, RunQueryInput } from "./types.ts"

/** Recent runs listed next to the console. */
const HISTORY_LIMIT = 10

const queriesKey = (workspaceId: string | null, connectionId: string) =>
  ["queries", workspaceId, connectionId] as const

function queriesPath(workspaceId: string, connectionId: string, subpath = ""): string {
  return workspacePath(workspaceId, `/connections/${encodeURIComponent(connectionId)}/queries${subpath}`)
}

function requireWorkspace(workspaceId: string | null): string {
  if (!workspaceId) throw new Error("Select a workspace first")
  return workspaceId
}

/** Recent executions on a source, newest first (owners and admins). */
export function useQueryHistory(workspaceId: string | null, connectionId: string) {
  return useQuery({
    queryKey: [...queriesKey(workspaceId, connectionId), "history"],
    enabled: workspaceId !== null,
    queryFn: ({ signal }) =>
      apiRequest<ExecutionSummary[]>(
        queriesPath(workspaceId as string, connectionId, `?limit=${HISTORY_LIMIT}`),
        { signal, workspaceId },
      ),
    retry: retryServerErrors,
  })
}

/** One execution with its stored result; any member may read it. */
export function useQueryExecution(
  workspaceId: string | null,
  connectionId: string,
  executionId: string | null,
) {
  return useQuery({
    queryKey: [...queriesKey(workspaceId, connectionId), "execution", executionId],
    enabled: workspaceId !== null && executionId !== null,
    queryFn: ({ signal }) =>
      apiRequest<ExecutionRecord>(
        queriesPath(workspaceId as string, connectionId, `/${encodeURIComponent(executionId as string)}`),
        { signal, workspaceId },
      ),
    retry: retryServerErrors,
  })
}

/**
 * Runs a query and resolves when it ends, with every returned row. Aborting
 * `signal` closes the request, which also stops the query on the source.
 */
export function useRunQuery(workspaceId: string | null, connectionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ signal, ...input }: RunQueryInput & { signal: AbortSignal }) => {
      const id = requireWorkspace(workspaceId)
      return apiRequest<ExecutionRecord>(queriesPath(id, connectionId), {
        method: "POST",
        body: input,
        workspaceId: id,
        signal,
      })
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queriesKey(workspaceId, connectionId) }),
  })
}

export function useCancelQuery(workspaceId: string | null, connectionId: string) {
  return useMutation({
    mutationFn: (executionId: string) => {
      const id = requireWorkspace(workspaceId)
      return apiRequest<ExecutionRecord>(
        queriesPath(id, connectionId, `/${encodeURIComponent(executionId)}/cancel`),
        { method: "POST", workspaceId: id },
      )
    },
  })
}
