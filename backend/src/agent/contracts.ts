import { z } from "zod"

import type { Cell, ReadQuery, ResultColumn } from "../queries/schemas.js"

// Runs, answers, and events as the API returns them. The frontend mirrors
// these in src/entities/agent/types.ts; change both together.

export const AGENT_LIMITS = {
  questionChars: 4_000,
  connectionsPerRun: 10,
  /** A conversation's title is its first question, trimmed. */
  titleChars: 120,
  answerChars: 8_000,
  evidenceItems: 20,
  missingItems: 10,
  /** Rows of each cited execution stored with the answer; the execution record keeps its snapshot. */
  evidenceRows: 20,
} as const

/** Cycle 11 adds awaiting_input and cycle 12 interrupted. */
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running"]

export type AgentToolName =
  "list_sources" | "search_metadata" | "describe_object" | "read_knowledge" | "run_query" | "submit_answer"

/** A query result an answer cites, with the first rows of its result. */
export interface EvidenceItem {
  executionId: string
  connectionId: string
  /** What this execution supports, in the model's words, e.g. "Monthly net revenue". */
  label: string
  query: ReadQuery
  columns: ResultColumn[]
  /**
   * At most AGENT_LIMITS.evidenceRows rows (and about 50,000 characters of JSON);
   * open the execution for its stored snapshot.
   */
  rows: Cell[][]
  /** Rows the query returned. */
  rowCount: number
  /** The query had more rows than its row or byte limit allowed. */
  truncated: boolean
}

export interface AgentAnswer {
  markdown: string
  /** "partial" when some of the question could not be answered from the data. */
  status: "complete" | "partial"
  /** What the data could not tell, in plain words. */
  missing: string[]
  evidence: EvidenceItem[]
}

/** A safe, user-facing failure written by Manifest. */
export interface RunError {
  /** AGENT_STEP_LIMIT, AGENT_TIMEOUT, AGENT_PROVIDER_ERROR, AGENT_REFUSED, AGENT_OUTPUT_LIMIT, AGENT_INTERRUPTED, INTERNAL_ERROR */
  code: string
  message: string
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface AgentRun {
  id: string
  conversationId: string
  userId: string
  question: string
  /** The sources the question may use; empty means every source of the workspace. */
  connectionIds: string[]
  status: RunStatus
  provider: string
  model: string
  answer: AgentAnswer | null
  error: RunError | null
  usage: TokenUsage
  /** Model turns taken. */
  steps: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface RunEventData {
  "run.started": { provider: string; model: string }
  "tool.started": { callId: string; tool: string; summary: string }
  "tool.finished": {
    callId: string
    tool: string
    ok: boolean
    summary: string
    /** The query execution a run_query call recorded, whether it succeeded or not. */
    executionId?: string
  }
  /** Text the model streamed while working, in order. */
  "answer.delta": { text: string }
  "answer.completed": { answer: AgentAnswer }
  "run.failed": RunError
  "run.cancelled": Record<string, never>
}

export type RunEventType = keyof RunEventData

/** Events are numbered from 1 per run, in the order they happened. */
export type RunEvent = {
  [T in RunEventType]: { seq: number; type: T; data: RunEventData[T]; createdAt: string }
}[RunEventType]

export interface AgentRunWithEvents extends AgentRun {
  events: RunEvent[]
}

// Requests ------------------------------------------------------------------

export const agentParamsSchema = z.object({ workspaceId: z.uuid() })
export const runParamsSchema = agentParamsSchema.extend({ runId: z.uuid() })

export const startRunSchema = z.strictObject({
  question: z
    .string()
    .trim()
    .min(1, "Ask a question")
    .max(AGENT_LIMITS.questionChars, `A question can be at most ${AGENT_LIMITS.questionChars} characters`)
    // Stored as text, which cannot hold NUL characters.
    .refine((question) => !question.includes("\u0000"), "A question cannot contain NUL characters"),
  /** Continue a conversation; omitted starts a new one. */
  conversationId: z.uuid().optional(),
  /** Limit the question to these sources; omitted means every source of the workspace. */
  connectionIds: z
    .array(z.uuid())
    .max(AGENT_LIMITS.connectionsPerRun, `Choose at most ${AGENT_LIMITS.connectionsPerRun} sources`)
    .transform((ids) => [...new Set(ids)])
    .optional(),
})

export type StartRunInput = z.infer<typeof startRunSchema>

export const runEventsQuerySchema = z.strictObject({
  /** Only events with a higher sequence number. */
  after: z.coerce.number().int().min(0).max(1_000_000).optional(),
})

export type RunEventsQuery = z.infer<typeof runEventsQuerySchema>
