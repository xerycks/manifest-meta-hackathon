// Mirrors backend/src/agent/contracts.ts: runs, structured answers with
// evidence, and the ordered events of a run. Change both together.

import type { Cell, ReadQuery, ResultColumn } from "../queries/types.ts"

export const AGENT_LIMITS = {
  questionChars: 4_000,
  connectionsPerRun: 10,
  answerChars: 8_000,
  evidenceRows: 20,
} as const

/** Cycle 11 adds awaiting_input and cycle 12 interrupted. */
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running"]

export type AgentToolName =
  "list_sources" | "search_metadata" | "describe_object" | "read_knowledge" | "run_query" | "submit_answer"

/** A query result an answer cites, with the first rows of its result. */
export interface EvidenceItem {
  /** Open the full stored result at GET …/connections/:connectionId/queries/:executionId. */
  executionId: string
  connectionId: string
  /** What this execution supports, e.g. "Monthly net revenue". */
  label: string
  query: ReadQuery
  columns: ResultColumn[]
  /** At most AGENT_LIMITS.evidenceRows rows (and about 50,000 characters of JSON). */
  rows: Cell[][]
  rowCount: number
  truncated: boolean
}

export interface AgentAnswer {
  /** Markdown. */
  markdown: string
  /** "partial" when some of the question could not be answered from the data. */
  status: "complete" | "partial"
  /** What the data could not tell. */
  missing: string[]
  evidence: EvidenceItem[]
}

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
  /** Empty means every source of the workspace. */
  connectionIds: string[]
  status: RunStatus
  /** e.g. "anthropic", or "scripted" for the demo model. */
  provider: string
  /** e.g. "claude-opus-5-5", or "demo (synthetic)". */
  model: string
  answer: AgentAnswer | null
  error: RunError | null
  usage: TokenUsage
  steps: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface RunEventData {
  "run.started": { provider: string; model: string }
  "tool.started": { callId: string; tool: string; summary: string }
  "tool.finished": { callId: string; tool: string; ok: boolean; summary: string; executionId?: string }
  /** Text the model streamed while working, in order. */
  "answer.delta": { text: string }
  "answer.completed": { answer: AgentAnswer }
  "run.failed": RunError
  "run.cancelled": Record<string, never>
}

export type RunEventType = keyof RunEventData

/** Numbered from 1 per run, in the order they happened. */
export type RunEvent = {
  [T in RunEventType]: { seq: number; type: T; data: RunEventData[T]; createdAt: string }
}[RunEventType]

export interface AgentRunWithEvents extends AgentRun {
  events: RunEvent[]
}

/** POST /workspaces/:workspaceId/agent/runs → 202 AgentRun. */
export interface StartRunInput {
  question: string
  conversationId?: string
  connectionIds?: string[]
}
