import { CircleCheck, CircleDashed, CircleX } from "lucide-react"

import type { ConnectionStatus } from "@/entities/connections/types.ts"
import { Badge } from "@/shared/ui/badge.tsx"

const STATUS = {
  connected: { tone: "success", label: "Connected", Icon: CircleCheck },
  failed: { tone: "danger", label: "Connection failed", Icon: CircleX },
  untested: { tone: "neutral", label: "Not tested", Icon: CircleDashed },
} as const

export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  const { tone, label, Icon } = STATUS[status]
  return (
    <Badge tone={tone}>
      <Icon aria-hidden className="size-3.5" />
      {label}
    </Badge>
  )
}
