import type { InputHTMLAttributes, LabelHTMLAttributes, SelectHTMLAttributes } from "react"

import { cn } from "../lib/cn.ts"

const fieldClass =
  "w-full rounded-md border border-(--border) bg-white px-3 py-2 text-sm text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent) disabled:opacity-50"

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldClass, className)} {...props} />
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldClass, className)} {...props} />
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium", className)} {...props} />
}
