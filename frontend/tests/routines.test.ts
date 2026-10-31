import assert from "node:assert/strict"
import test from "node:test"

import {
  canManageRoutine,
  formatInZone,
  routineState,
  runStatus,
  runTime,
  runUnderway,
  scheduleLabel,
} from "../src/entities/routines/status.ts"
import type { RoutineDetail } from "../src/entities/routines/types.ts"
import type { ParameterDefinition } from "../src/entities/saved-queries/types.ts"
import {
  draftFromRoutine,
  isEmptyPatch,
  newRoutineDraft,
  overrideDraft,
  routineInput,
  routinePatch,
  type RoutineDraft,
} from "../src/features/manage-routines/routine-form.ts"
import {
  cronToPreset,
  presetProblem,
  presetToCron,
  switchPreset,
  type SchedulePreset,
} from "../src/features/manage-routines/schedule.ts"

const SAVED_QUERY_ID = "6f0d9a5e-0d5e-4c39-8f4c-6b1b9f1c2a10"

test("each schedule preset maps to its cron and back", () => {
  const presets: [SchedulePreset, string][] = [
    [{ kind: "minutes", every: 15 }, "*/15 * * * *"],
    [{ kind: "hours", every: 1, minute: 30 }, "30 * * * *"],
    [{ kind: "hours", every: 6, minute: 0 }, "0 */6 * * *"],
    [{ kind: "daily", time: "07:05" }, "5 7 * * *"],
    [{ kind: "weekdays", time: "09:00" }, "0 9 * * 1-5"],
    [{ kind: "weekly", days: [0, 1, 3], time: "18:30" }, "30 18 * * 0,1,3"],
    [{ kind: "monthly", day: 31, time: "08:00" }, "0 8 31 * *"],
  ]
  for (const [preset, cron] of presets) {
    assert.equal(presetToCron(preset), cron)
    assert.deepEqual(cronToPreset(cron), preset, cron)
  }
  // Days are written in order once each, whatever order they were picked in.
  assert.equal(presetToCron({ kind: "weekly", days: [5, 1, 5], time: "09:00" }), "0 9 * * 1,5")
})

test("a cron that is not one of the presets is edited as written", () => {
  const custom = ["*/7 * * * *", "0 9-17 * * 1-5", "0 9 1 1 *", "0 9 * * MON", "0 */5 * * *", "0 9 1 * 1"]
  for (const cron of custom) {
    assert.deepEqual(cronToPreset(cron), { kind: "custom", cron })
  }
  assert.deepEqual(cronToPreset("  0  9 * *   1-5 "), { kind: "weekdays", time: "09:00" })
  assert.equal(presetToCron({ kind: "custom", cron: " 0  9 * * * " }), "0 9 * * *")
})

test("switching presets keeps the time of day, and custom starts from the current cron", () => {
  const weekdays: SchedulePreset = { kind: "weekdays", time: "07:45" }
  assert.deepEqual(switchPreset(weekdays, "monthly"), { kind: "monthly", day: 1, time: "07:45" })
  assert.deepEqual(switchPreset(weekdays, "hours"), { kind: "hours", every: 1, minute: 45 })
  assert.deepEqual(switchPreset(weekdays, "custom"), { kind: "custom", cron: "45 7 * * 1-5" })
  assert.deepEqual(switchPreset({ kind: "minutes", every: 5 }, "daily"), { kind: "daily", time: "09:00" })
  assert.equal(presetProblem({ kind: "weekly", days: [], time: "09:00" }), "Choose at least one day.")
  assert.equal(presetProblem({ kind: "daily", time: "" }), "Choose a time of day.")
  assert.match(presetProblem({ kind: "custom", cron: "0 9 * *" }) ?? "", /five fields/)
  assert.equal(presetProblem({ kind: "monthly", day: 15, time: "23:59" }), null)
})

test("run times read as the routine's time zone shows them", () => {
  assert.equal(formatInZone("2026-11-03T03:30:00.000Z", "Asia/Kolkata"), "Tue 3 Nov 2026, 09:00")
  assert.equal(formatInZone("2026-11-03T03:30:00.000Z", "America/Los_Angeles"), "Mon 2 Nov 2026, 19:30")
  // New York has fallen back by 2 November: 09:00 EST is 14:00 UTC.
  assert.equal(formatInZone("2026-11-02T14:00:00.000Z", "America/New_York"), "Mon 2 Nov 2026, 09:00")
  assert.equal(formatInZone("not a time", "UTC"), "")
  assert.equal(
    scheduleLabel({ schedule: "At 09:00, Monday through Friday", timeZone: "Asia/Kolkata" }),
    "At 09:00, Monday through Friday (Asia/Kolkata)",
  )
  assert.equal(runTime({ scheduledFor: null, createdAt: "2026-11-02T10:00:00Z" }), "2026-11-02T10:00:00Z")
  const slot = "2026-11-02T09:00:00Z"
  assert.equal(runTime({ scheduledFor: slot, createdAt: "2026-11-02T09:00:07Z" }), slot)
})

test("statuses have labels and tones, and only owners or admins manage others' routines", () => {
  assert.deepEqual(runStatus("succeeded"), { label: "Succeeded", tone: "success" })
  assert.deepEqual(runStatus("failed"), { label: "Failed", tone: "danger" })
  assert.deepEqual(runStatus("skipped"), { label: "Skipped", tone: "warning" })
  assert.deepEqual(runStatus("interrupted"), { label: "Interrupted", tone: "warning" })
  assert.equal(runUnderway("queued"), true)
  assert.equal(runUnderway("running"), true)
  assert.equal(runUnderway("cancelled"), false)
  assert.equal(runUnderway(null), false)
  assert.deepEqual(routineState({ enabled: true, pausedReason: null }), { label: "Scheduled", tone: "success" })
  assert.deepEqual(routineState({ enabled: false, pausedReason: "manual" }), {
    label: "Paused",
    tone: "neutral",
  })
  assert.deepEqual(routineState({ enabled: false, pausedReason: "failures" }), {
    label: "Paused after failures",
    tone: "danger",
  })
  const routine = { owner: { id: "u1", name: "Ada" } }
  assert.equal(canManageRoutine(routine, "u1", "member"), true)
  assert.equal(canManageRoutine(routine, "u2", "member"), false)
  assert.equal(canManageRoutine(routine, "u2", "admin"), true)
  assert.equal(canManageRoutine({ owner: null }, undefined, "owner"), true)
})

const since: ParameterDefinition = {
  name: "since",
  label: "Since",
  type: "date",
  default: null,
  required: true,
}
const until: ParameterDefinition = {
  name: "until",
  label: "Until",
  type: "datetime",
  default: { kind: "relative", value: "today" },
  required: false,
}

function draft(changes: Partial<RoutineDraft> = {}): RoutineDraft {
  const started = newRoutineDraft({ savedQueryId: SAVED_QUERY_ID, timeZone: "Asia/Kolkata" })
  return { ...started, name: "Daily", ...changes }
}

test("a saved query routine sends the values its parameters need, and names what is missing", () => {
  const missing = routineInput(draft(), [since, until])
  assert.deepEqual("errors" in missing && missing.errors.parameters, {
    since: "This parameter has no default, so choose a value for the routine's runs.",
  })
  const built = routineInput(
    draft({
      overrides: {
        since: { choice: "days_ago", count: "7", absolute: "" },
        until: { choice: "absolute", count: "", absolute: "2026-12-31T23:30" },
      },
    }),
    [since, until],
  )
  assert.ok("input" in built)
  assert.deepEqual(built.input, {
    name: "Daily",
    description: "",
    cron: "0 9 * * 1-5",
    timeZone: "Asia/Kolkata",
    enabled: true,
    kind: "saved_query",
    savedQueryId: SAVED_QUERY_ID,
    parameters: {
      since: { kind: "relative", value: "days_ago:7" },
      until: { kind: "absolute", value: "2026-12-31T23:30" },
    },
  })
  const noDays: SchedulePreset = { kind: "weekly", days: [], time: "09:00" }
  const bad = routineInput(draft({ name: " ", savedQueryId: "", timeZone: "Mars/Base", schedule: noDays }), [])
  assert.deepEqual("errors" in bad && Object.keys(bad.errors).sort(), [
    "name",
    "savedQueryId",
    "schedule",
    "timeZone",
  ])
  // An optional parameter can be left without a value.
  const overrides: RoutineDraft["overrides"] = {
    since: { choice: "yesterday", count: "", absolute: "" },
    until: { choice: "none", count: "", absolute: "" },
  }
  const empty = routineInput(draft({ overrides }), [since, until])
  assert.deepEqual("input" in empty && empty.input.kind === "saved_query" && empty.input.parameters, {
    since: { kind: "relative", value: "yesterday" },
    until: null,
  })
})

test("a question routine needs its question and keeps its sources", () => {
  assert.deepEqual(routineInput(draft({ kind: "question" }), null), {
    errors: { question: "Write the question to ask." },
  })
  const question = draft({ kind: "question", question: " Open tickets? ", connectionIds: ["c1"] })
  const built = routineInput(question, null)
  assert.ok("input" in built && built.input.kind === "question")
  assert.equal(built.input.question, "Open tickets?")
  assert.deepEqual(built.input.connectionIds, ["c1"])
})

const stored: RoutineDetail = {
  id: "r1",
  name: "Daily",
  description: "",
  kind: "saved_query",
  savedQuery: { state: "available", id: SAVED_QUERY_ID, name: "Orders since" },
  parameters: { since: { kind: "relative", value: "days_ago:7" }, until: "2026-12-31" },
  question: null,
  connectionIds: [],
  cron: "0 9 * * 1-5",
  timeZone: "Asia/Kolkata",
  schedule: "At 09:00, Monday through Friday",
  enabled: true,
  pausedReason: null,
  nextRunAt: "2026-11-03T03:30:00.000Z",
  lastRunAt: null,
  lastStatus: null,
  consecutiveFailures: 0,
  delivery: { channel: "in_app" },
  owner: { id: "u1", name: "Ada" },
  version: 3,
  updatedBy: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  upcoming: [],
  conversationId: null,
}

test("an edit sends only what changed, and a new kind sends its whole target", () => {
  const opened = draftFromRoutine(stored)
  assert.deepEqual(opened.overrides.since, { choice: "days_ago", count: "7", absolute: "" })
  assert.deepEqual(opened.overrides.until, { choice: "absolute", count: "7", absolute: "2026-12-31" })
  assert.deepEqual(opened.schedule, { kind: "weekdays", time: "09:00" })
  const unchanged = routineInput(opened, [since, { ...until, type: "date" }])
  assert.ok("input" in unchanged)
  assert.ok(isEmptyPatch(routinePatch(3, stored, unchanged.input)))
  // A saved query the editor cannot open keeps its stored values.
  const hidden = routineInput(opened, null)
  assert.ok("input" in hidden && isEmptyPatch(routinePatch(3, stored, hidden.input)))

  const daily: SchedulePreset = { kind: "daily", time: "06:00" }
  const rescheduled = routineInput({ ...opened, schedule: daily, enabled: false }, null)
  assert.ok("input" in rescheduled)
  assert.deepEqual(routinePatch(3, stored, rescheduled.input), {
    version: 3,
    cron: "0 6 * * *",
    enabled: false,
  })

  const asQuestion = routineInput({ ...opened, kind: "question", question: "Orders?" }, null)
  assert.ok("input" in asQuestion)
  assert.deepEqual(routinePatch(4, stored, asQuestion.input), {
    version: 4,
    kind: "question",
    question: "Orders?",
    connectionIds: [],
  })
})

test("stored values read back as the form's choices", () => {
  assert.deepEqual(overrideDraft(undefined).choice, "default")
  assert.deepEqual(overrideDraft(null).choice, "none")
  assert.deepEqual(overrideDraft("yesterday").choice, "yesterday")
  assert.deepEqual(overrideDraft("months_ago:2"), { choice: "months_ago", count: "2", absolute: "" })
  assert.deepEqual(overrideDraft({ kind: "absolute", value: "2026-01-01" }), {
    choice: "absolute",
    count: "7",
    absolute: "2026-01-01",
  })
})
