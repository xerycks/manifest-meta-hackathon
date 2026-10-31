import type { Pool } from "pg"

import { jsonbText } from "../shared/postgres/json.js"
import type {
  AgentAnswer,
  AgentRun,
  RunError,
  RunEvent,
  RunEventData,
  RunEventType,
  RunStatus,
  TokenUsage,
} from "./contracts.js"
import type { ModelMessage } from "./provider.js"

export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

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
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

const RUN_COLUMNS = `id, conversation_id, user_id, question, connection_ids, status, provider, model,
  answer, error, usage, steps, created_at, started_at, finished_at`

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
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  }
}

/**
 * Conversations, agent runs, and run events. Every query is scoped by
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
   * Queues a run in the user's conversation, which counts as updated. Returns
   * null when the conversation is not the user's; rejects with a unique
   * violation (23505) while the conversation has another active run.
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
  }): Promise<AgentRun | null> {
    const { rows } = await this.pool.query<RunRow>(
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
    return rows[0] ? toRun(rows[0]) : null
  }

  async getRun(workspaceId: string, userId: string, id: string): Promise<AgentRun | null> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE workspace_id = $1 AND user_id = $2 AND id = $3`,
      [workspaceId, userId, id],
    )
    return rows[0] ? toRun(rows[0]) : null
  }

  /** A run's events after sequence number `after`, in order. */
  async events(workspaceId: string, userId: string, runId: string, after: number): Promise<RunEvent[]> {
    const { rows } = await this.pool.query<{
      seq: number
      type: RunEventType
      data: RunEventData[RunEventType]
      created_at: Date
    }>(
      `SELECT e.seq, e.type, e.data, e.created_at
         FROM agent_run_events e
         JOIN agent_runs r ON r.id = e.run_id
        WHERE r.workspace_id = $1 AND r.user_id = $2 AND e.run_id = $3 AND e.seq > $4
        ORDER BY e.seq`,
      [workspaceId, userId, runId, after],
    )
    return rows.map(
      (row) =>
        ({
          seq: row.seq,
          type: row.type,
          data: row.data,
          createdAt: row.created_at.toISOString(),
        }) as RunEvent,
    )
  }

  async appendEvent<T extends RunEventType>(
    workspaceId: string,
    runId: string,
    event: { seq: number; type: T; data: RunEventData[T] },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_run_events (run_id, seq, type, data)
       SELECT id, $3, $4, $5::jsonb FROM agent_runs WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, runId, event.seq, event.type, jsonbText(event.data)],
    )
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

  /** Records how an active run ended. A run that already ended is left as it is. */
  async finish(workspaceId: string, id: string, outcome: RunOutcome): Promise<void> {
    await this.pool.query(
      `UPDATE agent_runs
          SET status = $3, answer = $4::jsonb, error = $5::jsonb, usage = $6::jsonb, steps = $7,
              transcript = $8::jsonb, finished_at = now()
        WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running')`,
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

  /**
   * Startup maintenance across all workspaces: no run survives a restart, so
   * anything still queued or running was interrupted. Each gets a run.failed event.
   */
  async failInterrupted(): Promise<number> {
    const error: RunError = {
      code: "AGENT_INTERRUPTED",
      message: "Interrupted by a restart of the backend. Ask the question again.",
    }
    const result = await this.pool.query(
      `WITH failed AS (
         UPDATE agent_runs SET status = 'failed', error = $1::jsonb, finished_at = now()
          WHERE status IN ('queued', 'running')
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
