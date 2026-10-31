// Mirrors backend/src/routines/schemas.ts; change both together.

import type { Author } from "../manifests/types.ts"
import type { ParameterValue } from "../saved-queries/types.ts"

/** Bounds the backend enforces. */
export const ROUTINE_LIMITS = {
  nameChars: 200,
  descriptionChars: 5_000,
  cronChars: 120,
  perWorkspace: 100,
  failuresBeforePause: 3,
  questionChars: 4_000,
  connectionsPerRoutine: 10,
} as const

export type RoutineKind = "saved_query" | "question"
export type PausedReason = "manual" | "failures"
export type RoutineTrigger = "schedule" | "manual"
export type RoutineRunStatus =
  "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled" | "interrupted"

/** A parameter value for every run: a date, a relative date, or null for none. */
export type RoutineValue = string | ParameterValue | null
export type RoutineValues = Record<string, RoutineValue>

export interface Delivery {
  channel: "in_app"
}

/** The saved query a routine runs, as the viewer may see it. */
export type RoutineSavedQuery =
  | { state: "available"; id: string; name: string }
  | { state: "private"; id: string }
  | { state: "removed" }

export interface Routine {
  id: string
  name: string
  /** Markdown. */
  description: string
  kind: RoutineKind
  /** Null for question routines. */
  savedQuery: RoutineSavedQuery | null
  parameters: RoutineValues
  question: string | null
  /** Empty means every source. */
  connectionIds: string[]
  /** 5-field cron, read in timeZone. */
  cron: string
  timeZone: string
  /** The schedule in plain words, e.g. "At 09:00, Monday through Friday". */
  schedule: string
  enabled: boolean
  pausedReason: PausedReason | null
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: RoutineRunStatus | null
  consecutiveFailures: number
  delivery: Delivery
  /** Runs act as the owner. */
  owner: Author | null
  version: number
  updatedBy: Author | null
  createdAt: string
  updatedAt: string
}

export interface RoutineDetail extends Routine {
  /** The next few scheduled runs; none while paused. */
  upcoming: string[]
  /** A question routine's conversation, for its owner only. */
  conversationId: string | null
}

export interface RoutineList {
  routines: Routine[]
}

/** Slots skipped while no backend ran; only the latest due one ran. */
export interface MissedSlots {
  count: number
  more: boolean
  first: string
  last: string
}

export interface RoutineRun {
  id: string
  routineId: string
  trigger: RoutineTrigger
  /** The schedule slot; null for manual runs. */
  scheduledFor: string | null
  status: RoutineRunStatus
  /** The saved query's run, while history keeps it. */
  execution: { id: string; connectionId: string } | null
  agentRunId: string | null
  /** The question's conversation, for the routine's owner only. */
  conversationId: string | null
  error: { code: string; message: string } | null
  missed: MissedSlots | null
  requestedBy: Author | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface RoutineRunPage {
  runs: RoutineRun[]
  nextOffset: number | null
}

export interface SchedulePreview {
  cron: string
  timeZone: string
  schedule: string
  upcoming: string[]
}

interface RoutineSettings {
  name: string
  description: string
  cron: string
  timeZone: string
  enabled: boolean
}

export type CreateRoutineInput = RoutineSettings &
  (
    | { kind: "saved_query"; savedQueryId: string; parameters: RoutineValues }
    | { kind: "question"; question: string; connectionIds: string[] }
  )

export interface UpdateRoutineInput {
  version: number
  name?: string
  description?: string
  kind?: RoutineKind
  savedQueryId?: string
  parameters?: RoutineValues
  question?: string
  connectionIds?: string[]
  cron?: string
  timeZone?: string
  enabled?: boolean
}
