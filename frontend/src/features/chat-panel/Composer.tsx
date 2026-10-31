import { FileText, Paperclip, Send, Square, X } from "lucide-react"
import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from "react"

import { addFiles, ATTACHMENT_ACCEPT, ATTACHMENT_HINT, formatBytes } from "@/entities/agent/attachments.ts"
import { AGENT_LIMITS, ATTACHMENT_LIMITS } from "@/entities/agent/types.ts"
import type { Connection } from "@/entities/connections/types.ts"
import { Button } from "@/shared/ui/button.tsx"
import { Textarea } from "@/shared/ui/fields.tsx"

import { SourcePicker } from "./SourcePicker.tsx"
import type { Question } from "./use-chat.ts"

/**
 * Where a question is written: Enter sends, Shift+Enter starts a new line.
 * Sources and files go with it. While a question is being answered, Stop
 * cancels it and sending waits.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  sources,
  answering,
  sending,
  stopping,
  inputRef,
}: {
  value: Question
  onChange: (value: Question) => void
  onSend: () => void
  onStop: () => void
  sources: Connection[]
  /** A question of this conversation is being answered. */
  answering: boolean
  sending: boolean
  stopping: boolean
  inputRef: Ref<HTMLTextAreaElement>
}) {
  const id = useId()
  const picker = useRef<HTMLInputElement>(null)
  const [problems, setProblems] = useState<string[]>([])
  const canSend = value.question.trim().length > 0 && !answering && !sending

  function submit(event: FormEvent) {
    event.preventDefault()
    if (canSend) onSend()
  }

  function sendOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  function attach(picked: FileList | null) {
    const added = addFiles(value.files, [...(picked ?? [])])
    setProblems(added.problems)
    onChange({ ...value, files: added.files })
    if (picker.current) picker.current.value = ""
  }

  function remove(file: File) {
    setProblems([])
    onChange({ ...value, files: value.files.filter((entry) => entry !== file) })
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-(--border) bg-white p-3" noValidate>
      <label htmlFor={`${id}-question`} className="sr-only">
        Your question
      </label>
      <Textarea
        id={`${id}-question`}
        ref={inputRef}
        value={value.question}
        onChange={(event) => onChange({ ...value, question: event.target.value })}
        onKeyDown={sendOnEnter}
        rows={3}
        maxLength={AGENT_LIMITS.questionChars}
        placeholder="Ask about your data…"
        aria-describedby={`${id}-hint`}
        className="resize-y border-0 px-1 focus-visible:outline-offset-0"
      />
      {value.files.length > 0 && (
        <ul aria-label="Attached files" className="flex flex-wrap gap-2">
          {value.files.map((file) => (
            <li
              key={`${file.name}-${file.size}-${file.lastModified}`}
              className="flex max-w-full items-center gap-1.5 rounded-md border border-(--border) bg-(--surface) py-1 pr-1 pl-2 text-xs"
            >
              <FileText aria-hidden className="size-3.5 shrink-0 text-(--muted)" />
              <span className="truncate">{file.name}</span>
              <span className="shrink-0 text-(--muted)">{formatBytes(file.size)}</span>
              <button
                type="button"
                onClick={() => remove(file)}
                aria-label={`Remove ${file.name}`}
                className="rounded p-0.5 text-(--muted) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-(--accent)"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {problems.length > 0 && (
        <ul role="alert" className="space-y-0.5 text-xs font-medium text-(--danger)">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-start gap-1">
          <SourcePicker
            sources={sources}
            value={value.connectionIds}
            onChange={(connectionIds) => onChange({ ...value, connectionIds })}
          />
          <Button
            variant="ghost"
            className="px-2"
            onClick={() => picker.current?.click()}
            disabled={value.files.length >= ATTACHMENT_LIMITS.perRun}
          >
            <Paperclip aria-hidden className="size-4" />
            Attach files
          </Button>
          <input
            ref={picker}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => attach(event.target.files)}
          />
        </div>
        <div className="ml-auto flex gap-2">
          {answering && (
            <Button variant="secondary" onClick={onStop} disabled={stopping}>
              <Square aria-hidden className="size-4" />
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          )}
          <Button type="submit" disabled={!canSend}>
            <Send aria-hidden className="size-4" />
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
      <p id={`${id}-hint`} className="px-1 text-xs leading-5 text-(--muted)">
        Enter sends, Shift+Enter starts a new line. {ATTACHMENT_HINT}
      </p>
    </form>
  )
}
