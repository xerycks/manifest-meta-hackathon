// Calendar dates and wall-clock times in an IANA time zone, using only Intl.
// Relative values ("start_of_month") are calendar dates in the workspace's
// zone; a datetime parameter starts at that date's first instant there.

export interface CalendarDate {
  year: number
  month: number
  day: number
}

export interface WallTime extends CalendarDate {
  hour: number
  minute: number
  second: number
  millisecond: number
}

const DAY_MS = 86_400_000

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone)
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
    formatters.set(timeZone, found)
  }
  return found
}

/** The wall-clock time an instant shows in a time zone. */
export function wallTimeAt(epochMs: number, timeZone: string): WallTime {
  const parts: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value)
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
    millisecond: ((epochMs % 1000) + 1000) % 1000,
  }
}

const asUtc = (time: WallTime) =>
  Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second, time.millisecond)

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
export function offsetAt(epochMs: number, timeZone: string): number {
  return asUtc(wallTimeAt(epochMs, timeZone)) - epochMs
}

const sameWallTime = (a: WallTime, b: WallTime) => asUtc(a) === asUtc(b)

/**
 * The instant a wall-clock time names in a time zone. A time that happens
 * twice (clocks going back) is its first occurrence; one that never happens
 * (clocks going forward) moves forward by the gap, as the clocks did.
 */
export function instantOf(time: WallTime, timeZone: string): number {
  const local = asUtc(time)
  const before = offsetAt(local - DAY_MS, timeZone)
  const after = offsetAt(local + DAY_MS, timeZone)
  const matching = [local - before, local - after]
    .filter((epochMs) => sameWallTime(wallTimeAt(epochMs, timeZone), time))
    .sort((a, b) => a - b)
  return matching[0] ?? local - before
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0")

export function formatDate(date: CalendarDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`
}

function formatOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? "-" : "+"
  const totalSeconds = Math.round(Math.abs(offsetMs) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${sign}${pad(hours)}:${pad(minutes)}${seconds ? `:${pad(seconds)}` : ""}`
}

/** An instant as ISO 8601 in the zone's wall-clock time with its offset, e.g. 2026-10-01T00:00:00+05:30. */
export function formatInstant(epochMs: number, timeZone: string): string {
  const time = wallTimeAt(epochMs, timeZone)
  const fraction = time.millisecond ? `.${pad(time.millisecond, 3)}` : ""
  return (
    `${formatDate(time)}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}${fraction}` +
    formatOffset(offsetAt(epochMs, timeZone))
  )
}

export function isValidDate(date: CalendarDate): boolean {
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day))
  return (
    date.year >= 1000 &&
    date.year <= 9999 &&
    check.getUTCFullYear() === date.year &&
    check.getUTCMonth() === date.month - 1 &&
    check.getUTCDate() === date.day
  )
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() }
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** The same day `months` earlier (negative) or later, or that month's last day if it is shorter. */
export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const index = date.year * 12 + (date.month - 1) + months
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) }
}

/** Monday of the date's ISO week. */
export function startOfWeek(date: CalendarDate): CalendarDate {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
  return addDays(date, -((weekday + 6) % 7))
}

/** The first instant of a calendar date in a time zone (not always midnight where clocks jump at midnight). */
export function startOfDay(date: CalendarDate, timeZone: string): number {
  return instantOf({ ...date, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone)
}
