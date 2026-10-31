// Mirrors backend/src/agent/contracts.ts: runs, structured answers with
// evidence, and the ordered events of a run. Change both together.

import type { Cell, ReadQuery, ResultColumn } from "../queries/types.ts"

export const AGENT_LIMITS = {
  questionChars: 4_000,
  connectionsPerRun: 10,
  answerChars: 8_000,
  evidenceRows: 20,
  answerReplyChars: 2_000,
  titleChars: 120,
} as const

/** Files a question may carry: a few small UTF-8 text files the model reads. */
export const ATTACHMENT_LIMITS = {
  perRun: 3,
  bytes: 256 * 1024,
  nameChars: 200,
} as const

/** Accepted file types by extension. */
export const ATTACHMENT_TYPES = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
} as const

export type AttachmentMediaType = (typeof ATTACHMENT_TYPES)[keyof typeof ATTACHMENT_TYPES]

/** interrupted: a restart stopped the run; its disposition says how to recover it. */
export type RunStatus =
  "queued" | "running" | "awaiting_input" | "completed" | "failed" | "cancelled" | "interrupted"

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "awaiting_input"]

export type AgentToolName =
  | "list_sources"
  | "search_metadata"
  | "describe_object"
  | "read_knowledge"
  | "run_query"
  | "read_attachment"
  | "ask_user"
  | "submit_answer"

/**
 * How an interrupted run is recovered. retry: it only read, so it can be
 * asked again (POST …/runs/:runId/retry). reconcile: it started a tool with
 * effects, whose outcome must be checked before anything is repeated.
 */
export type RecoveryDisposition = "retry" | "reconcile"

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
  /** AGENT_STEP_LIMIT, AGENT_TIMEOUT, AGENT_INPUT_TIMEOUT, AGENT_PROVIDER_ERROR, AGENT_REFUSED, AGENT_OUTPUT_LIMIT, AGENT_INTERRUPTED, INTERNAL_ERROR */
  code: string
  message: string
}

/** A question the model asked the user; the run waits for the answer. */
export interface Clarification {
  id: string
  question: string
  /** Suggested answers; may be empty. */
  options: string[]
  /** False: the answer must be one of the options. */
  allowFreeText: boolean
  /** When the run stops waiting for the answer. */
  expiresAt: string
}

/** A file sent with a question, without its content. */
export interface AttachmentSummary {
  id: string
  name: string
  mediaType: AttachmentMediaType
  sizeBytes: number
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
  /** What the run is waiting on while awaiting_input; null otherwise. */
  clarification: Clarification | null
  attachments: AttachmentSummary[]
  /** Set when interrupted: how to recover the run. */
  disposition: RecoveryDisposition | null
  /** The interrupted run this one retries. */
  retryOf: string | null
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
  /** The run waits for the user's answer (status awaiting_input). */
  "clarification.requested": Clarification
  /** The user answered; the run goes on. */
  "clarification.answered": { id: string; answer: string }
  "run.failed": RunError
  "run.cancelled": Record<string, never>
  /** A restart stopped the run (status interrupted). */
  "run.interrupted": RunError & { disposition: RecoveryDisposition }
}

export type RunEventType = keyof RunEventData

/** Numbered from 1 per run, in the order they happened. */
export type RunEvent = {
  [T in RunEventType]: { seq: number; type: T; data: RunEventData[T]; createdAt: string }
}[RunEventType]

/** Events after which a run's stream ends. */
export const TERMINAL_EVENT_TYPES: readonly RunEventType[] = [
  "answer.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
]

export interface AgentRunWithEvents extends AgentRun {
  events: RunEvent[]
}

export interface Conversation {
  id: string
  title: string
  createdAt: string
  /** When the latest question was asked. */
  updatedAt: string
}

/** A conversation in the list, with how its latest question stands. */
export interface ConversationSummary extends Conversation {
  /** Null for a conversation without questions. */
  status: RunStatus | null
  /** The latest question waits for the user's answer. */
  pendingClarification: boolean
  /** The routine that asks its questions here, while it exists. */
  routine: { id: string; name: string } | null
}

/** GET …/agent/conversations?limit=&cursor=: newest activity first. */
export interface ConversationPage {
  conversations: ConversationSummary[]
  nextCursor: string | null
}

/**
 * GET …/agent/conversations/:conversationId?before=: the latest runs (before
 * that run), oldest first; finished runs leave out answer.delta.
 */
export interface ConversationWithRuns extends Conversation {
  runs: AgentRunWithEvents[]
  /** Older runs exist: read them with ?before=<the first run's id>. */
  hasEarlier: boolean
}

/** A file as sent with a question: its name and its bytes in base64. */
export interface AttachmentInput {
  name: string
  content: string
}

/** POST /workspaces/:workspaceId/agent/runs → 202 AgentRun (200 when mutationId was sent before). */
export interface StartRunInput {
  question: string
  conversationId?: string
  connectionIds?: string[]
  attachments?: AttachmentInput[]
  /** New for each question; sending it again returns the run it started. */
  mutationId?: string
}
