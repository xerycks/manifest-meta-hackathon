import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { ApiError, apiRequest, buildUrl } from "@/shared/api/client.ts"
import { retryServerErrors } from "@/shared/api/retry.ts"
import { workspacePath } from "@/shared/api/workspace-scope.ts"

import { encodeFile } from "./attachments.ts"
import {
  ACTIVE_RUN_STATUSES,
  type AgentRun,
  type AgentRunWithEvents,
  type Conversation,
  type ConversationPage,
  type ConversationWithRuns,
  type StartRunInput,
} from "./types.ts"

/** Conversations one page of the list shows. */
const CONVERSATION_PAGE = 20
/** How often the list refreshes while one of its questions is being answered. */
const ACTIVE_LIST_REFRESH_MS = 5_000

function requireWorkspace(workspaceId: string | null): string {
  if (!workspaceId) throw new Error("Select a workspace first")
  return workspaceId
}

const agentPath = (workspaceId: string, subpath: string) => workspacePath(workspaceId, `/agent${subpath}`)
const runPath = (workspaceId: string, runId: string, subpath = "") =>
  agentPath(workspaceId, `/runs/${encodeURIComponent(runId)}${subpath}`)
const conversationPath = (workspaceId: string, conversationId: string, query = "") =>
  agentPath(workspaceId, `/conversations/${encodeURIComponent(conversationId)}${query}`)

export const conversationsKey = (workspaceId: string | null) => ["agent", workspaceId, "conversations"]
const conversationKey = (workspaceId: string | null, conversationId: string | null) => [
  "agent",
  workspaceId,
  "conversation",
  conversationId,
]

/** A request that never reached the server (or whose answer never came back) can be sent again. */
const retryNetworkErrors = (failureCount: number, error: Error) =>
  error instanceof ApiError && error.status === 0 && failureCount < 2

/** The URL of a run's event stream (Server-Sent Events) after sequence `after`. */
export function runEventsUrl(workspaceId: string, runId: string, after: number): string {
  return buildUrl(runPath(workspaceId, runId, `/events?after=${after}`))
}

/** Where an answer downloads as a Markdown file (its asker only). */
export function answerExportUrl(workspaceId: string, runId: string): string {
  return buildUrl(runPath(workspaceId, runId, "/export.md"))
}

/** A run with its events after `after`. */
export function fetchRun(workspaceId: string, runId: string, after = 0): Promise<AgentRunWithEvents> {
  return apiRequest<AgentRunWithEvents>(runPath(workspaceId, runId, `?after=${after}`), { workspaceId })
}

/** A conversation's runs older than run `before` (the latest ones without it). */
export function fetchConversation(
  workspaceId: string,
  conversationId: string,
  before?: string,
): Promise<ConversationWithRuns> {
  const query = before ? `?before=${encodeURIComponent(before)}` : ""
  return apiRequest<ConversationWithRuns>(conversationPath(workspaceId, conversationId, query), {
    workspaceId,
  })
}

/** A conversation with its latest runs, read when it is opened; live progress comes from run streams. */
export function useConversation(workspaceId: string | null, conversationId: string | null) {
  return useQuery({
    queryKey: conversationKey(workspaceId, conversationId),
    enabled: workspaceId !== null && conversationId !== null,
    queryFn: ({ signal }) =>
      apiRequest<ConversationWithRuns>(conversationPath(workspaceId as string, conversationId as string), {
        signal,
        workspaceId,
      }),
    retry: retryServerErrors,
    refetchOnWindowFocus: false,
  })
}

/** The user's conversations, newest activity first, a page at a time. */
export function useConversations(workspaceId: string | null) {
  return useInfiniteQuery({
    queryKey: conversationsKey(workspaceId),
    enabled: workspaceId !== null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const cursor = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""
      return apiRequest<ConversationPage>(
        agentPath(workspaceId as string, `/conversations?limit=${CONVERSATION_PAGE}${cursor}`),
        { signal, workspaceId },
      )
    },
    getNextPageParam: (page) => page.nextCursor,
    retry: retryServerErrors,
    // Statuses change while questions are answered, here or in another tab.
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.conversations.some((item) => item.status !== null && ACTIVE_RUN_STATUSES.includes(item.status)),
      )
        ? ACTIVE_LIST_REFRESH_MS
        : false,
  })
}

export interface AskInput extends Omit<StartRunInput, "attachments"> {
  files?: File[]
}

/**
 * Asks a question, sending its files in base64; resolves with the queued run.
 * A network failure is retried with the same mutationId, so the question is
 * started at most once.
 */
export function useStartRun(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ files = [], ...input }: AskInput) => {
      const id = requireWorkspace(workspaceId)
      const body: StartRunInput =
        files.length > 0 ? { ...input, attachments: await Promise.all(files.map(encodeFile)) } : input
      return apiRequest<AgentRun>(agentPath(id, "/runs"), { method: "POST", body, workspaceId: id })
    },
    retry: retryNetworkErrors,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: conversationsKey(workspaceId) }),
  })
}

/** Asks an interrupted question again; asking twice returns the same retry. */
export function useRetryRun(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => {
      const id = requireWorkspace(workspaceId)
      return apiRequest<AgentRun>(runPath(id, runId, "/retry"), { method: "POST", workspaceId: id })
    },
    retry: retryNetworkErrors,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: conversationsKey(workspaceId) }),
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

export function useRenameConversation(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ conversationId, title }: { conversationId: string; title: string }) => {
      const id = requireWorkspace(workspaceId)
      return apiRequest<Conversation>(conversationPath(id, conversationId), {
        method: "PATCH",
        body: { title },
        workspaceId: id,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: conversationsKey(workspaceId) }),
  })
}

/** Deletes a conversation; its active question is stopped first. */
export function useDeleteConversation(workspaceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (conversationId: string) => {
      const id = requireWorkspace(workspaceId)
      return apiRequest<{ deleted: true }>(conversationPath(id, conversationId), {
        method: "DELETE",
        workspaceId: id,
      })
    },
    onSuccess: (_result, conversationId) => {
      queryClient.removeQueries({ queryKey: conversationKey(workspaceId, conversationId) })
      return queryClient.invalidateQueries({ queryKey: conversationsKey(workspaceId) })
    },
  })
}
