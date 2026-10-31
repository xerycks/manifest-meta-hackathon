import type { WorkspaceRole } from "../../app/organization-role.ts"
import type { Routine, RoutineRun, RoutineRunStatus, RoutineTrigger } from "./types.ts"

export type Tone = "neutral" | "success" | "warning" | "danger"

export const RUN_STATUS_LABELS: Record<RoutineRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
}

const RUN_STATUS_TONES: Record<RoutineRunStatus, Tone> = {
  queued: "neutral",
  running: "neutral",
  succeeded: "success",
  failed: "danger",
  skipped: "warning",
  cancelled: "neutral",
  interrupted: "warning",
}

export const TRIGGER_LABELS: Record<RoutineTrigger, string> = {
  schedule: "Scheduled",
  manual: "Run now",
}

export function runStatus(status: RoutineRunStatus): { label: string; tone: Tone } {
  return { label: RUN_STATUS_LABELS[status], tone: RUN_STATUS_TONES[status] }
}

/** A run that has not ended yet. */
export function runUnderway(status: RoutineRunStatus | null): boolean {
  return status === "queued" || status === "running"
}

/** Whether the routine runs on schedule, or why it does not. */
export function routineState(
  routine: Pick<Routine, "enabled" | "pausedReason">,
): { label: string; tone: Tone } {
  if (routine.enabled) return { label: "Scheduled", tone: "success" }
  return routine.pausedReason === "failures"
    ? { label: "Paused after failures", tone: "danger" }
    : { label: "Paused", tone: "neutral" }
}

/** When a run was due (its slot), or when someone started it. */
export function runTime(run: Pick<RoutineRun, "scheduledFor" | "createdAt">): string {
  return run.scheduledFor ?? run.createdAt
}

/** "Tue 3 Nov 2026, 09:00" as the clock reads in the time zone. */
export function formatInZone(iso: string, timeZone: string): string {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return ""
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(time)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? ""
  return `${part("weekday")} ${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")}`
}

/** The schedule and its zone in one phrase: "At 09:00, Monday through Friday (Asia/Kolkata)". */
export function scheduleLabel(routine: Pick<Routine, "schedule" | "timeZone">): string {
  return `${routine.schedule} (${routine.timeZone})`
}

/** Mirrors the server: the routine's owner or a workspace owner or admin manages it. */
export function canManageRoutine(
  routine: Pick<Routine, "owner">,
  userId: string | undefined,
  role: WorkspaceRole | null,
): boolean {
  return role === "owner" || role === "admin" || (userId !== undefined && routine.owner?.id === userId)
}
