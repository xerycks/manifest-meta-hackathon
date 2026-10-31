import type { Pool, PoolClient } from "pg"

import { jsonbText } from "../shared/postgres/json.js"
import type { DecodedAttachment } from "./attachments.js"
import {
  encodeCursor,
  TOOLS_WITH_EFFECTS,
  type AgentAnswer,
  type AgentRun,
  type AgentRunWithEvents,
  type AttachmentMediaType,
  type AttachmentSummary,
  type Clarification,
  type Conversation,
  type ConversationCursor,
  type ConversationPage,
  type RecoveryDisposition,
  type RunError,
  type RunEvent,
  type RunEventData,
  type RunEventType,
  type RunStatus,
  type TokenUsage,
} from "./contracts.js"
import type { PendingQuestion } from "./harness.js"
import type { ModelMessage } from "./provider.js"

/** An earlier question of a conversation and how it ended, bounded for model context. */
export interface PriorTurn {
  question: string
  status: RunStatus
  answer: string | null
  error: string | null
}

export interface RunOutcome {
  status: "completed" | "failed" | "cancelled" | "interrupted"
  answer: AgentAnswer | null
  error: RunError | null
  usage: TokenUsage
  steps: number
  transcript: ModelMessage[]
}

/** What a run waiting for the user needs to go on, also after a restart. */
export interface RunCheckpoint {
  /** The system prompt the run was given; replayed unchanged. */
  system: string
  /** The model conversation up to the turn that asked, exactly as sent. */
  messages: ModelMessage[]
  question: PendingQuestion
  steps: number
  usage: TokenUsage
  /** The run's succeeded queries, which its answer may cite. */
  executionIds: string[]
  /** Milliseconds of the run's own time limit left. */
  runMsLeft: number
}

export interface NewRun {
  id: string
  workspaceId: string
  conversationId: string
  /** Starts the conversation with this title; omitted: the conversation exists. */
  newConversation?: { title: string }
  userId: string
  question: string
  connectionIds: string[]
  provider: string
  model: string
  attachments?: DecodedAttachment[]
  mutationId?: string
  /** The interrupted run this one retries; its files are copied. */
  retryOf?: string
}

interface RunRow {
  id: string
  conversation_id: string
  user_id: string
  question: string
  connection_ids: string[]
  status: RunStatus
  provider: string
  model: string
  answer: AgentAnswer | null
  error: RunError | null
  usage: TokenUsage
  steps: number
  clarification: Clarification | null
  disposition: RecoveryDisposition | null
  retry_of: string | null
  attachments?: AttachmentSummary[]
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

interface EventRow {
  seq: number
  type: RunEventType
  data: RunEventData[RunEventType]
  created_at: Date
}

interface ConversationRow {
  id: string
  title: string
  created_at: Date
  updated_at: Date
}

const RUN_COLUMNS = `id, conversation_id, user_id, question, connection_ids, status, provider, model,
  answer, error, usage, steps, clarification, disposition, retry_of, created_at, started_at, finished_at`

/** RUN_COLUMNS of agent_runs `r` with the run's attachments (no content), oldest first. */
const RUN_WITH_ATTACHMENTS = `r.id, r.conversation_id, r.user_id, r.question, r.connection_ids, r.status,
  r.provider, r.model, r.answer, r.error, r.usage, r.steps, r.clarification, r.disposition, r.retry_of,
  r.created_at, r.started_at, r.finished_at,
  (SELECT coalesce(json_agg(json_build_object('id', a.id, 'name', a.name, 'mediaType', a.media_type,
            'sizeBytes', a.size_bytes) ORDER BY a.position), '[]')
     FROM agent_run_attachments a WHERE a.run_id = r.id) AS attachments`

const ACTIVE = "('queued', 'running', 'awaiting_input')"

/** Characters of an earlier answer given to the model as context. */
const PRIOR_ANSWER_CHARS = 4_000
/** A checkpoint larger than this is not stored: the run can wait, but not across a restart. */
const CHECKPOINT_BYTES = 2_500_000

/** How an interrupted agent_runs row is recovered, from the tools its run started. */
const DISPOSITION = `CASE WHEN EXISTS (
    SELECT 1 FROM agent_run_events e
     WHERE e.run_id = agent_runs.id AND e.type = 'tool.started'
       AND e.data ->> 'tool' = ANY (ARRAY[${TOOLS_WITH_EFFECTS.map((name) => `'${name}'`).join(", ")}]::text[])
  ) THEN 'reconcile' ELSE 'retry' END`

/** The error of a run a restart (or shutdown) interrupted. */
export const INTERRUPTED: RunError = {
  code: "AGENT_INTERRUPTED",
  message: "A restart of the backend interrupted this question before it was answered.",
}

function toRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    question: row.question,
    connectionIds: row.connection_ids,
    status: row.status,
    provider: row.provider,
    model: row.model,
    answer: row.answer,
    error: row.error,
    usage: row.usage,
    steps: row.steps,
    clarification: row.clarification,
    attachments: row.attachments ?? [],
    disposition: row.disposition,
    retryOf: row.retry_of,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  }
}

function toEvent(row: EventRow): RunEvent {
  return { seq: row.seq, type: row.type, data: row.data, createdAt: row.created_at.toISOString() } as RunEvent
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

/** The event that records how a run ended. */
function terminalEvent(outcome: RunOutcome): { type: RunEventType; data: unknown } {
  switch (outcome.status) {
    case "completed":
      return { type: "answer.completed", data: { answer: outcome.answer } }
    case "failed":
      return { type: "run.failed", data: outcome.error }
    case "cancelled":
      return { type: "run.cancelled", data: {} }
    case "interrupted":
      // The disposition is added when it is recorded.
      return { type: "run.interrupted", data: outcome.error }
  }
}

/**
 * A change to an agent_runs row together with the event that describes it: one
 * statement takes the run's next sequence number and records the event, so
 * the change and its event land together (or not at all) and numbers have no
 * gaps. The row lock orders concurrent writers.
 */
interface EventWrite {
  type: RunEventType
  data: unknown
  /** Extra SET assignments; parameters from $5 on are `params`. */
  set?: string
  /** Which state the run must be in for the change to apply. */
  when: string
  params?: unknown[]
  /** Adds the recovered row's disposition to the event data. */
  withDisposition?: boolean
}

function eventStatement(write: EventWrite): string {
  return `WITH run AS (
     UPDATE agent_runs SET ${write.set ? `${write.set}, ` : ""}last_seq = last_seq + 1
      WHERE workspace_id = $1 AND id = $2 AND ${write.when}
      RETURNING id, last_seq, disposition
   )
   INSERT INTO agent_run_events (run_id, seq, type, data)
   SELECT id, last_seq, $3,
          ${write.withDisposition ? "$4::jsonb || jsonb_build_object('disposition', disposition)" : "$4::jsonb"}
     FROM run
   RETURNING seq, type, data, created_at`
}

/**
 * Conversations, agent runs, their events, and the files sent with them. Every query is scoped by
 * workspace_id, and reads on behalf of a user also by user_id: conversations
 * and runs are private to the user who created them.
 */
export class AgentRunsRepository {
  constructor(private readonly pool: Pool) {}

  async getConversation(workspaceId: string, userId: string, id: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query<ConversationRow>(
      `SELECT id, title, created_at, updated_at FROM conversations
        WHERE workspace_id = $1 AND user_id = $2 AND id = $3`,
      [workspaceId, userId, id],
    )
    return rows[0] ? toConversation(rows[0]) : null
  }

  /** The user's conversations, newest activity (question asked) first, after `cursor`. */
  async listConversations(
    workspaceId: string,
    userId: string,
    page: { limit: number; cursor?: ConversationCursor | undefined },
  ): Promise<ConversationPage> {
    const { rows } = await this.pool.query<
      ConversationRow & { activity: string; status: RunStatus | null; pending_clarification: boolean }
    >(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity,
              latest.status, coalesce(latest.clarification IS NOT NULL, false) AS pending_clarification
         FROM conversations c
         LEFT JOIN LATERAL (
           SELECT r.status, r.clarification FROM agent_runs r
            WHERE r.workspace_id = c.workspace_id AND r.conversation_id = c.id
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT 1
         ) latest ON true
        WHERE c.workspace_id = $1 AND c.user_id = $2
          AND ($3::timestamptz IS NULL OR (c.updated_at, c.id) < ($3::timestamptz, $4::uuid))
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT $5`,
      [workspaceId, userId, page.cursor?.activity ?? null, page.cursor?.id ?? null, page.limit + 1],
    )
    const shown = rows.slice(0, page.limit)
    const last = shown.at(-1)
    return {
      conversations: shown.map((row) => ({
        ...toConversation(row),
        status: row.status,
        pendingClarification: row.pending_clarification,
      })),
      nextCursor:
        rows.length > page.limit && last ? encodeCursor({ activity: last.activity, id: last.id }) : null,
    }
  }

  async renameConversation(
    workspaceId: string,
    userId: string,
    id: string,
    title: string,
  ): Promise<Conversation | null> {
    const { rows } = await this.pool.query<ConversationRow>(
      `UPDATE conversations SET title = $4
        WHERE workspace_id = $1 AND user_id = $2 AND id = $3
        RETURNING id, title, created_at, updated_at`,
      [workspaceId, userId, id, title],
    )
    return rows[0] ? toConversation(rows[0]) : null
  }

  /**
   * Deletes the user's conversation with its runs, events, and files. The
   * executions its answers cited are no longer pinned, so history pruning can
   * remove them. False when there is no such conversation.
   */
  async deleteConversation(workspaceId: string, userId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `WITH cited AS (
         SELECT (item ->> 'executionId')::uuid AS id
           FROM agent_runs r, jsonb_array_elements(r.answer -> 'evidence') item
          WHERE r.workspace_id = $1 AND r.user_id = $2 AND r.conversation_id = $3 AND r.answer IS NOT NULL
       ), unpinned AS (
         UPDATE query_executions SET pinned = false
          WHERE workspace_id = $1 AND id IN (SELECT id FROM cited)
       )
       DELETE FROM conversations WHERE workspace_id = $1 AND user_id = $2 AND id = $3`,
      [workspaceId, userId, id],
    )
    return (result.rowCount ?? 0) > 0
  }

  /** The conversation's active run, if any (at most one). */
  async activeRunId(workspaceId: string, userId: string, conversationId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM agent_runs
        WHERE workspace_id = $1 AND user_id = $2 AND conversation_id = $3 AND status IN ${ACTIVE}`,
      [workspaceId, userId, conversationId],
    )
    return rows[0]?.id ?? null
  }

  /**
   * Queues a run with the files sent with it, in a new conversation (titled
   * `newConversation.title`) or in the user's existing one, which counts as
   * updated, all or nothing. A retry copies the files of the run it retries.
   * Returns null when the conversation is not the user's; rejects with a
   * unique violation (23505) while the conversation has another active run,
   * on a mutation id the user already used, or when the run was retried before.
   */
  async insertRun(input: NewRun): Promise<AgentRun | null> {
    return this.transaction(async (client) => {
      if (input.newConversation) {
        await client.query(
          "INSERT INTO conversations (id, workspace_id, user_id, title) VALUES ($1, $2, $3, $4)",
          [input.conversationId, input.workspaceId, input.userId, input.newConversation.title],
        )
      }
      const { rows } = await client.query<RunRow>(
        `WITH conversation AS (
           UPDATE conversations SET updated_at = now()
            WHERE workspace_id = $2 AND id = $3 AND user_id = $4
            RETURNING id
         )
         INSERT INTO agent_runs
           (id, workspace_id, conversation_id, user_id, question, connection_ids, provider, model,
            mutation_id, retry_of)
         SELECT $1, $2, id, $4, $5, $6, $7, $8, $9, $10 FROM conversation
         RETURNING ${RUN_COLUMNS}`,
        [
          input.id,
          input.workspaceId,
          input.conversationId,
          input.userId,
          input.question,
          input.connectionIds,
          input.provider,
          input.model,
          input.mutationId ?? null,
          input.retryOf ?? null,
        ],
      )
      const row = rows[0]
      if (!row) return null
      const files = input.attachments ?? []
      if (input.retryOf) {
        await client.query(
          `INSERT INTO agent_run_attachments
             (workspace_id, run_id, position, name, media_type, size_bytes, content)
           SELECT workspace_id, $2, position, name, media_type, size_bytes, content
             FROM agent_run_attachments WHERE workspace_id = $1 AND run_id = $3`,
          [input.workspaceId, input.id, input.retryOf],
        )
      } else if (files.length > 0) {
        await client.query(
          `INSERT INTO agent_run_attachments
             (workspace_id, run_id, position, name, media_type, size_bytes, content)
           SELECT $1, $2, position, name, media_type, size_bytes, content
             FROM unnest($3::text[], $4::text[], $5::int[], $6::text[])
               WITH ORDINALITY AS f (name, media_type, size_bytes, content, position)`,
          [
            input.workspaceId,
            input.id,
            files.map((file) => file.name),
            files.map((file) => file.mediaType),
            files.map((file) => file.sizeBytes),
            files.map((file) => file.content),
          ],
        )
      }
      return { ...toRun(row), attachments: await this.attachmentsOf(client, input.workspaceId, input.id) }
    })
  }

  async getRun(workspaceId: string, userId: string, id: string): Promise<AgentRun | null> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_WITH_ATTACHMENTS} FROM agent_runs r
        WHERE r.workspace_id = $1 AND r.user_id = $2 AND r.id = $3`,
      [workspaceId, userId, id],
    )
    return rows[0] ? toRun(rows[0]) : null
  }

  /** The run the user started with this mutation id, if any. */
  async findByMutation(workspaceId: string, userId: string, mutationId: string): Promise<AgentRun | null> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_WITH_ATTACHMENTS} FROM agent_runs r
        WHERE r.workspace_id = $1 AND r.user_id = $2 AND r.mutation_id = $3`,
      [workspaceId, userId, mutationId],
    )
    return rows[0] ? toRun(rows[0]) : null
  }

  /** The run that retries run `id`, if it was retried. */
  async findRetry(workspaceId: string, userId: string, id: string): Promise<AgentRun | null> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_WITH_ATTACHMENTS} FROM agent_runs r
        WHERE r.workspace_id = $1 AND r.user_id = $2 AND r.retry_of = $3`,
      [workspaceId, userId, id],
    )
    return rows[0] ? toRun(rows[0]) : null
  }

  /** A run's events after sequence number `after`, in order. */
  async events(workspaceId: string, userId: string, runId: string, after: number): Promise<RunEvent[]> {
    const { rows } = await this.pool.query<EventRow>(
      `SELECT e.seq, e.type, e.data, e.created_at
         FROM agent_run_events e
         JOIN agent_runs r ON r.id = e.run_id
        WHERE r.workspace_id = $1 AND r.user_id = $2 AND e.run_id = $3 AND e.seq > $4
        ORDER BY e.seq`,
      [workspaceId, userId, runId, after],
    )
    return rows.map(toEvent)
  }

  /**
   * The user's conversation with its latest `limit` runs (older than run
   * `before`, when given), oldest first, and their events. Finished runs
   * leave out answer.delta events: their answer (or error) supersedes the
   * text streamed while working.
   */
  async conversation(
    workspaceId: string,
    userId: string,
    conversationId: string,
    page: { limit: number; before?: string | undefined },
  ): Promise<{ conversation: Conversation; runs: AgentRunWithEvents[]; hasEarlier: boolean } | null> {
    const conversation = await this.getConversation(workspaceId, userId, conversationId)
    if (!conversation) return null
    const runs = await this.pool.query<RunRow>(
      `SELECT * FROM (
         SELECT ${RUN_WITH_ATTACHMENTS} FROM agent_runs r
          WHERE r.workspace_id = $1 AND r.user_id = $2 AND r.conversation_id = $3
            AND ($5::uuid IS NULL OR (r.created_at, r.id) < (
              SELECT b.created_at, b.id FROM agent_runs b
               WHERE b.workspace_id = $1 AND b.conversation_id = $3 AND b.id = $5))
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $4
       ) latest
       ORDER BY created_at, id`,
      [workspaceId, userId, conversationId, page.limit + 1, page.before ?? null],
    )
    // One more than the limit was read, to tell whether older runs exist.
    const shown = runs.rows.slice(runs.rows.length > page.limit ? 1 : 0)
    const ids = shown.map((row) => row.id)
    const events = await this.pool.query<EventRow & { run_id: string }>(
      `SELECT e.run_id, e.seq, e.type, e.data, e.created_at
         FROM agent_run_events e
         JOIN agent_runs r ON r.id = e.run_id
        WHERE r.workspace_id = $1 AND r.user_id = $2 AND e.run_id = ANY ($3::uuid[])
          AND (e.type <> 'answer.delta' OR r.status IN ${ACTIVE})
        ORDER BY e.run_id, e.seq`,
      [workspaceId, userId, ids],
    )
    return {
      conversation,
      runs: shown.map((row) => ({
        ...toRun(row),
        events: events.rows.filter((event) => event.run_id === row.id).map(toEvent),
      })),
      hasEarlier: runs.rows.length > page.limit,
    }
  }

  /** Records an event of an active run that changes nothing else; null when the run is not active. */
  async appendEvent<T extends RunEventType>(
    workspaceId: string,
    runId: string,
    event: { type: T; data: RunEventData[T] },
  ): Promise<RunEvent | null> {
    return this.write(workspaceId, runId, { ...event, when: `status IN ${ACTIVE}` })
  }

  /** Moves a queued run to running with its run.started event; null when it already ended. */
  async markRunning(
    workspaceId: string,
    id: string,
    started: RunEventData["run.started"],
  ): Promise<RunEvent | null> {
    return this.write(workspaceId, id, {
      type: "run.started",
      data: started,
      set: "status = 'running', started_at = now()",
      when: "status = 'queued'",
    })
  }

  /**
   * A running run waits for the user's answer to `clarification`, keeping the
   * checkpoint it goes on from after a restart (unless it is too large).
   */
  async markAwaiting(
    workspaceId: string,
    id: string,
    clarification: Clarification,
    checkpoint: RunCheckpoint,
  ): Promise<RunEvent | null> {
    const text = JSON.stringify(checkpoint)
    return this.write(workspaceId, id, {
      type: "clarification.requested",
      data: clarification,
      set: "status = 'awaiting_input', clarification = $4::jsonb, checkpoint = $5::json",
      when: "status = 'running'",
      params: [Buffer.byteLength(text) <= CHECKPOINT_BYTES ? text : null],
    })
  }

  /** A run waiting for the answer to this clarification goes on; null when it no longer waits for it. */
  async markResumed(
    workspaceId: string,
    id: string,
    answered: RunEventData["clarification.answered"],
  ): Promise<RunEvent | null> {
    return this.write(workspaceId, id, {
      type: "clarification.answered",
      data: answered,
      set: "status = 'running', clarification = NULL, checkpoint = NULL",
      when: "status = 'awaiting_input' AND clarification ->> 'id' = $5",
      params: [answered.id],
    })
  }

  /** The checkpoint of a run waiting for the user, if one was stored. */
  async checkpoint(workspaceId: string, id: string): Promise<RunCheckpoint | null> {
    const { rows } = await this.pool.query<{ checkpoint: RunCheckpoint | null }>(
      `SELECT checkpoint FROM agent_runs
        WHERE workspace_id = $1 AND id = $2 AND status = 'awaiting_input'`,
      [workspaceId, id],
    )
    return rows[0]?.checkpoint ?? null
  }

  /**
   * Records how an active run ended with its terminal event. An interrupted
   * run gets its disposition. Null when the run had already ended, or, with
   * `waiting`, when it no longer waits for the user (it was answered).
   */
  async finish(
    workspaceId: string,
    id: string,
    outcome: RunOutcome,
    waiting = false,
  ): Promise<RunEvent | null> {
    const interrupted = outcome.status === "interrupted"
    return this.write(workspaceId, id, {
      ...terminalEvent(outcome),
      set: `status = $5, answer = $6::jsonb, error = $7::jsonb, usage = $8::jsonb, steps = $9,
            transcript = $10::jsonb, clarification = NULL, checkpoint = NULL, finished_at = now(),
            disposition = ${interrupted ? DISPOSITION : "NULL"}`,
      when: waiting ? "status = 'awaiting_input'" : `status IN ${ACTIVE}`,
      params: [
        outcome.status,
        outcome.answer ? jsonbText(outcome.answer) : null,
        outcome.error ? jsonbText(outcome.error) : null,
        jsonbText(outcome.usage),
        outcome.steps,
        jsonbText(outcome.transcript),
      ],
      withDisposition: interrupted,
    })
  }

  /** The conversation's finished questions before `runId`, newest first, with bounded answers. */
  async priorTurns(
    workspaceId: string,
    userId: string,
    conversationId: string,
    runId: string,
    limit: number,
  ): Promise<PriorTurn[]> {
    const { rows } = await this.pool.query<{
      question: string
      status: RunStatus
      answer: string | null
      error: string | null
    }>(
      `SELECT question, status, left(answer ->> 'markdown', ${PRIOR_ANSWER_CHARS}) AS answer,
              error ->> 'message' AS error
         FROM agent_runs
        WHERE workspace_id = $1 AND user_id = $2 AND conversation_id = $3 AND id <> $4
          AND status IN ('completed', 'failed', 'cancelled')
        ORDER BY created_at DESC
        LIMIT $5`,
      [workspaceId, userId, conversationId, runId, limit],
    )
    return rows
  }

  /**
   * The latest `limit` files sent in the user's conversation, oldest first,
   * without content. Files of a run that was retried are left out: the retry
   * carries copies of them.
   */
  async conversationAttachments(
    workspaceId: string,
    userId: string,
    conversationId: string,
    limit: number,
  ): Promise<AttachmentSummary[]> {
    const { rows } = await this.pool.query<{
      id: string
      name: string
      media_type: AttachmentMediaType
      size_bytes: number
    }>(
      `SELECT a.id, a.name, a.media_type, a.size_bytes
         FROM agent_run_attachments a
         JOIN agent_runs r ON r.id = a.run_id
        WHERE a.workspace_id = $1 AND r.workspace_id = $1 AND r.user_id = $2 AND r.conversation_id = $3
          AND NOT EXISTS (SELECT 1 FROM agent_runs retry WHERE retry.retry_of = r.id)
        ORDER BY r.created_at DESC, a.position DESC
        LIMIT $4`,
      [workspaceId, userId, conversationId, limit],
    )
    return rows.reverse().map((row) => ({
      id: row.id,
      name: row.name,
      mediaType: row.media_type,
      sizeBytes: row.size_bytes,
    }))
  }

  /** One attached file with its text. */
  async readAttachment(
    workspaceId: string,
    id: string,
  ): Promise<(AttachmentSummary & { content: string }) | null> {
    const { rows } = await this.pool.query<{
      id: string
      name: string
      media_type: AttachmentMediaType
      size_bytes: number
      content: string
    }>(
      `SELECT id, name, media_type, size_bytes, content FROM agent_run_attachments
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id],
    )
    const row = rows[0]
    return row
      ? {
          id: row.id,
          name: row.name,
          mediaType: row.media_type,
          sizeBytes: row.size_bytes,
          content: row.content,
        }
      : null
  }

  /**
   * Startup maintenance across all workspaces. No run is being worked on
   * after a restart: runs left queued or running (and waits without a stored
   * checkpoint) become interrupted with a run.interrupted event and their
   * disposition; waits whose time to answer ran out fail with
   * AGENT_INPUT_TIMEOUT. Other waits stay: they go on once answered.
   */
  async recoverAfterRestart(): Promise<{ interrupted: number; expired: number }> {
    const interrupted = await this.pool.query(
      `WITH run AS (
         UPDATE agent_runs
            SET status = 'interrupted', error = $1::jsonb, disposition = ${DISPOSITION},
                clarification = NULL, checkpoint = NULL, finished_at = now(), last_seq = last_seq + 1
          WHERE status IN ('queued', 'running') OR (status = 'awaiting_input' AND checkpoint IS NULL)
          RETURNING id, last_seq, disposition
       )
       INSERT INTO agent_run_events (run_id, seq, type, data)
       SELECT id, last_seq, 'run.interrupted', $1::jsonb || jsonb_build_object('disposition', disposition)
         FROM run`,
      [JSON.stringify(INTERRUPTED)],
    )
    const timedOut: RunError = {
      code: "AGENT_INPUT_TIMEOUT",
      message: "No reply to the clarification arrived in time, so the question was stopped. Ask it again.",
    }
    const expired = await this.pool.query(
      `WITH run AS (
         UPDATE agent_runs
            SET status = 'failed', error = $1::jsonb, clarification = NULL, checkpoint = NULL,
                finished_at = now(), last_seq = last_seq + 1
          WHERE status = 'awaiting_input' AND (clarification ->> 'expiresAt')::timestamptz <= now()
          RETURNING id, last_seq
       )
       INSERT INTO agent_run_events (run_id, seq, type, data)
       SELECT id, last_seq, 'run.failed', $1::jsonb FROM run`,
      [JSON.stringify(timedOut)],
    )
    return { interrupted: interrupted.rowCount ?? 0, expired: expired.rowCount ?? 0 }
  }

  private async write(workspaceId: string, runId: string, write: EventWrite): Promise<RunEvent | null> {
    const { rows } = await this.pool.query<EventRow>(eventStatement(write), [
      workspaceId,
      runId,
      write.type,
      jsonbText(write.data),
      ...(write.params ?? []),
    ])
    return rows[0] ? toEvent(rows[0]) : null
  }

  private async attachmentsOf(
    client: PoolClient,
    workspaceId: string,
    runId: string,
  ): Promise<AttachmentSummary[]> {
    const { rows } = await client.query<{
      id: string
      name: string
      media_type: AttachmentMediaType
      size_bytes: number
    }>(
      `SELECT id, name, media_type, size_bytes FROM agent_run_attachments
        WHERE workspace_id = $1 AND run_id = $2 ORDER BY position`,
      [workspaceId, runId],
    )
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      mediaType: row.media_type,
      sizeBytes: row.size_bytes,
    }))
  }

  /** Runs `work` in a transaction; a null result rolls it back. */
  private async transaction<T>(work: (client: PoolClient) => Promise<T | null>): Promise<T | null> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await work(client)
      await client.query(result === null ? "ROLLBACK" : "COMMIT")
      return result
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }
}
