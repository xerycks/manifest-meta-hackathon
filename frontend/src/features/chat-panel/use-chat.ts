import { useEffect, useReducer, useRef, useState } from "react"

import { fetchRun, useAnswerRun, useCancelRun, useConversation, useStartRun } from "@/entities/agent/api.ts"
import { activeRun, chatReducer, emptyChat } from "@/entities/agent/timeline.ts"
import type { AgentRun } from "@/entities/agent/types.ts"
import { useRunStream } from "@/entities/agent/use-run-stream.ts"
import { ApiError } from "@/shared/api/client.ts"

export interface Question {
  question: string
  /** Empty: every source. */
  connectionIds: string[]
  files: File[]
}

/**
 * One conversation on screen: its runs as read from the server, the live
 * stream of the run being answered, and the actions on it. Opening another
 * conversation (or none) starts over.
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
  const [chat, dispatch] = useReducer(chatReducer, conversationId, emptyChat)
  const [streamAttempt, setStreamAttempt] = useState(0)
  // Files of questions asked here, so a failed question can be asked again with them.
  const sentFiles = useRef(new Map<string, File[]>())

  useEffect(() => dispatch({ type: "open", conversationId }), [conversationId])

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

  const start = useStartRun(workspaceId)
  const cancel = useCancelRun(workspaceId)
  const answer = useAnswerRun(workspaceId)

  async function ask(question: Question): Promise<AgentRun> {
    const run = await start.mutateAsync({
      question: question.question,
      ...(chat.conversationId ? { conversationId: chat.conversationId } : {}),
      ...(question.connectionIds.length > 0 ? { connectionIds: question.connectionIds } : {}),
      files: question.files,
    })
    sentFiles.current.set(run.id, question.files)
    dispatch({ type: "started", run })
    if (run.conversationId !== conversationId) onConversationStarted?.(run.conversationId)
    return run
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
    dispatch({ type: "run", run: await answer.mutateAsync({ runId, answer: text }) })
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
    stop,
    stopping: cancel.isPending,
    reply,
    replying: answer.isPending,
    /** The files a question was asked with here, if this page sent it. */
    filesOf: (runId: string) => sentFiles.current.get(runId) ?? null,
  }
}
