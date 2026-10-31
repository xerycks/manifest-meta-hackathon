import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useReducer, useRef, useState } from "react"

import {
  conversationsKey,
  fetchConversation,
  fetchRun,
  useAnswerRun,
  useCancelRun,
  useConversation,
  useRetryRun,
  useStartRun,
} from "@/entities/agent/api.ts"
import { activeRun, chatReducer, emptyChat } from "@/entities/agent/timeline.ts"
import type { AgentRun } from "@/entities/agent/types.ts"
import { useRunStream } from "@/entities/agent/use-run-stream.ts"
import { ApiError } from "@/shared/api/client.ts"

import { nextSubmission, submissionKey, type Submission } from "./submission.ts"

export interface Question {
  question: string
  /** Empty: every source. */
  connectionIds: string[]
  files: File[]
}

/**
 * One conversation on screen: its runs as read from the server, the live
 * stream of the run being answered, and the actions on it. Opening another
 * conversation (or none) starts over and closes the old stream; requests
 * still in flight then leave the newly opened conversation alone.
 */
export function useChat({
  workspaceId,
  conversationId,
  onConversationStarted,
}: {
  workspaceId: string | null
  conversationId: string | null
  onConversationStarted?: (conversationId: string) => void
}) {
  const queryClient = useQueryClient()
  const [chat, dispatch] = useReducer(chatReducer, conversationId, emptyChat)
  const [streamAttempt, setStreamAttempt] = useState(0)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  // Files of questions asked here, so a failed question can be asked again with them.
  const sentFiles = useRef(new Map<string, File[]>())
  // A question whose sending failed: sending it again reuses its mutationId.
  const failedSubmission = useRef<Submission | null>(null)
  // The conversation on screen, for requests that return after the user moved on.
  const shown = useRef(chat.conversationId)
  const watched = useRef<string | null>(null)

  useEffect(() => dispatch({ type: "open", conversationId }), [conversationId])
  useEffect(() => {
    shown.current = chat.conversationId
  }, [chat.conversationId])

  const snapshot = useConversation(workspaceId, chat.conversationId)
  useEffect(() => {
    if (snapshot.data) dispatch({ type: "loaded", conversation: snapshot.data })
  }, [snapshot.data])

  const active = activeRun(chat)
  const stream = useRunStream({
    workspaceId,
    runId: active?.run.id ?? null,
    from: active?.lastSeq ?? 0,
    attempt: streamAttempt,
    onEvents: (runId, events) => dispatch({ type: "events", runId, events }),
    onRun: (run) => dispatch({ type: "run", run }),
  })

  // The conversation list shows how each latest question stands.
  const latest = chat.runs.at(-1)
  const latestState = latest ? `${latest.run.id}:${latest.status}` : null
  useEffect(() => {
    const previous = watched.current
    watched.current = latestState
    if (previous !== null && latestState !== null && previous !== latestState) {
      void queryClient.invalidateQueries({ queryKey: conversationsKey(workspaceId) })
    }
  }, [latestState, queryClient, workspaceId])

  const start = useStartRun(workspaceId)
  const retry = useRetryRun(workspaceId)
  const cancel = useCancelRun(workspaceId)
  const answer = useAnswerRun(workspaceId)

  /** Shows a started run, unless another conversation was opened while it was being sent. */
  function showStarted(run: AgentRun, from: string | null) {
    const stillHere = shown.current === from
    dispatch({ type: "started", run, from })
    if (stillHere && run.conversationId !== from) onConversationStarted?.(run.conversationId)
  }

  async function ask(question: Question): Promise<AgentRun> {
    const from = chat.conversationId
    const submission = nextSubmission(failedSubmission.current, submissionKey(from, question), () =>
      crypto.randomUUID(),
    )
    failedSubmission.current = submission
    const run = await start.mutateAsync({
      question: question.question,
      ...(from ? { conversationId: from } : {}),
      ...(question.connectionIds.length > 0 ? { connectionIds: question.connectionIds } : {}),
      files: question.files,
      mutationId: submission.mutationId,
    })
    failedSubmission.current = null
    sentFiles.current.set(run.id, question.files)
    showStarted(run, from)
    return run
  }

  /** Asks a question a restart interrupted again, with its sources and files. */
  async function recover(runId: string): Promise<void> {
    const from = chat.conversationId
    showStarted(await retry.mutateAsync(runId), from)
  }

  /** Stops the run being answered; one that has just finished is read again instead. */
  async function stop(): Promise<void> {
    if (!active || !workspaceId) return
    try {
      dispatch({ type: "run", run: await cancel.mutateAsync(active.run.id) })
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error
      dispatch({ type: "run", run: await fetchRun(workspaceId, active.run.id) })
    }
  }

  async function reply(runId: string, text: string): Promise<void> {
    try {
      dispatch({ type: "run", run: await answer.mutateAsync({ runId, answer: text }) })
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409) || !workspaceId) throw error
      // No longer waiting (answered elsewhere, stopped, or its time ran out): show how it stands.
      const fresh = await fetchRun(workspaceId, runId)
      dispatch({ type: "run", run: fresh })
      if (fresh.status === "awaiting_input") throw error
    }
  }

  /** Reads the runs before the oldest one shown. */
  async function loadEarlier(): Promise<void> {
    const oldest = chat.runs[0]
    if (!workspaceId || !chat.conversationId || !oldest) return
    setLoadingEarlier(true)
    try {
      const conversation = await fetchConversation(workspaceId, chat.conversationId, oldest.run.id)
      dispatch({ type: "loaded", conversation })
    } finally {
      setLoadingEarlier(false)
    }
  }

  return {
    state: chat,
    snapshot,
    active,
    stream,
    /** Follows a lost stream again. */
    reconnect: () => setStreamAttempt((attempt) => attempt + 1),
    ask,
    asking: start.isPending,
    recover,
    recovering: retry.isPending,
    stop,
    stopping: cancel.isPending,
    reply,
    replying: answer.isPending,
    loadEarlier,
    loadingEarlier,
    /** The files a question was asked with here, if this page sent it. */
    filesOf: (runId: string) => sentFiles.current.get(runId) ?? null,
  }
}
