import assert from "node:assert/strict"
import test from "node:test"

import {
  catchUp,
  describeSchedule,
  minimumGapMinutes,
  nextRunAfter,
  normalizeCron,
  scheduleProblem,
  upcomingRuns,
  wallClock,
} from "../../src/routines/schedule.js"
import { createRoutineSchema, updateRoutineSchema } from "../../src/routines/schemas.js"

const iso = (dates: Date[]) => dates.map((date) => date.toISOString())
const at = (text: string) => new Date(text)

test("schedules are five valid cron fields that run at some point", () => {
  assert.equal(scheduleProblem("0 9 * * 1-5", "UTC", 5), null)
  assert.equal(scheduleProblem("*/15 * * * *", "Asia/Kolkata", 5), null)
  assert.equal(scheduleProblem("0 9 * * MON-FRI", "UTC", 5), null)
  assert.match(scheduleProblem("* * * *", "UTC", 5) ?? "", /five fields/)
  assert.match(scheduleProblem("0 0 9 * * *", "UTC", 5) ?? "", /five fields/)
  assert.match(scheduleProblem("@daily", "UTC", 5) ?? "", /five fields/)
  assert.match(scheduleProblem("61 * * * *", "UTC", 5) ?? "", /not a schedule Manifest can read: .*minute/)
  assert.match(scheduleProblem("0 9 30 2 *", "UTC", 5) ?? "", /never runs/)
})

test("schedules leave at least the minimum interval between runs", () => {
  assert.equal(minimumGapMinutes("*/5 * * * *"), 5)
  assert.equal(minimumGapMinutes("0 9 * * *"), 1_440)
  assert.equal(minimumGapMinutes("0,30 9 * * *"), 30)
  // 23:59 and the next day's 00:00 are a minute apart.
  assert.equal(minimumGapMinutes("0,59 0,23 * * *"), 1)
  assert.equal(minimumGapMinutes("0 */2 * * *"), 120)
  assert.match(scheduleProblem("*/2 * * * *", "UTC", 5) ?? "", /2 minutes apart.*every 5 minutes/)
  assert.match(scheduleProblem("* 9 * * *", "UTC", 5) ?? "", /every minute/)
  assert.equal(scheduleProblem("*/2 * * * *", "UTC", 1), null)
})

test("next runs follow the time zone, skipping a spring-forward gap and running an overlap once", () => {
  // 09:00 in India is 03:30 UTC; weekdays only, from Saturday 31 October.
  assert.deepEqual(iso(upcomingRuns("0 9 * * 1-5", "Asia/Kolkata", at("2026-10-31T00:00:00Z"), 3)), [
    "2026-11-02T03:30:00.000Z",
    "2026-11-03T03:30:00.000Z",
    "2026-11-04T03:30:00.000Z",
  ])
  // New York springs forward on 8 March 2026: 02:30 does not exist, so it runs at 03:00 EDT.
  assert.deepEqual(iso(upcomingRuns("30 2 * * *", "America/New_York", at("2026-03-07T12:00:00Z"), 3)), [
    "2026-03-08T07:00:00.000Z",
    "2026-03-09T06:30:00.000Z",
    "2026-03-10T06:30:00.000Z",
  ])
  // It falls back on 1 November 2026: 01:30 happens twice and runs once, at the first (EDT).
  assert.deepEqual(iso(upcomingRuns("30 1 * * *", "America/New_York", at("2026-10-31T12:00:00Z"), 2)), [
    "2026-11-01T05:30:00.000Z",
    "2026-11-02T06:30:00.000Z",
  ])
  // A schedule with several times an hour runs in both occurrences of the repeated hour.
  assert.deepEqual(iso(upcomingRuns("*/30 * * * *", "America/New_York", at("2026-11-01T04:45:00Z"), 4)), [
    "2026-11-01T05:00:00.000Z",
    "2026-11-01T05:30:00.000Z",
    "2026-11-01T06:00:00.000Z",
    "2026-11-01T06:30:00.000Z",
  ])
  // Monthly on the 31st skips shorter months; Berlin is UTC+1 in winter.
  assert.deepEqual(iso(upcomingRuns("0 8 31 * *", "Europe/Berlin", at("2026-11-01T00:00:00Z"), 2)), [
    "2026-12-31T07:00:00.000Z",
    "2027-01-31T07:00:00.000Z",
  ])
})

test("the next run is strictly after the given time", () => {
  const slot = at("2026-10-31T10:15:00Z")
  assert.equal(nextRunAfter("*/15 * * * *", "UTC", slot)?.toISOString(), "2026-10-31T10:30:00.000Z")
  assert.equal(
    nextRunAfter("*/15 * * * *", "UTC", at("2026-10-31T10:14:59.900Z"))?.toISOString(),
    "2026-10-31T10:15:00.000Z",
  )
})

test("a routine due on time runs its slot and moves to the next one", () => {
  const due = at("2026-10-31T10:00:00Z")
  const plan = catchUp("*/5 * * * *", "UTC", due, at("2026-10-31T10:00:12Z"))
  assert.equal(plan.slot.toISOString(), due.toISOString())
  assert.equal(plan.missed, null)
  assert.equal(plan.next?.toISOString(), "2026-10-31T10:05:00.000Z")
})

test("after downtime only the latest due slot runs, and the skipped ones are counted", () => {
  const plan = catchUp("*/5 * * * *", "UTC", at("2026-10-31T09:05:00Z"), at("2026-10-31T10:02:00Z"))
  assert.equal(plan.slot.toISOString(), "2026-10-31T10:00:00.000Z")
  assert.deepEqual(plan.missed, {
    count: 11,
    more: false,
    first: "2026-10-31T09:05:00.000Z",
    last: "2026-10-31T09:55:00.000Z",
  })
  assert.equal(plan.next?.toISOString(), "2026-10-31T10:05:00.000Z")
  // Exactly on a slot, that slot runs.
  const onSlot = catchUp("0 * * * *", "UTC", at("2026-10-31T08:00:00Z"), at("2026-10-31T10:00:00Z"))
  assert.equal(onSlot.slot.toISOString(), "2026-10-31T10:00:00.000Z")
  assert.equal(onSlot.missed?.count, 2)
  // Months of downtime on a frequent schedule are counted up to a limit.
  const long = catchUp("*/5 * * * *", "UTC", at("2026-01-01T00:00:00Z"), at("2026-10-31T10:02:00Z"))
  assert.equal(long.missed?.count, 1_000)
  assert.equal(long.missed?.more, true)
  assert.equal(long.missed?.last, "2026-10-31T09:55:00.000Z")
})

test("schedules read in plain words, and slots as the zone's clock shows them", () => {
  assert.equal(describeSchedule("0 9 * * 1-5"), "At 09:00, Monday through Friday")
  assert.equal(describeSchedule("*/15 * * * *"), "Every 15 minutes")
  assert.equal(describeSchedule("30 8 1 * *"), "At 08:30, on day 1 of the month")
  assert.equal(wallClock(at("2026-11-02T03:30:00Z"), "Asia/Kolkata"), "2026-11-02 09:00")
  assert.equal(normalizeCron("  0   9 *\t* 1-5 "), "0 9 * * 1-5")
})

test("routine input names its kind and normalizes the schedule", () => {
  const savedQuery = createRoutineSchema.parse({
    name: " Daily orders ",
    kind: "saved_query",
    savedQueryId: "6f0d9a5e-0d5e-4c39-8f4c-6b1b9f1c2a10",
    parameters: { since: "yesterday" },
    cron: "0  9 * * *",
  })
  assert.equal(savedQuery.name, "Daily orders")
  assert.equal(savedQuery.cron, "0 9 * * *")
  assert.equal(savedQuery.enabled, true)
  assert.deepEqual(savedQuery.delivery, { channel: "in_app" })
  const question = { name: "Q", kind: "question", question: "Open tickets?", cron: "0 9 * * *" }
  const parsed = createRoutineSchema.parse(question)
  assert.deepEqual(parsed.kind === "question" && parsed.connectionIds, [])
  const refused = (extra: Record<string, unknown>) => {
    const result = createRoutineSchema.safeParse({ ...question, ...extra })
    assert.equal(result.success, false, JSON.stringify(extra))
  }
  // Fields of the other kind, unknown time zones, and other delivery channels are refused.
  refused({ savedQueryId: "6f0d9a5e-0d5e-4c39-8f4c-6b1b9f1c2a10" })
  refused({ timeZone: "Mars/Base" })
  refused({ delivery: { channel: "chat" } })
  // An update names its version and changes something; leaving parameters out does not clear them.
  assert.equal(updateRoutineSchema.safeParse({ version: 1 }).success, false)
  assert.deepEqual(updateRoutineSchema.parse({ version: 2, enabled: false }), { version: 2, enabled: false })
})
