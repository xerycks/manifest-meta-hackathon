import { cva, type VariantProps } from "class-variance-authority"
import { forwardRef, type ButtonHTMLAttributes } from "react"

import { cn } from "../lib/cn.ts"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent) disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-(--accent) px-4 py-2 text-white hover:bg-(--accent-strong)",
        secondary:
          "border border-(--border) bg-white px-4 py-2 text-(--foreground) hover:bg-(--surface)",
        ghost: "px-3 py-2 text-(--muted) hover:bg-(--surface) hover:text-(--foreground)",
      },
    },
    defaultVariants: { variant: "primary" },
  },
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, type = "button", ...props },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant }), className)} {...props} />
  )
})
