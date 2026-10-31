import { ResponsiveContainer, Sankey, Tooltip, type TooltipContentProps } from "recharts"

import { formatExact, type SankeyData } from "../chart-data.ts"
import { SERIES_COLORS } from "./colors.ts"

/** Node labels longer than this are shortened; the tooltip and table view keep the full name. */
const LABEL_CHARS = 24

const EXACT = { format: "number", decimals: null, currency: null } as const

interface NodeShape {
  x: number
  y: number
  width: number
  height: number
  payload: { name: string; sourceLinks?: unknown[] }
}

/** A node with its name beside it: to the right, or to the left for nodes nothing flows out of. */
function Node({ x, y, width, height, payload }: NodeShape) {
  const end = (payload.sourceLinks?.length ?? 0) === 0
  const name = payload.name.length > LABEL_CHARS ? `${payload.name.slice(0, LABEL_CHARS)}…` : payload.name
  return (
    <g>
      <rect x={x} y={y} width={width} height={Math.max(height, 1)} rx={2} fill={SERIES_COLORS[0]} />
      <text
        x={end ? x - 6 : x + width + 6}
        y={y + height / 2}
        textAnchor={end ? "end" : "start"}
        dominantBaseline="middle"
        fontSize={12}
        fill="var(--foreground)"
      >
        {name}
      </text>
    </g>
  )
}

function FlowTooltip({
  active,
  payload,
  data,
}: Pick<TooltipContentProps, "active" | "payload"> & { data: SankeyData }) {
  const item = payload?.[0]?.payload as
    { name?: string; source?: { name: string }; target?: { name: string } } | undefined
  if (!active || !item) return null
  const nodeIndex = (name: string | undefined) => data.nodes.findIndex((node) => node.name === name)
  let label: string
  let value: string
  if (item.source && item.target) {
    const from = nodeIndex(item.source.name)
    const to = nodeIndex(item.target.name)
    const link = data.links.find((candidate) => candidate.source === from && candidate.target === to)
    label = `${item.source.name} → ${item.target.name}`
    value = formatExact(link?.exact ?? null, EXACT)
  } else {
    const node = data.nodes[nodeIndex(item.name)]
    label = item.name ?? ""
    value = formatExact(node?.exact ?? null, EXACT)
  }
  return (
    <div className="max-w-64 rounded-md border border-(--border) bg-white px-3 py-2 text-xs shadow-md">
      <p className="font-semibold tabular-nums">{value}</p>
      <p className="break-words text-(--muted)">{label}</p>
    </div>
  )
}

/** Flows between nodes as bands as wide as their values, with exact totals on hover. Loads with Recharts. */
export function SankeyChart({ data, title }: { data: SankeyData; title: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%" minHeight={160}>
      <Sankey
        // Plain numbers only: exact values stay here for the tooltip.
        data={{
          nodes: data.nodes.map(({ name }) => ({ name })),
          links: data.links.map(({ source, target, value }) => ({ source, target, value })),
        }}
        node={(props) => <Node {...props} />}
        link={{ stroke: SERIES_COLORS[0], strokeOpacity: 0.25 }}
        nodeWidth={10}
        nodePadding={12}
        margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
        title={title}
      >
        <Tooltip
          content={(props) => <FlowTooltip active={props.active} payload={props.payload} data={data} />}
        />
      </Sankey>
    </ResponsiveContainer>
  )
}
