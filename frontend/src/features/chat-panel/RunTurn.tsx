import {
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  FileText,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
} from "lucide-react"
import { useId, useState, type ReactNode } from "react"

import { answerExportUrl } from "@/entities/agent/api.ts"
import { formatBytes } from "@/entities/agent/attachments.ts"
import type { EvidenceItem } from "@/entities/agent/types.ts"
import {
  isActive,
  pendingClarification,
  type RunTimeline,
  type TimelineItem,
} from "@/entities/agent/timeline.ts"
import { cn } from "@/shared/lib/cn.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button } from "@/shared/ui/button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Markdown } from "@/shared/ui/markdown.tsx"

import { modelLabel } from "./chat-text.ts"
import { ClarificationCard } from "./ClarificationCard.tsx"
import { EvidenceBlock } from "./EvidenceBlock.tsx"

/**
 * Steps shown in the progress list. Questions to the user and the accepted
 * answer are shown on their own; a refused answer stays a step.
 */
const shownStep = (item: TimelineItem) =>
  item.kind === "note" ||
  (item.kind === "tool" &&
    item.tool !== "ask_user" &&
    (item.tool !== "submit_answer" || item.state === "failed"))

function Progress({ items, active }: { items: TimelineItem[]; active: boolean }) {
  const id = useId()
  // Open while the run works, unless the user chose otherwise.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? active
  const steps = items.filter((item) => item.kind === "tool" && shownStep(item)).length
  const failed = items.some((item) => item.kind === "tool" && shownStep(item) && item.state === "failed")

  return (
    <div className="rounded-lg border border-(--border)">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setChosen(!open)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm text-(--muted) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
      >
        <span>
          {active ? "Working" : "Worked"} · {steps} {steps === 1 ? "step" : "steps"}
          {failed ? " (some ran into problems)" : ""}
        </span>
        <ChevronDown
          aria-hidden
          className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <ol id={id} className="space-y-2 border-t border-(--border) px-3 py-3">
          {items.filter(shownStep).map((item, index) =>
            item.kind === "note" ? (
              <li key={index} className="text-sm leading-6 whitespace-pre-wrap text-(--foreground)">
                {item.text.trim()}
              </li>
            ) : item.kind === "tool" ? (
              <li key={item.callId} className="flex items-start gap-2 text-sm">
                {item.state === "running" ? (
                  <LoaderCircle
                    role="img"
                    aria-label="Running"
                    className="mt-0.5 size-4 shrink-0 animate-spin text-(--muted) motion-reduce:animate-none"
                  />
                ) : item.state === "succeeded" ? (
                  <Check role="img" aria-label="Done" className="mt-0.5 size-4 shrink-0 text-(--success)" />
                ) : (
                  <CircleAlert
                    role="img"
                    aria-label="Problem"
                    className="mt-0.5 size-4 shrink-0 text-(--danger)"
                  />
                )}
                <span className="min-w-0 break-words">
                  {item.summary}
                  {item.result && (
                    <span
                      className={cn(
                        "block text-xs",
                        item.state === "failed" ? "text-(--danger)" : "text-(--muted)",
                      )}
                    >
                      {item.result}
                    </span>
                  )}
                </span>
              </li>
            ) : null,
          )}
          {active && steps === 0 && <li className="text-sm text-(--muted)">Starting…</li>}
        </ol>
      )}
    </div>
  )
}

/** Renders an action for one piece of an answer's evidence. */
export type EvidenceAction = (
  item: EvidenceItem,
  context: { runId: string; sourceName: string | null },
) => ReactNode

/**
 * One question and everything that answered it: progress, clarifications,
 * the answer with its evidence, or how it ended.
 */
export function RunTurn({
  workspaceId,
  timeline,
  sourceNames,
  evidenceAction,
  onAnswer,
  answering,
  onRetry,
  retried,
  retrying,
}: {
  workspaceId: string
  timeline: RunTimeline
  sourceNames: Map<string, string>
  /** An action for each piece of evidence, e.g. "Save as query". */
  evidenceAction?: EvidenceAction
  onAnswer: (runId: string, answer: string) => Promise<void>
  answering: boolean
  /** Asks a failed question again, or retries an interrupted one. */
  onRetry: (timeline: RunTimeline) => void
  /** An interrupted run was already retried (the retry follows it). */
  retried: boolean
  retrying: boolean
}) {
  const id = useId()
  const { run, status, answer, error, disposition } = timeline
  const active = isActive(status)
  const pending = pendingClarification(timeline)
  const scope =
    run.connectionIds.length === 0
      ? "All sources"
      : run.connectionIds.map((sourceId) => sourceNames.get(sourceId) ?? "a removed source").join(", ")

  return (
    <article aria-labelledby={`${id}-question`} className="space-y-3">
      <div className="flex justify-end">
        <div className="max-w-full space-y-2 rounded-lg bg-(--surface) px-4 py-3 sm:max-w-[85%]">
          <p id={`${id}-question`} className="text-sm leading-6 break-words whitespace-pre-wrap">
            {run.question}
          </p>
          <p className="text-xs text-(--muted)">{scope}</p>
          {run.attachments.length > 0 && (
            <ul aria-label="Files sent with the question" className="flex flex-wrap gap-1.5">
              {run.attachments.map((file) => (
                <li
                  key={file.id}
                  className="flex max-w-full items-center gap-1 rounded border border-(--border) bg-white px-1.5 py-0.5 text-xs"
                >
                  <FileText aria-hidden className="size-3.5 shrink-0 text-(--muted)" />
                  <span className="truncate">{file.name}</span>
                  <span className="shrink-0 text-(--muted)">{formatBytes(file.sizeBytes)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {(active || timeline.items.some(shownStep)) && <Progress items={timeline.items} active={active} />}

        {timeline.items.map((item) =>
          item.kind === "clarification" && item.answer !== null ? (
            <div
              key={item.clarification.id}
              className="rounded-lg border border-(--border) px-4 py-3 text-sm"
            >
              <p className="text-(--muted)">{item.clarification.question}</p>
              <p className="mt-1">
                <span className="text-(--muted)">You answered: </span>
                <span className="font-medium break-words">{item.answer}</span>
              </p>
            </div>
          ) : null,
        )}
        {pending && (
          <ClarificationCard
            clarification={pending.clarification}
            answering={answering}
            onAnswer={(reply) => onAnswer(run.id, reply)}
          />
        )}

        {answer && (
          <section aria-label="Answer" className="space-y-3">
            {answer.status === "partial" && (
              <div className="rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-sm text-(--warning)">
                <p className="font-medium">Partial answer: the data could not answer everything.</p>
                {answer.missing.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {answer.missing.map((missing) => (
                      <li key={missing}>{missing}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <Markdown>{answer.markdown}</Markdown>
            <a
              href={answerExportUrl(workspaceId, run.id)}
              download
              className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
            >
              <Download aria-hidden className="size-3.5" />
              Download the answer (Markdown)
            </a>
            {answer.evidence.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Evidence</h3>
                {answer.evidence.map((item) => (
                  <EvidenceBlock
                    key={item.executionId}
                    workspaceId={workspaceId}
                    item={item}
                    sourceName={sourceNames.get(item.connectionId) ?? null}
                    createdAt={run.finishedAt ?? run.createdAt}
                    action={evidenceAction?.(item, {
                      runId: run.id,
                      sourceName: sourceNames.get(item.connectionId) ?? null,
                    })}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {status === "queued" && <p className="text-sm text-(--muted)">Waiting to start…</p>}
        {status === "awaiting_input" && !pending && (
          <p className="text-sm text-(--muted)">Waiting for your answer…</p>
        )}
        {status === "failed" && (
          <FailureNotice
            title="The question could not be answered"
            message={error?.message ?? "Something went wrong while answering."}
          >
            <Button variant="secondary" className="mt-2" onClick={() => onRetry(timeline)}>
              <RotateCcw aria-hidden className="size-4" />
              Ask again
            </Button>
          </FailureNotice>
        )}
        {status === "cancelled" && <p className="text-sm text-(--muted)">Stopped before it was answered.</p>}
        {status === "interrupted" && (
          <div
            role="status"
            className="rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-sm text-(--warning)"
          >
            <p className="font-medium">Interrupted by a restart</p>
            <p className="mt-0.5 leading-6">
              {disposition === "reconcile"
                ? "It had started actions with effects before the backend restarted. Check what they changed before asking again."
                : retried
                  ? "The backend restarted before it was answered. It was asked again below."
                  : "The backend restarted before it was answered. It only read data, so it is safe to retry with the same sources and files."}
            </p>
            {disposition === "retry" && !retried && (
              <Button
                variant="secondary"
                className="mt-2"
                disabled={retrying}
                onClick={() => onRetry(timeline)}
              >
                <RefreshCw aria-hidden className="size-4" />
                Retry
              </Button>
            )}
          </div>
        )}

        <p className="flex flex-wrap items-center gap-2 text-xs text-(--muted)">
          {status === "completed" ? "Answered by" : "Model:"} {modelLabel(run)}
          {run.provider === "scripted" && <Badge tone="warning">Demo model</Badge>}
        </p>
      </div>
    </article>
  )
}
