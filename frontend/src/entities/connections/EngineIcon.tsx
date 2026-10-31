import { Database, Leaf } from "lucide-react"

import { cn } from "@/shared/lib/cn.ts"

import type { ConnectionEngine } from "./types.ts"

const ICONS = { postgres: Database, mongodb: Leaf } as const

/** A decorative engine mark; always shown next to the engine's name. */
export function EngineIcon({ engine, className }: { engine: ConnectionEngine; className?: string }) {
  const Icon = ICONS[engine]
  return <Icon aria-hidden className={cn("size-4 shrink-0", className)} />
}
