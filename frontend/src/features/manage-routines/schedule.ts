/**
 * Schedule presets as the form edits them, and the 5-field cron each stands
 * for (minute, hour, day of month, month, day of week; Sunday is 0). A cron
 * that matches no preset is edited as written.
 */
export type SchedulePreset =
  | { kind: "minutes"; every: number }
  | { kind: "hours"; every: number; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "monthly"; day: number; time: string }
  | { kind: "custom"; cron: string }

export type PresetKind = SchedulePreset["kind"]

export const PRESET_LABELS: Record<PresetKind, string> = {
  minutes: "Every few minutes",
  hours: "Every few hours",
  daily: "Every day",
  weekdays: "Every weekday (Monday to Friday)",
  weekly: "On chosen days of the week",
  monthly: "Once a month",
  custom: "Custom (cron)",
}

/** Steps that divide the hour (or day) evenly, so runs stay the same distance apart. */
export const MINUTE_STEPS = [5, 10, 15, 20, 30] as const
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const

/** Monday first, as people read a week; values are cron's (Sunday is 0). */
export const WEEKDAYS = [
  { value: 1, label: "Mon", name: "Monday" },
  { value: 2, label: "Tue", name: "Tuesday" },
  { value: 3, label: "Wed", name: "Wednesday" },
  { value: 4, label: "Thu", name: "Thursday" },
  { value: 5, label: "Fri", name: "Friday" },
  { value: 6, label: "Sat", name: "Saturday" },
  { value: 0, label: "Sun", name: "Sunday" },
] as const

export const DEFAULT_PRESET: SchedulePreset = { kind: "weekdays", time: "09:00" }

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const pad = (value: number) => String(value).padStart(2, "0")

/** "09:30" from an hour and minute. */
export function timeOf(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`
}

/** The hour and minute of "HH:MM", or null. */
export function parseTime(time: string): { hour: number; minute: number } | null {
  const match = TIME.exec(time)
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null
}

export function normalizeCron(cron: string): string {
  return cron.trim().split(/\s+/).join(" ")
}

/** The cron a preset stands for (a preset with an unusable time still yields text the server explains). */
export function presetToCron(preset: SchedulePreset): string {
  if (preset.kind === "custom") return normalizeCron(preset.cron)
  if (preset.kind === "minutes") return `*/${preset.every} * * * *`
  if (preset.kind === "hours") {
    return preset.every === 1 ? `${preset.minute} * * * *` : `${preset.minute} */${preset.every} * * *`
  }
  const time = parseTime(preset.time) ?? { hour: 0, minute: 0 }
  const at = `${time.minute} ${time.hour}`
  switch (preset.kind) {
    case "daily":
      return `${at} * * *`
    case "weekdays":
      return `${at} * * 1-5`
    case "weekly":
      return `${at} * * ${[...new Set(preset.days)].sort((a, b) => a - b).join(",")}`
    case "monthly":
      return `${at} ${preset.day} * *`
  }
}

const number = (text: string | undefined, max: number): number | null => {
  if (text === undefined || !/^\d{1,2}$/.test(text)) return null
  const value = Number(text)
  return value <= max ? value : null
}

/** The preset a cron is written as, or a custom schedule when it is not one of them. */
export function cronToPreset(cron: string): SchedulePreset {
  const text = normalizeCron(cron)
  const custom: SchedulePreset = { kind: "custom", cron: text }
  const fields = text.split(" ")
  if (fields.length !== 5) return custom
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ]
  if (monthField !== "*") return custom
  const step = /^\*\/(\d{1,2})$/
  if (dayField === "*" && weekdayField === "*") {
    const minutes = step.exec(minuteField)
    if (minutes && hourField === "*") {
      const every = Number(minutes[1])
      return (MINUTE_STEPS as readonly number[]).includes(every) ? { kind: "minutes", every } : custom
    }
    const minute = number(minuteField, 59)
    if (minute === null) return custom
    if (hourField === "*") return { kind: "hours", every: 1, minute }
    const hours = step.exec(hourField)
    if (hours) {
      const every = Number(hours[1])
      return (HOUR_STEPS as readonly number[]).includes(every) ? { kind: "hours", every, minute } : custom
    }
  }
  const minute = number(minuteField, 59)
  const hour = number(hourField, 23)
  if (minute === null || hour === null) return custom
  const time = timeOf(hour, minute)
  if (dayField === "*") {
    if (weekdayField === "*") return { kind: "daily", time }
    if (weekdayField === "1-5") return { kind: "weekdays", time }
    if (/^[0-6](,[0-6])*$/.test(weekdayField)) {
      const days = [...new Set(weekdayField.split(",").map(Number))].sort((a, b) => a - b)
      return { kind: "weekly", days, time }
    }
    return custom
  }
  const day = number(dayField, 31)
  return weekdayField === "*" && day !== null && day >= 1 ? { kind: "monthly", day, time } : custom
}

/** The preset of another kind, keeping the time of day (and the cron, for custom) where it can. */
export function switchPreset(current: SchedulePreset, kind: PresetKind): SchedulePreset {
  if (kind === current.kind) return current
  const time = "time" in current && parseTime(current.time) ? current.time : "09:00"
  switch (kind) {
    case "minutes":
      return { kind, every: 15 }
    case "hours":
      return { kind, every: 1, minute: parseTime(time)?.minute ?? 0 }
    case "daily":
    case "weekdays":
      return { kind, time }
    case "weekly":
      return { kind, days: [1], time }
    case "monthly":
      return { kind, day: 1, time }
    case "custom":
      return { kind, cron: presetToCron(current) }
  }
}

/** What to fix before the schedule can be saved, or null; the server checks the rest. */
export function presetProblem(preset: SchedulePreset): string | null {
  switch (preset.kind) {
    case "custom":
      return normalizeCron(preset.cron).split(" ").length === 5
        ? null
        : "Write five fields: minute, hour, day of month, month, and day of week."
    case "minutes":
      return null
    case "hours":
      return Number.isInteger(preset.minute) && preset.minute >= 0 && preset.minute <= 59
        ? null
        : "Choose a minute from 0 to 59."
    case "weekly":
      if (preset.days.length === 0) return "Choose at least one day."
      break
    case "monthly":
      if (!Number.isInteger(preset.day) || preset.day < 1 || preset.day > 31) {
        return "Choose a day from 1 to 31."
      }
      break
    case "daily":
    case "weekdays":
      break
  }
  return parseTime(preset.time) ? null : "Choose a time of day."
}
