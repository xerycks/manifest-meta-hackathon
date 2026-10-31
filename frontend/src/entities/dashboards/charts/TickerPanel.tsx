import { ArrowDownRight, ArrowRight, ArrowUpRight, Pause, Play } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"

import type { QueryResult } from "@/entities/queries/types.ts"
import { cn } from "@/shared/lib/cn.ts"
import { useElementWidth } from "@/shared/lib/use-element-width.ts"
import { useMediaQuery } from "@/shared/lib/use-media-query.ts"

import { tickerItems, type TickerItem } from "../chart-data.ts"
import type { TickerConfig } from "../types.ts"
import { resultNotes } from "./ChartFrame.tsx"

const DIRECTION_ICONS = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight }
/** Seconds each item takes to scroll past. */
const SECONDS_PER_ITEM = 4

function Items({ items, hidden = false }: { items: TickerItem[]; hidden?: boolean }) {
  return (
    <ul aria-hidden={hidden || undefined} className="flex shrink-0 divide-x divide-(--border)">
      {items.map((item) => {
        const Icon = item.delta ? DIRECTION_ICONS[item.delta.direction] : null
        return (
          <li key={item.key} className="flex shrink-0 flex-col justify-center px-4 first:pl-0">
            <span className="max-w-48 truncate text-xs text-(--muted)" title={item.label}>
              {item.label}
            </span>
            <span className="flex items-baseline gap-2 whitespace-nowrap">
              <span
                className="text-lg font-semibold"
                title={item.exact ? `Stored value: ${item.exact}` : undefined}
              >
                {item.value}
              </span>
              {item.delta && Icon && (
                <span className="flex items-center gap-0.5 text-xs text-(--foreground) tabular-nums">
                  <Icon aria-hidden className="size-3.5 shrink-0" />
                  {item.delta.text}
                </span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * A ticker: a compact row of label and value items. When they do not fit it
 * scrolls sideways, pausing on hover or focus; Pause stops it for good, and
 * with reduced motion it never moves (the row scrolls by hand instead). A
 * note says when the result holds more rows than the ticker shows.
 */
export function TickerPanel({
  config,
  result,
  label,
}: {
  config: TickerConfig
  result: QueryResult
  label: string
}) {
  const items = useMemo(() => tickerItems(config, result), [config, result])
  const viewport = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const width = useElementWidth(viewport)
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)")
  const [overflowing, setOverflowing] = useState(false)
  const [paused, setPaused] = useState(false)

  useLayoutEffect(() => {
    const row = list.current?.firstElementChild
    if (row) setOverflowing(row.scrollWidth > width)
  }, [items, width])

  if (items.length === 0) return <p className="text-sm text-(--muted)">The latest result has no rows.</p>
  const moving = overflowing && !reduced && !paused
  const style = { "--ticker-duration": `${items.length * SECONDS_PER_ITEM}s` } as CSSProperties
  const notes = resultNotes(result)

  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-1">
      <div className="flex min-h-0 items-center gap-2">
        <div
          ref={viewport}
          role="region"
          aria-label={label}
          // Focusable when it scrolls by hand, so keyboard users can scroll it.
          tabIndex={overflowing && !moving ? 0 : undefined}
          className={cn(
            "ticker min-w-0 flex-1 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)",
            moving ? "overflow-hidden" : "overflow-x-auto",
          )}
        >
          <div ref={list} className="ticker-track flex w-max" data-moving={moving} style={style}>
            <Items items={items} />
            {moving && <Items items={items} hidden />}
          </div>
        </div>
        {overflowing && !reduced && (
          <button
            type="button"
            onClick={() => setPaused(!paused)}
            aria-label={paused ? "Play the ticker" : "Pause the ticker"}
            title={paused ? "Play" : "Pause"}
            className="shrink-0 rounded-md p-1.5 text-(--muted) hover:bg-(--surface) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
          >
            {paused ? <Play aria-hidden className="size-4" /> : <Pause aria-hidden className="size-4" />}
          </button>
        )}
      </div>
      {notes.map((note) => (
        <p key={note} className="text-xs text-(--muted)">
          {note}
        </p>
      ))}
    </div>
  )
}
