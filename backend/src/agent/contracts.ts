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
  clarificationChars: 500,
  clarificationOptions: 6,
  optionChars: 100,
  answerReplyChars: 2_000,
} as const

/** Files a question may carry: a few small UTF-8 text files the model reads with read_attachment. */
export const ATTACHMENT_LIMITS = {
  perRun: 3,
  bytes: 256 * 1024,
  nameChars: 200,
} as const

/** Accepted file types by extension; anything else is refused. */
export const ATTACHMENT_TYPES = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
} as const

export type AttachmentMediaType = (typeof ATTACHMENT_TYPES)[keyof typeof ATTACHMENT_TYPES]

/** Cycle 12 adds interrupted. */
export type RunStatus = "queued" | "running" | "awaiting_input" | "completed" | "failed" | "cancelled"

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
  /** AGENT_STEP_LIMIT, AGENT_TIMEOUT, AGENT_INPUT_TIMEOUT, AGENT_PROVIDER_ERROR, AGENT_REFUSED, AGENT_OUTPUT_LIMIT, AGENT_INTERRUPTED, INTERNAL_ERROR */
  code: string
  message: string
}

/** A question the model asked the user; the run waits for the answer. */
export interface Clarification {
  id: string
  question: string
  /** Suggested answers, at most AGENT_LIMITS.clarificationOptions; may be empty. */
  options: string[]
  /** False: the answer must be one of the options. */
  allowFreeText: boolean
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
  /** What the run is waiting on while awaiting_input; null otherwise. */
  clarification: Clarification | null
  attachments: AttachmentSummary[]
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
  /** The run waits for the user's answer (status awaiting_input). */
  "clarification.requested": Clarification
  /** The user answered; the run goes on (status running). */
  "clarification.answered": { id: string; answer: string }
  "run.failed": RunError
  "run.cancelled": Record<string, never>
}

export type RunEventType = keyof RunEventData

/** Events are numbered from 1 per run, in the order they happened. */
export type RunEvent = {
  [T in RunEventType]: { seq: number; type: T; data: RunEventData[T]; createdAt: string }
}[RunEventType]

/** Events after which a run's stream ends. */
export const TERMINAL_EVENT_TYPES: readonly RunEventType[] = [
  "answer.completed",
  "run.failed",
  "run.cancelled",
]

export interface AgentRunWithEvents extends AgentRun {
  events: RunEvent[]
}

export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

/** A conversation with its latest runs, oldest first. Finished runs leave out their answer.delta events. */
export interface ConversationWithRuns extends Conversation {
  runs: AgentRunWithEvents[]
}

// Requests ------------------------------------------------------------------

export const agentParamsSchema = z.object({ workspaceId: z.uuid() })
export const runParamsSchema = agentParamsSchema.extend({ runId: z.uuid() })

// Stored as text, which cannot hold NUL characters.
const noNul = (text: string) => !text.includes("\u0000")

/** A file as sent with a question: its name and its bytes in base64. */
const attachmentInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "A file needs a name")
    .max(ATTACHMENT_LIMITS.nameChars, `File names can be at most ${ATTACHMENT_LIMITS.nameChars} characters`)
    .refine(noNul, "File names cannot contain NUL characters"),
  content: z
    .string()
    // Base64 of at most ATTACHMENT_LIMITS.bytes bytes.
    .max(Math.ceil(ATTACHMENT_LIMITS.bytes / 3) * 4, "Each file can be at most 256 KB")
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, "File content must be base64"),
})

export type AttachmentInput = z.infer<typeof attachmentInputSchema>

export const startRunSchema = z.strictObject({
  question: z
    .string()
    .trim()
    .min(1, "Ask a question")
    .max(AGENT_LIMITS.questionChars, `A question can be at most ${AGENT_LIMITS.questionChars} characters`)
    .refine(noNul, "A question cannot contain NUL characters"),
  /** Continue a conversation; omitted starts a new one. */
  conversationId: z.uuid().optional(),
  /** Limit the question to these sources; omitted means every source of the workspace. */
  connectionIds: z
    .array(z.uuid())
    .max(AGENT_LIMITS.connectionsPerRun, `Choose at most ${AGENT_LIMITS.connectionsPerRun} sources`)
    .transform((ids) => [...new Set(ids)])
    .optional(),
  /** Small text or CSV files for the model to read. */
  attachments: z
    .array(attachmentInputSchema)
    .max(ATTACHMENT_LIMITS.perRun, `Attach at most ${ATTACHMENT_LIMITS.perRun} files`)
    .optional(),
})

export type StartRunInput = z.infer<typeof startRunSchema>

export const answerRunSchema = z.strictObject({
  answer: z
    .string()
    .trim()
    .min(1, "Write an answer")
    .max(
      AGENT_LIMITS.answerReplyChars,
      `An answer can be at most ${AGENT_LIMITS.answerReplyChars} characters`,
    )
    .refine(noNul, "An answer cannot contain NUL characters"),
})

export type AnswerRunInput = z.infer<typeof answerRunSchema>

export const conversationParamsSchema = agentParamsSchema.extend({ conversationId: z.uuid() })

export const runEventsQuerySchema = z.strictObject({
  /** Only events with a higher sequence number. */
  after: z.coerce.number().int().min(0).max(1_000_000).optional(),
})

export type RunEventsQuery = z.infer<typeof runEventsQuerySchema>
