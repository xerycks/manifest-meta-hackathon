import { useMutation, useQuery } from "@tanstack/react-query"

import { apiRequest, buildUrl } from "@/shared/api/client.ts"
import { retryServerErrors } from "@/shared/api/retry.ts"
import { workspacePath } from "@/shared/api/workspace-scope.ts"

import { encodeFile } from "./attachments.ts"
import type { AgentRun, AgentRunWithEvents, ConversationWithRuns, StartRunInput } from "./types.ts"

function requireWorkspace(workspaceId: string | null): string {
  if (!workspaceId) throw new Error("Select a workspace first")
  return workspaceId
}

const agentPath = (workspaceId: string, subpath: string) => workspacePath(workspaceId, `/agent${subpath}`)
const runPath = (workspaceId: string, runId: string, subpath = "") =>
  agentPath(workspaceId, `/runs/${encodeURIComponent(runId)}${subpath}`)

/** The URL of a run's event stream (Server-Sent Events) after sequence `after`. */
export function runEventsUrl(workspaceId: string, runId: string, after: number): string {
  return buildUrl(runPath(workspaceId, runId, `/events?after=${after}`))
}

/** A run with its events after `after`. */
export function fetchRun(workspaceId: string, runId: string, after = 0): Promise<AgentRunWithEvents> {
  return apiRequest<AgentRunWithEvents>(runPath(workspaceId, runId, `?after=${after}`), { workspaceId })
}

/** A conversation with its latest runs, read when it is opened; live progress comes from run streams. */
export function useConversation(workspaceId: string | null, conversationId: string | null) {
  return useQuery({
    queryKey: ["agent", workspaceId, "conversation", conversationId],
    enabled: workspaceId !== null && conversationId !== null,
    queryFn: ({ signal }) =>
      apiRequest<ConversationWithRuns>(
        agentPath(workspaceId as string, `/conversations/${encodeURIComponent(conversationId as string)}`),
        { signal, workspaceId },
      ),
    retry: retryServerErrors,
    refetchOnWindowFocus: false,
  })
}

export interface AskInput extends Omit<StartRunInput, "attachments"> {
  files?: File[]
}

/** Asks a question, sending its files in base64; resolves with the queued run. */
export function useStartRun(workspaceId: string | null) {
  return useMutation({
    mutationFn: async ({ files = [], ...input }: AskInput) => {
      const id = requireWorkspace(workspaceId)
      const body: StartRunInput =
        files.length > 0 ? { ...input, attachments: await Promise.all(files.map(encodeFile)) } : input
      return apiRequest<AgentRun>(agentPath(id, "/runs"), { method: "POST", body, workspaceId: id })
    },
  })
}

/** Stops a run; resolves once the cancellation is recorded. */
export function useCancelRun(workspaceId: string | null) {
  return useMutation({
    mutationFn: (runId: string) => {
      const id = requireWorkspace(workspaceId)
      return apiRequest<AgentRunWithEvents>(runPath(id, runId, "/cancel"), {
        method: "POST",
        workspaceId: id,
      })
    },
  })
}

/** Answers the clarification a run is waiting on; resolves once the run has it. */
export function useAnswerRun(workspaceId: string | null) {
  return useMutation({
    mutationFn: ({ runId, answer }: { runId: string; answer: string }) => {
      const id = requireWorkspace(workspaceId)
      return apiRequest<AgentRunWithEvents>(runPath(id, runId, "/answer"), {
        method: "POST",
        body: { answer },
        workspaceId: id,
      })
    },
  })
}
