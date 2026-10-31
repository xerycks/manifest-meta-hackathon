import { X } from "lucide-react"
import { useEffect, useId, useRef, type ReactNode } from "react"

const FOCUSABLE =
  "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href]"

/**
 * A modal dialog on the native <dialog> element: focus moves into it (to the
 * element marked data-autofocus, else its first control) and stays there,
 * Escape or the close button closes it, and focus returns to what opened it.
 * Render it only while it is open.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
}: {
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.showModal()
    const first =
      dialog.querySelector<HTMLElement>("[data-autofocus]") ??
      content.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => {
      if (dialog.open) dialog.close()
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-3xl overflow-y-auto rounded-lg border border-(--border) bg-white p-0 text-(--foreground) shadow-xl backdrop:bg-black/40"
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-(--border) bg-white px-5 py-4">
        <div>
          <h2 id={titleId} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          {description && (
            <p id={descriptionId} className="mt-0.5 text-sm text-(--muted)">
              {description}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded-md p-1 text-(--muted) hover:bg-(--surface) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <div ref={content} className="px-5 py-4">
        {children}
      </div>
    </dialog>
  )
}
