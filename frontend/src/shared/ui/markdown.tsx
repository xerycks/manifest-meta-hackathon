import { lazy, Suspense } from "react"

import { cn } from "../lib/cn.ts"

// The Markdown parser is a large dependency, so it loads with the first description shown.
const MarkdownRenderer = lazy(() => import("./markdown-renderer.tsx"))

/** User-written Markdown; shown as plain text for the moment the renderer takes to load. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("markdown", className)}>
      <Suspense fallback={<p className="whitespace-pre-wrap">{children}</p>}>
        <MarkdownRenderer>{children}</MarkdownRenderer>
      </Suspense>
    </div>
  )
}
