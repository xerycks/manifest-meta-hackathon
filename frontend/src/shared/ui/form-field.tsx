import { useId, type ReactNode } from "react"

import { cn } from "../lib/cn.ts"
import { Label } from "./fields.tsx"

/** A labelled control with its error, or else its hint, announced through `described`. */
export function Field({
  id,
  label,
  error,
  hint,
  className,
  children,
}: {
  id: string
  label: string
  error?: string | undefined
  hint?: string | undefined
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-message`} className="text-xs font-medium text-(--danger)">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-message`} className="text-xs leading-5 text-(--muted)">
            {hint}
          </p>
        )
      )}
    </div>
  )
}

/** Props that tie a control inside a Field to its label and message. */
export function described(id: string, error: string | undefined, hint?: string) {
  return {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error || hint ? `${id}-message` : undefined,
  }
}

/** A small set of mutually exclusive choices, shown as connected buttons. */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const name = useId()
  return (
    <fieldset>
      <legend className="text-sm font-medium">{label}</legend>
      <div className="mt-1.5 inline-flex flex-wrap rounded-md border border-(--border) p-0.5">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "cursor-pointer rounded px-3 py-1.5 text-sm has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--accent)",
              value === option.value ? "bg-(--surface) font-medium" : "text-(--muted) hover:text-(--foreground)",
            )}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
