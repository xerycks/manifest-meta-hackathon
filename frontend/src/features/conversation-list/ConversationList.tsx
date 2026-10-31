import { Pencil, Timer, Trash2 } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"

import { useConversations, useDeleteConversation, useRenameConversation } from "@/entities/agent/api.ts"
import { isActive } from "@/entities/agent/timeline.ts"
import { AGENT_LIMITS, type ConversationSummary } from "@/entities/agent/types.ts"
import { cn } from "@/shared/lib/cn.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button } from "@/shared/ui/button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Input } from "@/shared/ui/fields.tsx"
import { ErrorState } from "@/shared/ui/states.tsx"

import { conversationBadge, listedConversations } from "./conversation-items.ts"

const iconButton =
  "rounded p-1.5 text-(--muted) hover:bg-white hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent) disabled:opacity-50"

/** One conversation: a link to it, with rename and delete (after a confirmation). */
function ConversationItem({
  item,
  current,
  workspaceId,
  onNavigate,
  onDeleted,
}: {
  item: ConversationSummary
  current: boolean
  workspaceId: string
  onNavigate: () => void
  onDeleted: (conversationId: string) => void
}) {
  const id = useId()
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view")
  const [title, setTitle] = useState(item.title)
  const rename = useRenameConversation(workspaceId)
  const remove = useDeleteConversation(workspaceId)
  const renameButton = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const cancelDelete = useRef<HTMLButtonElement>(null)
  const closed = useRef<"rename" | "delete" | null>(null)
  const badge = conversationBadge(item)

  useEffect(() => {
    // Focus moves into a form or confirmation, and back to its button when it closes.
    if (mode === "delete") cancelDelete.current?.focus()
    if (mode === "view" && closed.current) {
      ;(closed.current === "rename" ? renameButton : deleteButton).current?.focus()
      closed.current = null
    }
  }, [mode])

  function close(from: "rename" | "delete") {
    closed.current = from
    rename.reset()
    remove.reset()
    setMode("view")
  }

  function save(event: FormEvent) {
    event.preventDefault()
    const next = title.trim()
    if (!next) return
    if (next === item.title) {
      close("rename")
      return
    }
    rename.mutate({ conversationId: item.id, title: next }, { onSuccess: () => close("rename") })
  }

  if (mode === "rename") {
    return (
      <li>
        <form onSubmit={save} className="space-y-2 rounded-md border border-(--border) p-2" noValidate>
          <label htmlFor={`${id}-title`} className="text-xs font-medium">
            Conversation title
          </label>
          <Input
            id={`${id}-title`}
            value={title}
            maxLength={AGENT_LIMITS.titleChars}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") close("rename")
            }}
          />
          {rename.error && (
            <p role="alert" className="text-xs text-(--danger)">
              {rename.error.message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="px-3 py-1.5" disabled={rename.isPending || !title.trim()}>
              {rename.isPending ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" className="py-1.5" onClick={() => close("rename")}>
              Cancel
            </Button>
          </div>
        </form>
      </li>
    )
  }

  if (mode === "delete") {
    return (
      <li>
        <div
          role="group"
          aria-labelledby={`${id}-confirm`}
          className="rounded-md border border-(--danger-border) bg-(--danger-surface) p-3"
        >
          <p id={`${id}-confirm`} className="text-sm font-medium break-words text-(--danger)">
            Delete “{item.title}”?
          </p>
          <p className="mt-1 text-xs leading-5 text-(--danger)">
            Its questions, answers, and files are removed for good
            {item.status && isActive(item.status) ? ", and the question being answered is stopped" : ""}.
          </p>
          {remove.error && (
            <p role="alert" className="mt-1 text-xs text-(--danger)">
              {remove.error.message}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="danger"
              className="px-3 py-1.5"
              disabled={remove.isPending}
              onClick={() => remove.mutate(item.id, { onSuccess: () => onDeleted(item.id) })}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
            <Button
              ref={cancelDelete}
              variant="secondary"
              className="px-3 py-1.5"
              disabled={remove.isPending}
              onClick={() => close("delete")}
            >
              Cancel
            </Button>
          </div>
        </div>
      </li>
    )
  }

  return (
    <li
      className={cn("flex items-start gap-1 rounded-md", current ? "bg-(--surface)" : "hover:bg-(--surface)")}
    >
      <Link
        to={`/ask/${item.id}`}
        aria-current={current ? "page" : undefined}
        onClick={onNavigate}
        className="min-w-0 flex-1 rounded-md px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent)"
      >
        <span className={cn("block truncate text-sm", current && "font-medium")}>{item.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-(--muted)">
          {item.routine && (
            <Badge title={`Asked by the routine “${item.routine.name}”`}>
              <Timer aria-hidden className="size-3" />
              Routine
            </Badge>
          )}
          {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
          <time dateTime={item.updatedAt}>{formatRelativeTime(item.updatedAt)}</time>
        </span>
      </Link>
      <div className="flex shrink-0 py-1 pr-1">
        <button
          ref={renameButton}
          type="button"
          className={iconButton}
          aria-label={`Rename “${item.title}”`}
          onClick={() => {
            setTitle(item.title)
            setMode("rename")
          }}
        >
          <Pencil aria-hidden className="size-3.5" />
        </button>
        <button
          ref={deleteButton}
          type="button"
          className={iconButton}
          aria-label={`Delete “${item.title}”`}
          onClick={() => setMode("delete")}
        >
          <Trash2 aria-hidden className="size-3.5" />
        </button>
      </div>
    </li>
  )
}

/**
 * The user's conversations in this workspace, newest activity first, with
 * how their latest question stands. More load on request.
 */
export function ConversationList({
  workspaceId,
  currentId,
  onNavigate,
  onDeleted,
}: {
  workspaceId: string
  /** The open conversation, marked as current. */
  currentId: string | null
  /** A conversation link was followed (the list can close on narrow screens). */
  onNavigate: () => void
  onDeleted: (conversationId: string) => void
}) {
  const list = useConversations(workspaceId)
  const items = useMemo(() => listedConversations(list.data?.pages ?? []), [list.data])

  return (
    <div className="space-y-2">
      <h2 className="px-2 text-sm font-semibold">Conversations</h2>
      {list.isPending && (
        <p role="status" className="px-2 text-sm text-(--muted)">
          Loading conversations…
        </p>
      )}
      {list.isLoadingError && (
        <ErrorState
          title="Conversations could not be loaded"
          message={list.error.message}
          onRetry={() => void list.refetch()}
        />
      )}
      {list.isSuccess && items.length === 0 && (
        <p className="px-2 text-sm leading-6 text-(--muted)">
          No conversations yet. Your first question starts one; only you can see your conversations.
        </p>
      )}
      {items.length > 0 && (
        <ul className="space-y-0.5">
          {items.map((item) => (
            <ConversationItem
              key={item.id}
              item={item}
              current={item.id === currentId}
              workspaceId={workspaceId}
              onNavigate={onNavigate}
              onDeleted={onDeleted}
            />
          ))}
        </ul>
      )}
      {list.isFetchNextPageError && (
        <FailureNotice title="More conversations could not be loaded" message={list.error?.message ?? ""} />
      )}
      {list.hasNextPage && (
        <Button
          variant="ghost"
          className="w-full"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  )
}
