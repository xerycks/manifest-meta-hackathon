import type { Pool } from "pg"

import { jsonbText } from "../shared/postgres/json.js"
import type { DecodedAttachment } from "./attachments.js"
import type {
  AgentAnswer,
  AgentRun,
  AgentRunWithEvents,
  AttachmentMediaType,
  AttachmentSummary,
  Clarification,
  Conversation,
  RunError,
  RunEvent,
  RunEventData,
  RunEventType,
  RunStatus,
  TokenUsage,
} from "./contracts.js"
import type { ModelMessage } from "./provider.js"

/** An earlier question of a conversation and how it ended, bounded for model context. */
export interface PriorTurn {
  question: string
  status: RunStatus
  answer: string | null
  error: string | null
}

export interface RunOutcome {
  status: "completed" | "failed" | "cancelled"
  answer: AgentAnswer | null
  error: RunError | null
  usage: TokenUsage
  steps: number
  transcript: ModelMessage[]
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

const RUN_COLUMNS = `id, conversation_id, user_id, question, connection_ids, status, provider, model,
  answer, error, usage, steps, clarification, created_at, started_at, finished_at`

/** RUN_COLUMNS of agent_runs `r` with the run's attachments (no content), oldest first. */
const RUN_WITH_ATTACHMENTS = `r.id, r.conversation_id, r.user_id, r.question, r.connection_ids, r.status,
  r.provider, r.model, r.answer, r.error, r.usage, r.steps, r.clarification, r.created_at,
  r.started_at, r.finished_at,
  (SELECT coalesce(json_agg(json_build_object('id', a.id, 'name', a.name, 'mediaType', a.media_type,
            'sizeBytes', a.size_bytes) ORDER BY a.position), '[]')
     FROM agent_run_attachments a WHERE a.run_id = r.id) AS attachments`

const ACTIVE = "('queued', 'running', 'awaiting_input')"

/** Characters of an earlier answer given to the model as context. */
const PRIOR_ANSWER_CHARS = 4_000

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
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  }
}

function toEvent(row: EventRow): RunEvent {
  return { seq: row.seq, type: row.type, data: row.data, createdAt: row.created_at.toISOString() } as RunEvent
}

/**
 * Conversations, agent runs, their events, and the files sent with them. Every query is scoped by
 * workspace_id, and reads on behalf of a user also by user_id: conversations
 * and runs are private to the user who created them.
 */
export class AgentRunsRepository {
  constructor(private readonly pool: Pool) {}

  async getConversation(workspaceId: string, userId: string, id: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query<{ id: string; title: string; created_at: Date; updated_at: Date }>(
      `SELECT id, title, created_at, updated_at FROM conversations
        WHERE workspace_id = $1 AND user_id = $2 AND id = $3`,
      [workspaceId, userId, id],
    )
    const row = rows[0]
    return row
      ? {
          id: row.id,
          title: row.title,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        }
      : null
  }

  async createConversation(input: {
    id: string
    workspaceId: string
    userId: string
    title: string
  }): Promise<void> {
    await this.pool.query(
      "INSERT INTO conversations (id, workspace_id, user_id, title) VALUES ($1, $2, $3, $4)",
      [input.id, input.workspaceId, input.userId, input.title],
    )
  }

  /**
   * Queues a run in the user's conversation, which counts as updated, with
   * the files sent with it (all or nothing). Returns null when the
   * conversation is not the user's; rejects with a unique violation (23505)
   * while the conversation has another active run.
   */
  async insertRun(input: {
    id: string
    workspaceId: string
    conversationId: string
    userId: string
    question: string
    connectionIds: string[]
    provider: string
    model: string
    attachments?: DecodedAttachment[]
  }): Promise<AgentRun | null> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const { rows } = await client.query<RunRow>(
        `WITH conversation AS (
           UPDATE conversations SET updated_at = now()
            WHERE workspace_id = $2 AND id = $3 AND user_id = $4
            RETURNING id
         )
         INSERT INTO agent_runs
           (id, workspace_id, conversation_id, user_id, question, connection_ids, provider, model)
         SELECT $1, $2, id, $4, $5, $6, $7, $8 FROM conversation
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
        ],
      )
      const row = rows[0]
      if (!row) {
        await client.query("ROLLBACK")
        return null
      }
      const files = input.attachments ?? []
      const attached =
        files.length === 0
          ? []
          : (
              await client.query<{
                id: string
                position: number
                name: string
                media_type: AttachmentMediaType
                size_bytes: number
              }>(
                `INSERT INTO agent_run_attachments
                   (workspace_id, run_id, position, name, media_type, size_bytes, content)
                 SELECT $1, $2, position, name, media_type, size_bytes, content
                   FROM unnest($3::text[], $4::text[], $5::int[], $6::text[])
                     WITH ORDINALITY AS f (name, media_type, size_bytes, content, position)
                 RETURNING id, position, name, media_type, size_bytes`,
                [
                  input.workspaceId,
                  input.id,
                  files.map((file) => file.name),
                  files.map((file) => file.mediaType),
                  files.map((file) => file.sizeBytes),
                  files.map((file) => file.content),
                ],
              )
            ).rows
      await client.query("COMMIT")
      return toRun({
        ...row,
        attachments: attached
          .sort((a, b) => a.position - b.position)
          .map((file) => ({
            id: file.id,
            name: file.name,
            mediaType: file.media_type,
            sizeBytes: file.size_bytes,
          })),
      })
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  async getRun(workspaceId: string, userId: string, id: string): Promise<AgentRun | null> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_WITH_ATTACHMENTS} FROM agent_runs r
        WHERE r.workspace_id = $1 AND r.user_id = $2 AND r.id = $3`,
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
   * The user's conversation with its latest `limit` runs, oldest first, and
   * their events. Finished runs leave out answer.delta events: their answer
   * (or error) supersedes the text streamed while working.
   */
  async conversation(
    workspaceId: string,
    userId: string,
    conversationId: string,
    limit: number,
  ): Promise<{ conversation: Conversation; runs: AgentRunWithEvents[] } | null> {
    const conversation = await this.getConversation(workspaceId, userId, conversationId)
    if (!conversation) return null
    const runs = await this.pool.query<RunRow>(
      `SELECT * FROM (
         SELECT ${RUN_WITH_ATTACHMENTS} FROM agent_runs r
          WHERE r.workspace_id = $1 AND r.user_id = $2 AND r.conversation_id = $3
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $4
       ) latest
       ORDER BY created_at, id`,
      [workspaceId, userId, conversationId, limit],
    )
    const ids = runs.rows.map((row) => row.id)
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
      runs: runs.rows.map((row) => ({
        ...toRun(row),
        events: events.rows.filter((event) => event.run_id === row.id).map(toEvent),
      })),
    }
  }

  /** Records an event; returns when it was recorded. */
  async appendEvent<T extends RunEventType>(
    workspaceId: string,
    runId: string,
    event: { seq: number; type: T; data: RunEventData[T] },
  ): Promise<string> {
    const { rows } = await this.pool.query<{ created_at: Date }>(
      `INSERT INTO agent_run_events (run_id, seq, type, data)
       SELECT id, $3, $4, $5::jsonb FROM agent_runs WHERE workspace_id = $1 AND id = $2
       RETURNING created_at`,
      [workspaceId, runId, event.seq, event.type, jsonbText(event.data)],
    )
    return (rows[0]?.created_at ?? new Date()).toISOString()
  }

  /** Moves a queued run to running; false when it already ended. */
  async markRunning(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE agent_runs SET status = 'running', started_at = now()
        WHERE workspace_id = $1 AND id = $2 AND status = 'queued'`,
      [workspaceId, id],
    )
    return (result.rowCount ?? 0) > 0
  }

  /** A running run waits for the user's answer to `clarification`. */
  async markAwaiting(workspaceId: string, id: string, clarification: Clarification): Promise<void> {
    await this.pool.query(
      `UPDATE agent_runs SET status = 'awaiting_input', clarification = $3::jsonb
        WHERE workspace_id = $1 AND id = $2 AND status = 'running'`,
      [workspaceId, id, jsonbText(clarification)],
    )
  }

  /** A run that was waiting for the user goes on. */
  async markResumed(workspaceId: string, id: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_runs SET status = 'running', clarification = NULL
        WHERE workspace_id = $1 AND id = $2 AND status = 'awaiting_input'`,
      [workspaceId, id],
    )
  }

  /** Records how an active run ended. A run that already ended is left as it is. */
  async finish(workspaceId: string, id: string, outcome: RunOutcome): Promise<void> {
    await this.pool.query(
      `UPDATE agent_runs
          SET status = $3, answer = $4::jsonb, error = $5::jsonb, usage = $6::jsonb, steps = $7,
              transcript = $8::jsonb, clarification = NULL, finished_at = now()
        WHERE workspace_id = $1 AND id = $2 AND status IN ${ACTIVE}`,
      [
        workspaceId,
        id,
        outcome.status,
        outcome.answer ? jsonbText(outcome.answer) : null,
        outcome.error ? jsonbText(outcome.error) : null,
        jsonbText(outcome.usage),
        outcome.steps,
        jsonbText(outcome.transcript),
      ],
    )
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

  /** The latest `limit` files sent in the user's conversation, oldest first, without content. */
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
   * Startup maintenance across all workspaces: no run survives a restart, so
   * anything still queued, running, or waiting for the user was interrupted.
   * Each gets a run.failed event.
   */
  async failInterrupted(): Promise<number> {
    const error: RunError = {
      code: "AGENT_INTERRUPTED",
      message: "Interrupted by a restart of the backend. Ask the question again.",
    }
    const result = await this.pool.query(
      `WITH failed AS (
         UPDATE agent_runs SET status = 'failed', error = $1::jsonb, clarification = NULL, finished_at = now()
          WHERE status IN ${ACTIVE}
          RETURNING id
       )
       INSERT INTO agent_run_events (run_id, seq, type, data)
       SELECT f.id, coalesce((SELECT max(e.seq) FROM agent_run_events e WHERE e.run_id = f.id), 0) + 1,
              'run.failed', $1::jsonb
         FROM failed f`,
      [JSON.stringify(error)],
    )
    return result.rowCount ?? 0
  }
}
