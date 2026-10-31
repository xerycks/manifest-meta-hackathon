import { Check, Copy } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "./button.tsx"

type CopyState = "idle" | "copied" | "failed"

const LABELS: Record<CopyState, string> = { idle: "Copy", copied: "Copied", failed: "Copy failed" }

/** Copies `text` to the clipboard and says whether it worked. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<CopyState>("idle")

  useEffect(() => {
    if (state === "idle") return
    const timer = setTimeout(() => setState("idle"), 2_000)
    return () => clearTimeout(timer)
  }, [state])

  function copy() {
    // The Clipboard API is missing outside secure contexts (plain http on another host).
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => setState("copied"),
        () => setState("failed"),
      )
  }

  return (
    <Button
      variant="ghost"
      className="px-2 py-1 text-xs"
      onClick={copy}
      aria-label={`${LABELS[state]}: ${label}`}
    >
      {state === "copied" ? (
        <Check aria-hidden className="size-3.5" />
      ) : (
        <Copy aria-hidden className="size-3.5" />
      )}
      <span aria-live="polite">{LABELS[state]}</span>
    </Button>
  )
}
