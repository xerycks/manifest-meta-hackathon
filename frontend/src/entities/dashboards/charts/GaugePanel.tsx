import { CircleCheck, OctagonAlert, TriangleAlert } from "lucide-react"

import type { QueryResult } from "@/entities/queries/types.ts"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"

import { formatBound, gaugeReading } from "../chart-data.ts"
import type { GaugeConfig, ThresholdStatus } from "../types.ts"
import { SERIES_COLORS } from "./colors.ts"

/** Statuses never rely on colour alone: each has its icon and its word. */
const STATUSES: Record<ThresholdStatus, { label: string; color: string; Icon: typeof CircleCheck }> = {
  good: { label: "Good", color: "var(--status-good)", Icon: CircleCheck },
  warning: { label: "Warning", color: "var(--status-warning)", Icon: TriangleAlert },
  critical: { label: "Critical", color: "var(--status-critical)", Icon: OctagonAlert },
}

const RADIUS = 80
const ARC = `M ${100 - RADIUS} 100 A ${RADIUS} ${RADIUS} 0 0 1 ${100 + RADIUS} 100`

/** The point at `ratio` along the arc (0 at the left end, 1 at the right), `radius` from its centre. */
function onArc(ratio: number, radius: number): { x: number; y: number } {
  const angle = Math.PI * (1 - ratio)
  return { x: 100 + radius * Math.cos(angle), y: 100 - radius * Math.sin(angle) }
}

/** A gauge: the value on a half-circle scale from min to max, with threshold marks and the status it reached. */
export function GaugePanel({ config, result }: { config: GaugeConfig; result: QueryResult }) {
  const reading = gaugeReading(config, result)
  if (reading.kind === "empty") return <p className="text-sm text-(--muted)">{reading.message}</p>
  if (reading.kind === "invalid") return <FailureNotice title="Not a number" message={reading.message} />
  const status = reading.status ? STATUSES[reading.status] : null
  const min = formatBound(config.min, config)
  const max = formatBound(config.max, config)
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1 text-center">
      <svg viewBox="0 0 200 112" aria-hidden className="max-h-40 w-full min-w-0 flex-1">
        <path d={ARC} fill="none" stroke="var(--chart-track)" strokeWidth={14} />
        {reading.ratio > 0 && (
          <path
            d={ARC}
            fill="none"
            stroke={status?.color ?? SERIES_COLORS[0]}
            strokeWidth={14}
            pathLength={100}
            strokeDasharray={`${reading.ratio * 100} 100`}
          />
        )}
        {config.thresholds.map((threshold) => {
          const ratio = (threshold.value - config.min) / (config.max - config.min)
          const inner = onArc(ratio, RADIUS - 11)
          const outer = onArc(ratio, RADIUS + 11)
          return (
            <line
              key={threshold.value}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="var(--foreground)"
              strokeWidth={1.5}
            />
          )
        })}
        <text x={100 - RADIUS} y={111} textAnchor="middle" fontSize={10} fill="var(--muted)">
          {min}
        </text>
        <text x={100 + RADIUS} y={111} textAnchor="middle" fontSize={10} fill="var(--muted)">
          {max}
        </text>
      </svg>
      <p
        className="text-2xl font-semibold tracking-tight wrap-anywhere"
        title={reading.exact !== reading.text ? `Stored value: ${reading.exact}` : undefined}
      >
        {reading.text}
        <span className="sr-only">
          {" "}
          on a scale from {min} to {max}
        </span>
      </p>
      {status && (
        <p className="flex items-center gap-1 text-sm">
          <status.Icon aria-hidden className="size-4 shrink-0" style={{ color: status.color }} />
          {status.label}
        </p>
      )}
      {reading.outside && (
        <p className="text-xs text-(--muted)">
          {reading.outside === "below" ? `Below the minimum (${min})` : `Above the maximum (${max})`}
        </p>
      )}
    </div>
  )
}
