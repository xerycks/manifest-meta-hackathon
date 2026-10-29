import type { ReactNode } from "react"

import { Button } from "./button.tsx"

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-10 text-sm text-(--muted)">
      <span
        aria-hidden
        className="size-4 animate-spin rounded-full border-2 border-(--border) border-t-(--accent) motion-reduce:animate-none"
      />
      {label}
    </div>
  )
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string
  message: string
  onRetry?: () => void
}) {
  return (
    <div role="alert" className="rounded-lg border border-(--danger-border) bg-(--danger-surface) p-5">
      <p className="font-medium text-(--danger)">{title}</p>
      <p className="mt-1 text-sm leading-6 text-(--danger)">{message}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="rounded-lg border border-dashed border-(--border) px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-(--muted)">{description}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}
