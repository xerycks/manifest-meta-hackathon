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
  /** Conversations one page of the list returns, by default and at most. */
  conversationPage: 20,
  conversationPageMax: 50,
  /** Runs a conversation read returns, the latest ones before the cursor. */
  conversationRuns: 50,
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
 * How an interrupted run is recovered. retry: it only read, so asking again
 * (POST /runs/:runId/retry) is safe. reconcile: it started a tool with effects
 * outside the run, whose outcome must be checked before anything is repeated.
 */
export type RecoveryDisposition = "retry" | "reconcile"

/**
 * Tools whose calls change something outside the run. Every tool so far only
 * reads; a run interrupted after starting one of these must be reconciled.
 */
export const TOOLS_WITH_EFFECTS: readonly AgentToolName[] = []

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
  /** When the run stops waiting (AGENT_INPUT_TIMEOUT). */
  expiresAt: string
}

/** What the model asks the user with ask_user. */
export type ClarificationRequest = Pick<Clarification, "question" | "options" | "allowFreeText">

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
  /** A restart stopped the run (status interrupted). */
  "run.interrupted": RunError & { disposition: RecoveryDisposition }
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
  "run.interrupted",
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

/** A conversation in the list, with how its latest question stands. */
export interface ConversationSummary extends Conversation {
  /** The latest question's status; null for a conversation without questions. */
  status: RunStatus | null
  /** The latest question waits for the user's answer to a clarification. */
  pendingClarification: boolean
}

/** One page of the user's conversations, newest activity first. */
export interface ConversationPage {
  conversations: ConversationSummary[]
  /** Pass as ?cursor= for the next page; null on the last one. */
  nextCursor: string | null
}

/**
 * A conversation with its latest runs (before ?before= when given), oldest
 * first. Finished runs leave out their answer.delta events: their answer or
 * error supersedes the text streamed while working.
 */
export interface ConversationWithRuns extends Conversation {
  runs: AgentRunWithEvents[]
  /** Older runs exist: read them with ?before=<the first run's id>. */
  hasEarlier: boolean
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
  /**
   * Chosen by the client for each question, unique per user: sending the same
   * one again (after a network failure) returns the run it already started.
   */
  mutationId: z.uuid().optional(),
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

/** Where a page of the conversation list starts: after this activity time and id. */
export interface ConversationCursor {
  /** updated_at in UTC with microseconds, so no conversation is skipped or repeated. */
  activity: string
  id: string
}

const cursorSchema = z.tuple([z.iso.datetime({ precision: 6 }), z.uuid()])

export function encodeCursor(cursor: ConversationCursor): string {
  return Buffer.from(JSON.stringify([cursor.activity, cursor.id])).toString("base64url")
}

function decodeCursor(text: string): ConversationCursor | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(text, "base64url").toString("utf8")))
    return parsed.success ? { activity: parsed.data[0], id: parsed.data[1] } : null
  } catch {
    return null
  }
}

export const listConversationsQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AGENT_LIMITS.conversationPageMax)
    .default(AGENT_LIMITS.conversationPage),
  cursor: z
    .string()
    .max(200)
    .transform((text, context) => {
      const cursor = decodeCursor(text)
      if (!cursor) {
        context.addIssue({ code: "custom", message: "Not a cursor this list returned" })
        return z.NEVER
      }
      return cursor
    })
    .optional(),
})

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>

export const conversationQuerySchema = z.strictObject({
  /** Only runs older than this run of the conversation. */
  before: z.uuid().optional(),
})

export type ConversationQuery = z.infer<typeof conversationQuerySchema>

export const renameConversationSchema = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1, "Give the conversation a title")
    .max(AGENT_LIMITS.titleChars, `A title can be at most ${AGENT_LIMITS.titleChars} characters`)
    .refine(noNul, "A title cannot contain NUL characters"),
})

export type RenameConversationInput = z.infer<typeof renameConversationSchema>

export const runEventsQuerySchema = z.strictObject({
  /** Only events with a higher sequence number. */
  after: z.coerce.number().int().min(0).max(1_000_000).optional(),
})

export type RunEventsQuery = z.infer<typeof runEventsQuerySchema>
