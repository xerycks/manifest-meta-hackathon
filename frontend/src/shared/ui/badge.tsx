import { cva, type VariantProps } from "class-variance-authority"
import type { HTMLAttributes } from "react"

import { cn } from "../lib/cn.ts"

const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "border-(--border) bg-(--surface) text-(--muted)",
        success: "border-(--success-border) bg-(--success-surface) text-(--success)",
        danger: "border-(--danger-border) bg-(--danger-surface) text-(--danger)",
        warning: "border-(--warning-border) bg-(--warning-surface) text-(--warning)",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
)

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
