import { z } from "zod"

import { AGENT_LIMITS, startRunSchema } from "../agent/contracts.js"
import type { Author } from "../auth/repository.js"
import type { RunValues } from "../saved-queries/parameters.js"
import { runValuesSchema } from "../saved-queries/schemas.js"
import { timeZoneSchema } from "../workspaces/time-zone.js"
import { normalizeCron, type MissedSlots } from "./schedule.js"

export const ROUTINE_LIMITS = {
  nameChars: 200,
  descriptionChars: 5_000,
  cronChars: 120,
  perWorkspace: 100,
  /** Failed runs in a row after which a routine pauses itself. */
  failuresBeforePause: 3,
  /** Upcoming runs a routine and a schedule preview show. */
  upcoming: 3,
  /** Runs one page of a routine's history returns, by default and at most. */
  runsPage: 20,
  runsPageMax: 100,
  /** Finished runs kept per routine; older ones are pruned. */
  runsKept: 1_000,
  /** A routine's conversation title is "Routine: <name>", trimmed to the conversation title limit. */
  titleChars: AGENT_LIMITS.titleChars,
} as const

export type RoutineKind = "saved_query" | "question"
export type PausedReason = "manual" | "failures"
export type RoutineTrigger = "schedule" | "manual"

export const ROUTINE_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
] as const

export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number]

// Stored as text, which cannot hold NUL characters.
const noNul = (text: string) => !text.includes("\u0000")

const nameSchema = z
  .string()
  .trim()
  .min(1, "Give the routine a name")
  .max(ROUTINE_LIMITS.nameChars, `A name can be at most ${ROUTINE_LIMITS.nameChars} characters`)
  .refine(noNul, "A name cannot contain NUL characters")
const descriptionSchema = z
  .string()
  .max(
    ROUTINE_LIMITS.descriptionChars,
    `The description can be at most ${ROUTINE_LIMITS.descriptionChars.toLocaleString("en-US")} characters`,
  )
  .refine(noNul, "The description cannot contain NUL characters")
  .transform((value) => value.trimEnd())
/** Checked further (fields, interval) by the service, which knows the minimum interval. */
const cronSchema = z
  .string()
  .trim()
  .min(1, "Choose a schedule")
  .max(ROUTINE_LIMITS.cronChars, `A schedule can be at most ${ROUTINE_LIMITS.cronChars} characters`)
  .transform(normalizeCron)
const connectionIdsSchema = z
  .array(z.uuid())
  .max(AGENT_LIMITS.connectionsPerRun, `Choose at most ${AGENT_LIMITS.connectionsPerRun} sources`)
  .transform((ids) => [...new Set(ids)])

/** Where a routine's results go. Only in the app for now; other channels attach later. */
export const deliverySchema = z.strictObject({ channel: z.literal("in_app") })

export type Delivery = z.infer<typeof deliverySchema>

const savedQueryTarget = {
  kind: z.literal("saved_query"),
  savedQueryId: z.uuid("Choose a saved query"),
  /** Values by parameter name for every run, in place of the saved query's defaults. */
  parameters: runValuesSchema.default({}),
}
const questionTarget = {
  kind: z.literal("question"),
  question: startRunSchema.shape.question,
  connectionIds: connectionIdsSchema.default([]),
}

/** What a routine runs: a saved query (with parameter values) or a question for the agent. */
export const routineTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject(savedQueryTarget),
  z.strictObject(questionTarget),
])

export type RoutineTarget = z.infer<typeof routineTargetSchema>

const settings = {
  name: nameSchema,
  description: descriptionSchema.default(""),
  cron: cronSchema,
  /** Defaults to the workspace time zone. */
  timeZone: timeZoneSchema.optional(),
  enabled: z.boolean().default(true),
  delivery: deliverySchema.default({ channel: "in_app" }),
}

export const createRoutineSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...settings, ...savedQueryTarget }),
  z.strictObject({ ...settings, ...questionTarget }),
])

export type CreateRoutineInput = z.infer<typeof createRoutineSchema>

/** Target fields are merged with the stored ones and checked whole (see routineTargetSchema). */
export const updateRoutineSchema = z
  .strictObject({
    version: z.number().int().min(1).max(2_147_483_647),
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    kind: z.enum(["saved_query", "question"]).optional(),
    savedQueryId: z.uuid().optional(),
    parameters: runValuesSchema.optional(),
    question: startRunSchema.shape.question.optional(),
    connectionIds: connectionIdsSchema.optional(),
    cron: cronSchema.optional(),
    timeZone: timeZoneSchema.optional(),
    enabled: z.boolean().optional(),
    delivery: deliverySchema.optional(),
  })
  .refine((input) => Object.keys(input).some((key) => key !== "version"), "Change at least one field")

export type UpdateRoutineInput = z.infer<typeof updateRoutineSchema>

export const runRoutineSchema = z.strictObject({
  /** Chosen by the client for each click: sending it again returns the run it started. */
  mutationId: z.uuid(),
})

export type RunRoutineInput = z.infer<typeof runRoutineSchema>

export const workspaceParamsSchema = z.object({ workspaceId: z.uuid() })
export const routineParamsSchema = workspaceParamsSchema.extend({ routineId: z.uuid() })

export const listRunsSchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ROUTINE_LIMITS.runsPageMax)
    .default(ROUTINE_LIMITS.runsPage),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})

export type ListRunsQuery = z.infer<typeof listRunsSchema>

export const schedulePreviewSchema = z.strictObject({
  cron: cronSchema,
  timeZone: timeZoneSchema.optional(),
})

export type SchedulePreviewQuery = z.infer<typeof schedulePreviewSchema>

// Responses --------------------------------------------------------------------

/**
 * The saved query a routine runs, as the viewer may see it: its name, or
 * only that it is private to someone else, or that it was deleted.
 */
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
  /** Parameter values for saved query routines; {} otherwise. */
  parameters: RunValues
  question: string | null
  /** The sources a question may use; empty means every source. */
  connectionIds: string[]
  /** 5-field cron, read in timeZone. */
  cron: string
  timeZone: string
  /** The schedule in plain words, e.g. "At 09:00, Monday through Friday". */
  schedule: string
  enabled: boolean
  /** Why a routine is paused: someone paused it, or it failed too often in a row. */
  pausedReason: PausedReason | null
  /** The next scheduled run; null while paused. */
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: RoutineRunStatus | null
  consecutiveFailures: number
  delivery: Delivery
  /** Runs act as the owner; null once that user no longer exists. */
  owner: Author | null
  version: number
  updatedBy: Author | null
  createdAt: string
  updatedAt: string
}

export interface RoutineDetail extends Routine {
  /** The next few scheduled runs (none while paused). */
  upcoming: string[]
  /** A question routine's conversation, for its owner (conversations are private); null otherwise. */
  conversationId: string | null
}

export interface RoutineList {
  routines: Routine[]
}

/** A safe, user-facing reason written by Manifest. */
export interface RoutineRunError {
  code: string
  message: string
}

export interface RoutineRun {
  id: string
  routineId: string
  trigger: RoutineTrigger
  /** The schedule slot; null for manual runs. */
  scheduledFor: string | null
  status: RoutineRunStatus
  /** The saved query's execution, while history keeps it. */
  execution: { id: string; connectionId: string } | null
  agentRunId: string | null
  /** The question's conversation, for the routine's owner only. */
  conversationId: string | null
  error: RoutineRunError | null
  /** On the skipped run that notes slots missed while no backend ran. */
  missed: MissedSlots | null
  /** Who started a manual run. */
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
