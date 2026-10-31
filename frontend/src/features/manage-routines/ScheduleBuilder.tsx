import { useId } from "react"

import { useSchedulePreview } from "@/entities/routines/api.ts"
import { formatInZone } from "@/entities/routines/status.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { useDebouncedValue } from "@/shared/lib/use-debounced-value.ts"
import { Checkbox, Input, Label, Select } from "@/shared/ui/fields.tsx"
import { described, Field } from "@/shared/ui/form-field.tsx"

import {
  HOUR_STEPS,
  MINUTE_STEPS,
  PRESET_LABELS,
  presetToCron,
  switchPreset,
  WEEKDAYS,
  type PresetKind,
  type SchedulePreset,
} from "./schedule.ts"

const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")]
const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, index) => index + 1)
const CRON_HINT =
  "Five fields: minute, hour, day of month, month, day of week (0 or 7 is Sunday). For example, 0 9 * * 1-5 is 09:00 on weekdays."
const ZONE_HINT = "The schedule, and relative dates in its parameters, are read in this time zone."

function TimeInput({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (time: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>At</Label>
      <Input
        id={id}
        type="time"
        value={value}
        className="w-auto"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

/** The fields of the chosen preset. */
function PresetFields({
  preset,
  onChange,
}: {
  preset: SchedulePreset
  onChange: (preset: SchedulePreset) => void
}) {
  const id = useId()
  switch (preset.kind) {
    case "minutes":
      return (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-every`}>Every</Label>
          <Select
            id={`${id}-every`}
            className="w-auto"
            value={preset.every}
            onChange={(event) => onChange({ ...preset, every: Number(event.target.value) })}
          >
            {MINUTE_STEPS.map((step) => (
              <option key={step} value={step}>
                {step} minutes
              </option>
            ))}
          </Select>
        </div>
      )
    case "hours":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-every`}>Every</Label>
            <Select
              id={`${id}-every`}
              className="w-auto"
              value={preset.every}
              onChange={(event) => onChange({ ...preset, every: Number(event.target.value) })}
            >
              {HOUR_STEPS.map((step) => (
                <option key={step} value={step}>
                  {step === 1 ? "hour" : `${step} hours`}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-32 space-y-1.5">
            <Label htmlFor={`${id}-minute`}>At minute</Label>
            <Input
              id={`${id}-minute`}
              type="number"
              min={0}
              max={59}
              inputMode="numeric"
              value={Number.isNaN(preset.minute) ? "" : preset.minute}
              onChange={(event) => onChange({ ...preset, minute: event.target.valueAsNumber })}
            />
          </div>
        </div>
      )
    case "daily":
    case "weekdays":
      return (
        <TimeInput id={`${id}-time`} value={preset.time} onChange={(time) => onChange({ ...preset, time })} />
      )
    case "weekly":
      return (
        <div className="space-y-3">
          <fieldset>
            <legend className="text-sm font-medium">On</legend>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-2">
              {WEEKDAYS.map((day) => (
                <label key={day.value} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={preset.days.includes(day.value)}
                    aria-label={day.name}
                    onChange={(event) =>
                      onChange({
                        ...preset,
                        days: event.target.checked
                          ? [...preset.days, day.value]
                          : preset.days.filter((value) => value !== day.value),
                      })
                    }
                  />
                  {day.label}
                </label>
              ))}
            </div>
          </fieldset>
          <TimeInput id={`${id}-time`} value={preset.time} onChange={(time) => onChange({ ...preset, time })} />
        </div>
      )
    case "monthly":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-day`}>On day</Label>
            <Select
              id={`${id}-day`}
              className="w-auto"
              value={preset.day}
              onChange={(event) => onChange({ ...preset, day: Number(event.target.value) })}
            >
              {DAYS_OF_MONTH.map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </Select>
          </div>
          <TimeInput id={`${id}-time`} value={preset.time} onChange={(time) => onChange({ ...preset, time })} />
          {preset.day > 28 && (
            <p className="w-full text-xs text-(--muted)">Months without day {preset.day} are skipped.</p>
          )}
        </div>
      )
    case "custom":
      return (
        <Field id={`${id}-cron`} label="Cron schedule" hint={CRON_HINT}>
          <Input
            {...described(`${id}-cron`, undefined, CRON_HINT)}
            value={preset.cron}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            onChange={(event) => onChange({ ...preset, cron: event.target.value })}
          />
        </Field>
      )
  }
}

/** The schedule in words and its next runs in the zone, as the server reads it, or why it cannot be used. */
function Preview({ workspaceId, cron, timeZone }: { workspaceId: string; cron: string; timeZone: string }) {
  const debouncedCron = useDebouncedValue(cron, 300)
  const debouncedZone = useDebouncedValue(timeZone.trim(), 300)
  const preview = useSchedulePreview(workspaceId, debouncedCron, debouncedZone)
  return (
    <div aria-live="polite" className="rounded-md bg-(--surface) px-3 py-2 text-sm">
      {preview.isError ? (
        <p className="text-(--danger)">{apiErrorMessage(preview.error)}</p>
      ) : preview.data ? (
        <>
          <p className="font-medium">
            {preview.data.schedule} ({preview.data.timeZone})
          </p>
          <p className="mt-1 text-xs text-(--muted)">Next runs:</p>
          <ol className="mt-0.5 space-y-0.5">
            {preview.data.upcoming.map((time) => (
              <li key={time}>
                <time dateTime={time}>{formatInZone(time, preview.data.timeZone)}</time>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="text-(--muted)">Checking the schedule…</p>
      )}
    </div>
  )
}

/**
 * When a routine runs: a preset (every few minutes or hours, daily, weekdays,
 * chosen days, monthly) or a cron, read in a time zone, with a preview of the
 * next runs there.
 */
export function ScheduleBuilder({
  workspaceId,
  preset,
  timeZone,
  scheduleError,
  timeZoneError,
  onPresetChange,
  onTimeZoneChange,
}: {
  workspaceId: string
  preset: SchedulePreset
  timeZone: string
  scheduleError: string | undefined
  timeZoneError: string | undefined
  onPresetChange: (preset: SchedulePreset) => void
  onTimeZoneChange: (timeZone: string) => void
}) {
  const id = useId()
  return (
    <fieldset className="space-y-4">
      <legend className="text-base font-semibold tracking-tight">Schedule</legend>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-repeats`}>Runs</Label>
        <Select
          id={`${id}-repeats`}
          className="w-auto max-w-full"
          value={preset.kind}
          onChange={(event) => onPresetChange(switchPreset(preset, event.target.value as PresetKind))}
        >
          {(Object.keys(PRESET_LABELS) as PresetKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {PRESET_LABELS[kind]}
            </option>
          ))}
        </Select>
      </div>
      <PresetFields preset={preset} onChange={onPresetChange} />
      {scheduleError && <p className="text-xs font-medium text-(--danger)">{scheduleError}</p>}
      <Field
        id={`${id}-zone`}
        label="Time zone"
        error={timeZoneError}
        hint={ZONE_HINT}
        className="max-w-sm"
      >
        <Input
          {...described(`${id}-zone`, timeZoneError, ZONE_HINT)}
          list={`${id}-zones`}
          value={timeZone}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onTimeZoneChange(event.target.value)}
        />
        <datalist id={`${id}-zones`}>
          {TIME_ZONES.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </Field>
      <Preview workspaceId={workspaceId} cron={presetToCron(preset)} timeZone={timeZone} />
    </fieldset>
  )
}
