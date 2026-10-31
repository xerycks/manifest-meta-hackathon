import type { ReactNode } from "react"

/** Compact inline error that keeps the surrounding form or content usable. */
export function FailureNotice({
  title,
  message,
  children,
}: {
  title: string
  message: string
  children?: ReactNode
}) {
  return (
    <div
      role="alert"
      className="rounded-md border border-(--danger-border) bg-(--danger-surface) px-3 py-2 text-sm text-(--danger)"
    >
      <p className="font-medium">{title}</p>
      <p className="mt-0.5 leading-6">{message}</p>
      {children}
    </div>
  )
}
