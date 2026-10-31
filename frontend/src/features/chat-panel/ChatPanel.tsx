import { WifiOff } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"

import { wasRetried, type RunTimeline } from "@/entities/agent/timeline.ts"
import type { RunStatus } from "@/entities/agent/types.ts"
import { useConnections } from "@/entities/connections/api.ts"
import { ApiError } from "@/shared/api/client.ts"
import { Button } from "@/shared/ui/button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { EmptyState, ErrorState, LoadingState } from "@/shared/ui/states.tsx"

import { announcement, describeAskError, type Notice } from "./chat-text.ts"
import { Composer } from "./Composer.tsx"
import { RunTurn, type EvidenceAction } from "./RunTurn.tsx"
import { useChat, type Question } from "./use-chat.ts"

const emptyQuestion = (): Question => ({ question: "", connectionIds: [], files: [] })

/**
 * A conversation with the workspace's data: the questions asked, live
 * progress, clarifications, answers with their evidence, and a composer for
 * the next question. Self-contained, so other screens can embed it.
 */
export function ChatPanel({
  workspaceId,
  conversationId,
  onConversationStarted,
  evidenceAction,
}: {
  workspaceId: string
  /** Null starts a new conversation with the first question. */
  conversationId: string | null
  onConversationStarted?: (conversationId: string) => void
  /** An action for each piece of an answer's evidence, e.g. "Save as query". */
  evidenceAction?: EvidenceAction
}) {
  const chat = useChat({
    workspaceId,
    conversationId,
    ...(onConversationStarted ? { onConversationStarted } : {}),
  })
  const sources = useConnections(workspaceId)
  const [draft, setDraft] = useState<Question>(emptyQuestion)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const watched = useRef<{ runId: string; status: RunStatus } | null>(null)
  const sourceNames = useMemo(
    () => new Map((sources.data ?? []).map((source) => [source.id, source.name])),
    [sources.data],
  )
  const { runs } = chat.state
  const latest = runs.at(-1) ?? null

  // Announce what happens to the latest question while it is on screen, not what was loaded.
  useEffect(() => {
    if (!latest) return
    const previous = watched.current
    watched.current = { runId: latest.run.id, status: latest.status }
    if (previous?.runId === latest.run.id && previous.status !== latest.status) {
      setSaid(announcement(latest.status, latest.answer?.markdown ?? null))
    }
  }, [latest])

  // A new conversation (or another one) starts with an empty composer.
  useEffect(() => {
    if (conversationId === null) {
      setDraft(emptyQuestion())
      setNotice(null)
    }
  }, [conversationId])

  /** Asks a question; the composer is emptied only when the question came from it. */
  async function send(question: Question, fromComposer = true) {
    setNotice(null)
    try {
      await chat.ask(question)
      if (fromComposer) setDraft(emptyQuestion())
    } catch (error) {
      setNotice(describeAskError(error))
    }
    input.current?.focus()
  }

  async function stop() {
    setNotice(null)
    try {
      await chat.stop()
    } catch (error) {
      setNotice(describeAskError(error, "stop the question"))
    }
    input.current?.focus()
  }

  /**
   * Retries an interrupted question (the server keeps its sources and files),
   * or asks a failed one again, with its files when this page still has them.
   */
  function retry(timeline: RunTimeline) {
    const { run } = timeline
    if (timeline.status === "interrupted") {
      setNotice(null)
      chat.recover(run.id).catch((error: unknown) => setNotice(describeAskError(error, "retry the question")))
      return
    }
    const files = chat.filesOf(run.id)
    if (run.attachments.length > 0 && !files) {
      setDraft({ question: run.question, connectionIds: run.connectionIds, files: [] })
      setNotice({
        title: "Attach the files again",
        message: `This question was sent with ${run.attachments.map((file) => file.name).join(", ")}. Attach them again, then send.`,
      })
      input.current?.focus()
      return
    }
    void send({ question: run.question, connectionIds: run.connectionIds, files: files ?? [] }, false)
  }

  async function reply(runId: string, answer: string) {
    await chat.reply(runId, answer)
    input.current?.focus()
  }

  function loadEarlier() {
    setNotice(null)
    chat.loadEarlier().catch((error: unknown) => setNotice(describeAskError(error, "load earlier questions")))
  }

  const loadError = conversationId !== null && runs.length === 0 ? chat.snapshot.error : null
  const notFound = loadError instanceof ApiError && (loadError.status === 404 || loadError.status === 422)

  return (
    <div className="flex flex-col gap-4">
      {conversationId !== null && runs.length === 0 && chat.snapshot.isPending && (
        <LoadingState label="Loading the conversation…" />
      )}
      {notFound && (
        <EmptyState
          title="Conversation not found"
          description="It may belong to someone else, or to another workspace. Conversations are private to the person who started them."
          action={
            <Link
              to="/ask"
              className="rounded-md text-sm font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
            >
              Start a new conversation
            </Link>
          }
        />
      )}
      {loadError && !notFound && (
        <ErrorState
          title="The conversation could not be loaded"
          message={loadError.message}
          onRetry={() => void chat.snapshot.refetch()}
        />
      )}
      {conversationId === null && runs.length === 0 && (
        <EmptyState
          title="Ask a question about your data"
          description="Answers come with the queries and rows behind them. Choose the sources to use, or attach a small CSV or text file."
        />
      )}

      {chat.state.hasEarlier && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={loadEarlier} disabled={chat.loadingEarlier}>
            {chat.loadingEarlier ? "Loading earlier questions…" : "Show earlier questions"}
          </Button>
        </div>
      )}

      {runs.length > 0 && (
        <div className="space-y-8">
          {runs.map((timeline) => (
            <RunTurn
              key={timeline.run.id}
              workspaceId={workspaceId}
              timeline={timeline}
              {...(evidenceAction ? { evidenceAction } : {})}
              sourceNames={sourceNames}
              onAnswer={reply}
              answering={chat.replying}
              onRetry={retry}
              retried={wasRetried(chat.state, timeline.run.id)}
              retrying={chat.recovering}
            />
          ))}
        </div>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>

      {chat.active && chat.stream.state === "reconnecting" && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-sm text-(--warning)"
        >
          <WifiOff aria-hidden className="size-4 shrink-0" />
          Connection lost — reconnecting. Progress so far is kept, and nothing is repeated.
        </p>
      )}
      {chat.active && chat.stream.state === "lost" && (
        <FailureNotice
          title="Lost track of this question"
          message={chat.stream.problem ?? "The question can no longer be followed."}
        >
          <Button variant="secondary" className="mt-2" onClick={chat.reconnect}>
            Try again
          </Button>
        </FailureNotice>
      )}
      {sources.isSuccess && sources.data.length === 0 && (
        <p className="text-sm text-(--muted)">
          No sources are connected yet, so there is no data to ask about.{" "}
          <Link to="/sources/new" className="font-medium text-(--accent) underline-offset-2 hover:underline">
            Connect a source
          </Link>
        </p>
      )}
      {notice && <FailureNotice title={notice.title} message={notice.message} />}

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={() => void send(draft)}
        onStop={() => void stop()}
        sources={sources.data ?? []}
        answering={chat.active !== null}
        sending={chat.asking}
        stopping={chat.stopping}
        inputRef={input}
      />
    </div>
  )
}
