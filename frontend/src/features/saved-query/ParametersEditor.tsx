import { Plus, Trash2 } from "lucide-react"
import { useId } from "react"

import type { ConnectionEngine } from "@/entities/connections/types.ts"
import { PARAMETER_TYPE_LABELS } from "@/entities/saved-queries/parameters.ts"
import { SAVED_QUERY_LIMITS, type ParameterType } from "@/entities/saved-queries/types.ts"
import { Button } from "@/shared/ui/button.tsx"
import { Checkbox, Input, Label, Select } from "@/shared/ui/fields.tsx"

import { DEFAULT_CHOICES, newParameter, type DefaultChoice, type ParameterDraft } from "./saved-query-form.ts"

const placeholderFor = (engine: ConnectionEngine, name: string) =>
  engine === "postgres" ? `{{${name || "name"}}}` : `{"$param": "${name || "name"}"}`

function ParameterRow({
  draft,
  index,
  engine,
  error,
  onChange,
  onRemove,
}: {
  draft: ParameterDraft
  index: number
  engine: ConnectionEngine
  error: string | undefined
  onChange: (draft: ParameterDraft) => void
  onRemove: () => void
}) {
  const id = useId()
  const set = (changes: Partial<ParameterDraft>) => onChange({ ...draft, ...changes })
  const counted = draft.defaultChoice === "days_ago" || draft.defaultChoice === "months_ago"

  return (
    <fieldset
      aria-describedby={error ? `${id}-error` : undefined}
      className="space-y-3 rounded-md border border-(--border) p-3"
    >
      <legend className="px-1 text-sm font-medium">Parameter {index + 1}</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            value={draft.name}
            maxLength={63}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            aria-invalid={error ? true : undefined}
            onChange={(event) => set({ name: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-label`}>Label (optional)</Label>
          <Input
            id={`${id}-label`}
            value={draft.label}
            maxLength={SAVED_QUERY_LIMITS.labelChars}
            placeholder="e.g. Orders since"
            onChange={(event) => set({ label: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-type`}>Type</Label>
          <Select
            id={`${id}-type`}
            value={draft.type}
            onChange={(event) => set({ type: event.target.value as ParameterType, absolute: "" })}
          >
            {(Object.keys(PARAMETER_TYPE_LABELS) as ParameterType[]).map((type) => (
              <option key={type} value={type}>
                {PARAMETER_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1 space-y-1 sm:flex-none">
          <Label htmlFor={`${id}-default`}>Default</Label>
          <Select
            id={`${id}-default`}
            value={draft.defaultChoice}
            onChange={(event) => set({ defaultChoice: event.target.value as DefaultChoice })}
          >
            {DEFAULT_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </div>
        {counted && (
          <div className="w-28 space-y-1">
            <Label htmlFor={`${id}-count`}>
              {draft.defaultChoice === "days_ago" ? "Days ago" : "Months ago"}
            </Label>
            <Input
              id={`${id}-count`}
              type="number"
              min={0}
              inputMode="numeric"
              value={draft.count}
              onChange={(event) => set({ count: event.target.value })}
            />
          </div>
        )}
        {draft.defaultChoice === "absolute" && (
          <div className="space-y-1">
            <Label htmlFor={`${id}-absolute`}>{draft.type === "date" ? "Date" : "Date and time"}</Label>
            <Input
              id={`${id}-absolute`}
              type={draft.type === "date" ? "date" : "datetime-local"}
              value={draft.absolute}
              onChange={(event) => set({ absolute: event.target.value })}
            />
          </div>
        )}
        <label className="flex items-center gap-2 py-2 text-sm">
          <Checkbox checked={draft.required} onChange={(event) => set({ required: event.target.checked })} />
          Required
        </label>
        <Button
          variant="ghost"
          className="ml-auto"
          onClick={onRemove}
          aria-label={`Remove parameter ${draft.name || index + 1}`}
        >
          <Trash2 aria-hidden className="size-4" />
          Remove
        </Button>
      </div>
      <p className="text-xs text-(--muted)">
        Use <code className="font-mono">{placeholderFor(engine, draft.name.trim())}</code> in the query where this
        date goes. Relative defaults resolve in the workspace time zone when the query runs.
      </p>
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-(--danger)">
          {error}
        </p>
      )}
    </fieldset>
  )
}

/** Date parameters of a saved query: each row names one, its type, default, and whether it is required. */
export function ParametersEditor({
  drafts,
  errors,
  engine,
  onChange,
}: {
  drafts: ParameterDraft[]
  errors: Record<number, string> | undefined
  engine: ConnectionEngine
  onChange: (drafts: ParameterDraft[]) => void
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">Parameters</p>
        <p className="text-xs leading-5 text-(--muted)">
          Dates that change from run to run. Values are bound to the query, never pasted into it.
        </p>
      </div>
      {drafts.map((draft, index) => (
        <ParameterRow
          key={index}
          draft={draft}
          index={index}
          engine={engine}
          error={errors?.[index]}
          onChange={(next) => onChange(drafts.map((item, at) => (at === index ? next : item)))}
          onRemove={() => onChange(drafts.filter((_, at) => at !== index))}
        />
      ))}
      <Button
        variant="secondary"
        disabled={drafts.length >= SAVED_QUERY_LIMITS.parameters}
        onClick={() => onChange([...drafts, newParameter(drafts)])}
      >
        <Plus aria-hidden className="size-4" />
        Add date parameter
      </Button>
    </div>
  )
}
