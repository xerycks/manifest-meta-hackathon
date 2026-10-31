import { useId } from "react"

import { describeParameterValue, PARAMETER_TYPE_LABELS } from "@/entities/saved-queries/parameters.ts"
import type { ParameterDefinition } from "@/entities/saved-queries/types.ts"
import { Input, Label, Select } from "@/shared/ui/fields.tsx"

import { OVERRIDE_CHOICES, type OverrideChoice, type OverrideDraft } from "./routine-form.ts"

const DEFAULT_ROW: OverrideDraft = { choice: "default", count: "7", absolute: "" }

function OverrideRow({
  definition,
  draft,
  error,
  onChange,
}: {
  definition: ParameterDefinition
  draft: OverrideDraft
  error: string | undefined
  onChange: (draft: OverrideDraft) => void
}) {
  const id = useId()
  const counted = draft.choice === "days_ago" || draft.choice === "months_ago"
  const defaultLabel = definition.default
    ? `The saved query's default: ${describeParameterValue(definition.default)}`
    : definition.required
      ? "Choose a value…"
      : "The saved query's default: no value"
  return (
    <fieldset aria-describedby={error ? `${id}-error` : undefined} className="space-y-2">
      <legend className="text-sm font-medium">
        {definition.label}{" "}
        <span className="font-normal text-(--muted)">
          ({PARAMETER_TYPE_LABELS[definition.type].toLowerCase()}
          {definition.required ? "" : ", optional"})
        </span>
      </legend>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 space-y-1">
          <Label htmlFor={`${id}-choice`} className="sr-only">
            Value for {definition.label}
          </Label>
          <Select
            id={`${id}-choice`}
            value={draft.choice}
            aria-invalid={error ? true : undefined}
            onChange={(event) => onChange({ ...draft, choice: event.target.value as OverrideChoice })}
          >
            <option value="default">{defaultLabel}</option>
            {!definition.required && <option value="none">No value</option>}
            {OVERRIDE_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </div>
        {counted && (
          <div className="w-28 space-y-1">
            <Label htmlFor={`${id}-count`}>
              {draft.choice === "days_ago" ? "Days before" : "Months before"}
            </Label>
            <Input
              id={`${id}-count`}
              type="number"
              min={0}
              inputMode="numeric"
              value={draft.count}
              onChange={(event) => onChange({ ...draft, count: event.target.value })}
            />
          </div>
        )}
        {draft.choice === "absolute" && (
          <div className="space-y-1">
            <Label htmlFor={`${id}-absolute`}>{definition.type === "date" ? "Date" : "Date and time"}</Label>
            <Input
              id={`${id}-absolute`}
              type={definition.type === "date" ? "date" : "datetime-local"}
              value={draft.absolute}
              className="w-auto"
              onChange={(event) => onChange({ ...draft, absolute: event.target.value })}
            />
          </div>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-(--danger)">
          {error}
        </p>
      )}
    </fieldset>
  )
}

/** The value each of the saved query's parameters takes on every run of the routine. */
export function ParameterOverrides({
  definitions,
  overrides,
  errors,
  onChange,
}: {
  definitions: ParameterDefinition[]
  overrides: Record<string, OverrideDraft>
  errors: Record<string, string> | undefined
  onChange: (overrides: Record<string, OverrideDraft>) => void
}) {
  if (definitions.length === 0) return null
  return (
    <div className="space-y-3 rounded-md border border-(--border) p-3">
      <p className="text-sm text-(--muted)">
        Parameters for every run. Relative dates resolve in the routine's time zone when it runs.
      </p>
      {definitions.map((definition) => (
        <OverrideRow
          key={definition.name}
          definition={definition}
          draft={overrides[definition.name] ?? DEFAULT_ROW}
          error={errors?.[definition.name]}
          onChange={(draft) => onChange({ ...overrides, [definition.name]: draft })}
        />
      ))}
    </div>
  )
}
