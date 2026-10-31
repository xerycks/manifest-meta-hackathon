/** Compact inline error for connection problems; keeps the surrounding form usable. */
export function FailureNotice({ title, message }: { title: string; message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-(--danger-border) bg-(--danger-surface) px-3 py-2 text-sm text-(--danger)"
    >
      <p className="font-medium">{title}</p>
      <p className="mt-0.5 leading-6">{message}</p>
    </div>
  )
}
