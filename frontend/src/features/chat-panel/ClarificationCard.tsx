import { MessageCircleQuestion, Send } from "lucide-react"
import { useId, useState, type FormEvent } from "react"

import { AGENT_LIMITS, type Clarification } from "@/entities/agent/types.ts"
import { Button } from "@/shared/ui/button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Textarea } from "@/shared/ui/fields.tsx"

import { describeAskError } from "./chat-text.ts"

/** A question the model asked: pick an option or write an answer; the run goes on once it is sent. */
export function ClarificationCard({
  clarification,
  onAnswer,
  answering,
}: {
  clarification: Clarification
  onAnswer: (answer: string) => Promise<void>
  answering: boolean
}) {
  const id = useId()
  const [text, setText] = useState("")
  const [error, setError] = useState<unknown>(null)

  function send(answer: string) {
    setError(null)
    onAnswer(answer).catch(setError)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (text.trim()) send(text.trim())
  }

  const notice = error ? describeAskError(error, "send your answer") : null

  return (
    <section
      aria-labelledby={`${id}-question`}
      className="space-y-3 rounded-lg border border-(--accent) bg-white p-4"
    >
      <div className="flex items-start gap-2">
        <MessageCircleQuestion aria-hidden className="mt-0.5 size-4 shrink-0 text-(--accent)" />
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-(--muted) uppercase">Needs your answer</p>
          <p id={`${id}-question`} className="mt-0.5 text-sm font-medium break-words">
            {clarification.question}
          </p>
        </div>
      </div>
      {clarification.options.length > 0 && (
        <div role="group" aria-label="Suggested answers" className="flex flex-wrap gap-2">
          {clarification.options.map((option) => (
            <Button key={option} variant="secondary" disabled={answering} onClick={() => send(option)}>
              {option}
            </Button>
          ))}
        </div>
      )}
      {clarification.allowFreeText && (
        <form onSubmit={submit} className="space-y-2" noValidate>
          <label htmlFor={`${id}-answer`} className="text-sm font-medium">
            {clarification.options.length > 0 ? "Or write your answer" : "Your answer"}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Textarea
              id={`${id}-answer`}
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={2}
              maxLength={AGENT_LIMITS.answerReplyChars}
              className="min-h-12"
            />
            <Button type="submit" disabled={answering || !text.trim()} className="shrink-0">
              <Send aria-hidden className="size-4" />
              Send answer
            </Button>
          </div>
        </form>
      )}
      {notice && <FailureNotice title={notice.title} message={notice.message} />}
    </section>
  )
}
