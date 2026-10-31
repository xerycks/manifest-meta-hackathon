import { ChevronDown, Database } from "lucide-react"
import { useId, useState } from "react"

import { AGENT_LIMITS } from "@/entities/agent/types.ts"
import { ENGINE_LABELS } from "@/entities/connections/engine.ts"
import type { Connection } from "@/entities/connections/types.ts"
import { cn } from "@/shared/lib/cn.ts"
import { Button } from "@/shared/ui/button.tsx"
import { Checkbox } from "@/shared/ui/fields.tsx"

/** Which sources a question may use; none chosen means all of them. */
export function SourcePicker({
  sources,
  value,
  onChange,
  disabled,
}: {
  sources: Connection[]
  value: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const chosen = value.filter((sourceId) => sources.some((source) => source.id === sourceId))
  const summary =
    chosen.length === 0
      ? "All sources"
      : chosen.length === 1
        ? (sources.find((source) => source.id === chosen[0])?.name ?? "1 source")
        : `${chosen.length} sources`
  const full = chosen.length >= AGENT_LIMITS.connectionsPerRun

  function toggle(sourceId: string, checked: boolean) {
    onChange(checked ? [...chosen, sourceId] : chosen.filter((entry) => entry !== sourceId))
  }

  return (
    <div className="min-w-0">
      <Button
        variant="ghost"
        className="max-w-full px-2"
        aria-expanded={open}
        aria-controls={`${id}-sources`}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
      >
        <Database aria-hidden className="size-4 shrink-0" />
        <span className="truncate">Sources: {summary}</span>
        <ChevronDown
          aria-hidden
          className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
        />
      </Button>
      {open && (
        <fieldset id={`${id}-sources`} className="mt-2 space-y-2 rounded-md border border-(--border) p-3">
          <legend className="sr-only">Sources for this question</legend>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={chosen.length === 0} onChange={() => onChange([])} disabled={disabled} />
            All sources
          </label>
          {sources.map((source) => {
            const checked = chosen.includes(source.id)
            return (
              <label key={source.id} className="flex min-w-0 items-center gap-2 text-sm">
                <Checkbox
                  checked={checked}
                  onChange={(event) => toggle(source.id, event.target.checked)}
                  disabled={disabled || (!checked && full)}
                />
                <span className="truncate">{source.name}</span>
                <span className="shrink-0 text-xs text-(--muted)">{ENGINE_LABELS[source.engine]}</span>
              </label>
            )
          })}
          {full && (
            <p className="text-xs text-(--muted)">
              A question can use at most {AGENT_LIMITS.connectionsPerRun} chosen sources.
            </p>
          )}
        </fieldset>
      )}
    </div>
  )
}
