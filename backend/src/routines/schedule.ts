import { Cron, CronPattern } from "croner"
import cronstrue from "cronstrue"

import { formatDate, wallTimeAt } from "../saved-queries/dates.js"

// Routine schedules: standard 5-field cron (minute, hour, day of month, month,
// day of week) read in an IANA time zone. croner computes the runs: a time a
// spring-forward gap skips runs at the first minute after the gap, a time a
// fall-back overlap repeats runs once (its first occurrence), and patterns
// with several times an hour run in both occurrences.

/** Slots counted one by one when noting runs missed during downtime; beyond it, "more than". */
export const MISSED_COUNT_LIMIT = 1_000

const FIELDS = /^\S+(?: \S+){4}$/
const DAY_MINUTES = 1_440

/** The schedule's slots missed while no backend was running; only the latest due slot runs. */
export interface MissedSlots {
  /** At most MISSED_COUNT_LIMIT; `more` says there were more. */
  count: number
  more: boolean
  first: string
  last: string
}

/** The cron as stored: trimmed, with single spaces between its fields. */
export function normalizeCron(text: string): string {
  return text.trim().split(/\s+/).join(" ")
}

function cronOf(cron: string, timeZone: string): Cron {
  return new Cron(cron, { timezone: timeZone, mode: "5-part" })
}

/** croner's messages start with the class that threw them. */
const parseMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/^Cron(Pattern)?:\s*/, "")

/**
 * The shortest time between two runs on a day the schedule runs, in minutes:
 * from its times of day, counting midnight as the next day's first run.
 */
export function minimumGapMinutes(cron: string): number {
  const pattern = new CronPattern(cron, "UTC", { mode: "5-part" })
  const times: number[] = []
  pattern.hour.forEach((hour, h) => {
    if (!hour) return
    pattern.minute.forEach((minute, m) => {
      if (minute) times.push(h * 60 + m)
    })
  })
  const [first, ...rest] = times
  if (first === undefined) return DAY_MINUTES
  let gap = DAY_MINUTES - (times.at(-1) ?? first) + first
  let previous = first
  for (const time of rest) {
    gap = Math.min(gap, time - previous)
    previous = time
  }
  return gap
}

/**
 * Why a schedule cannot be used, in words for the person writing it, or null:
 * it must be 5 valid cron fields, run at some point, and leave at least
 * `minIntervalMinutes` between runs.
 */
export function scheduleProblem(cron: string, timeZone: string, minIntervalMinutes: number): string | null {
  if (!FIELDS.test(cron)) {
    return "Write the schedule as five fields: minute, hour, day of month, month, and day of week (for example 0 9 * * 1-5)."
  }
  let schedule: Cron
  try {
    schedule = cronOf(cron, timeZone)
  } catch (error) {
    return `This is not a schedule Manifest can read: ${parseMessage(error)}.`
  }
  if (!schedule.nextRun()) return "This schedule never runs: no date matches it."
  const gap = minimumGapMinutes(cron)
  if (gap < minIntervalMinutes) {
    return `This schedule runs ${gap === 1 ? "every minute" : `${gap} minutes apart`} at times. Routines run at most once every ${minIntervalMinutes} minutes.`
  }
  return null
}

/** The schedule's first run after `after` (a run exactly then does not count). */
export function nextRunAfter(cron: string, timeZone: string, after: Date): Date | null {
  return cronOf(cron, timeZone).nextRun(after)
}

/** The schedule's next `count` runs after `after`. */
export function upcomingRuns(cron: string, timeZone: string, after: Date, count: number): Date[] {
  return cronOf(cron, timeZone).nextRuns(count, after)
}

/** "2026-10-31 09:00" as the clock reads in the time zone. */
export function wallClock(time: Date, timeZone: string): string {
  const wall = wallTimeAt(time.getTime(), timeZone)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${formatDate(wall)} ${pad(wall.hour)}:${pad(wall.minute)}`
}

/**
 * Which slot a routine due since `due` runs at `now`: the latest one that has
 * come, so a routine that was due during downtime runs once rather than once
 * per missed slot. The slots it skips are counted for a note. `next` is the
 * first slot after `now`.
 */
export function catchUp(
  cron: string,
  timeZone: string,
  due: Date,
  now: Date,
): { slot: Date; missed: MissedSlots | null; next: Date | null } {
  const schedule = cronOf(cron, timeZone)
  const next = schedule.nextRun(now)
  // previousRuns counts whole seconds before its reference, so add one to include `now`.
  const [latest] = schedule.previousRuns(1, new Date(now.getTime() + 1_000))
  if (!latest || latest.getTime() <= due.getTime()) return { slot: due, missed: null, next }
  let count = 0
  for (let slot: Date | null = due; slot && slot < latest && count < MISSED_COUNT_LIMIT; ) {
    count += 1
    slot = schedule.nextRun(slot)
  }
  const [last] = schedule.previousRuns(1, latest)
  return {
    slot: latest,
    missed: {
      count,
      more: count >= MISSED_COUNT_LIMIT,
      first: due.toISOString(),
      last: (last ?? due).toISOString(),
    },
    next,
  }
}

/** The schedule in plain words, e.g. "At 09:00, Monday through Friday". */
export function describeSchedule(cron: string): string {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: true, verbose: false })
  } catch {
    return `On the schedule ${cron}`
  }
}
