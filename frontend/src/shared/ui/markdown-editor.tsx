import { useId, useRef, useState, type KeyboardEvent } from "react"

import { cn } from "../lib/cn.ts"
import { Textarea } from "./fields.tsx"
import { Markdown } from "./markdown.tsx"

type Tab = "write" | "preview"

const TABS: { id: Tab; label: string }[] = [
  { id: "write", label: "Write" },
  { id: "preview", label: "Preview" },
]

/**
 * A Markdown text area with Write and Preview tabs. The text area stays
 * mounted while previewing, so its contents and undo history are kept.
 */
export function MarkdownEditor({
  id,
  value,
  onChange,
  maxLength,
  rows = 6,
  placeholder,
  describedBy,
  disabled,
}: {
  /** The text area's id, for its label. */
  id: string
  value: string
  onChange: (value: string) => void
  maxLength: number
  rows?: number
  placeholder?: string
  describedBy?: string
  disabled?: boolean
}) {
  const [tab, setTab] = useState<Tab>("write")
  const prefix = useId()
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ write: null, preview: null })

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const next: Tab = tab === "write" ? "preview" : "write"
    setTab(next)
    tabRefs.current[next]?.focus()
  }

  return (
    <div className="rounded-md border border-(--border)">
      <div
        role="tablist"
        aria-label="Description editor"
        className="flex items-center gap-1 border-b border-(--border) bg-(--surface) px-1.5 pt-1.5"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            ref={(element) => {
              tabRefs.current[item.id] = element
            }}
            type="button"
            role="tab"
            id={`${prefix}-${item.id}-tab`}
            aria-selected={tab === item.id}
            aria-controls={`${prefix}-${item.id}-panel`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={onTabKeyDown}
            className={cn(
              "-mb-px rounded-t-md border border-transparent px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)",
              tab === item.id
                ? "border-(--border) border-b-white bg-white font-medium text-(--foreground)"
                : "text-(--muted) hover:text-(--foreground)",
            )}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-auto px-2 pb-1 text-xs text-(--muted)">
          Markdown · {value.length.toLocaleString("en-US")}/{maxLength.toLocaleString("en-US")}
        </span>
      </div>
      <div
        role="tabpanel"
        id={`${prefix}-write-panel`}
        aria-labelledby={`${prefix}-write-tab`}
        hidden={tab !== "write"}
        className="p-1.5"
      >
        <Textarea
          id={id}
          value={value}
          rows={rows}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-describedby={describedBy}
          disabled={disabled}
          className="border-0 font-mono text-[0.8125rem]"
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <div
        role="tabpanel"
        id={`${prefix}-preview-panel`}
        aria-labelledby={`${prefix}-preview-tab`}
        hidden={tab !== "preview"}
        tabIndex={0}
        className="min-h-24 px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
      >
        {value.trim() ? (
          <Markdown>{value}</Markdown>
        ) : (
          <p className="text-sm text-(--muted)">Nothing to preview yet.</p>
        )}
      </div>
    </div>
  )
}
