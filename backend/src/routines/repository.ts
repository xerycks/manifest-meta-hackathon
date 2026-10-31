import type { Pool, PoolClient } from "pg"

import { authorNameSql, toAuthor } from "../auth/repository.js"
import type { RunValues } from "../saved-queries/parameters.js"
import type { VersionedSave } from "../shared/postgres/versioned.js"
import { describeSchedule, type MissedSlots } from "./schedule.js"
import {
  ROUTINE_LIMITS,
  type Delivery,
  type PausedReason,
  type Routine,
  type RoutineDetail,
  type RoutineKind,
  type RoutineRun,
  type RoutineRunError,
  type RoutineRunStatus,
  type RoutineSavedQuery,
  type RoutineTarget,
  type RoutineTrigger,
} from "./schemas.js"

interface RoutineRow {
  id: string
  name: string
  description: string
  kind: RoutineKind
  saved_query_id: string | null
  saved_query_name: string | null
  saved_query_visible: boolean | null
  parameters: RunValues
  question: string | null
  connection_ids: string[]
  cron: string
  timezone: string
  enabled: boolean
  paused_reason: PausedReason | null
  next_run_at: Date | null
  last_run_at: Date | null
  last_status: RoutineRunStatus | null
  consecutive_failures: number
  delivery: Delivery
  owner_id: string | null
  owner_name: string | null
  version: number
  updated_by: string | null
  updated_by_name: string | null
  created_at: Date
  updated_at: Date
  conversation_id: string | null
}

interface RunRow {
  id: string
  routine_id: string
  trigger: RoutineTrigger
  scheduled_for: Date | null
  status: RoutineRunStatus
  execution_id: string | null
  execution_connection_id: string | null
  execution_private: boolean
  agent_run_id: string | null
  conversation_id: string | null
  error: RoutineRunError | null
  missed: MissedSlots | null
  requested_by: string | null
  requested_by_name: string | null
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

/**
 * Routines as `$2` sees them: the saved query's name only if they may open
 * it, and the routine's conversation only if it is theirs.
 */
const ROUTINE_SELECT = `
  SELECT r.id, r.name, r.description, r.kind, r.saved_query_id, s.name AS saved_query_name,
         (s.visibility = 'workspace' OR s.created_by = $2) AS saved_query_visible,
         r.parameters, r.question, r.connection_ids, r.cron, r.timezone, r.enabled, r.paused_reason,
         r.next_run_at, r.last_run_at, r.last_status, r.consecutive_failures, r.delivery, r.version,
         r.owner_id, ${authorNameSql("ou")} AS owner_name,
         r.updated_by, ${authorNameSql("uu")} AS updated_by_name, r.created_at, r.updated_at,
         (SELECT c.id FROM conversations c
           WHERE c.workspace_id = r.workspace_id AND c.routine_id = r.id AND c.user_id = $2
         ) AS conversation_id
    FROM routines r
    LEFT JOIN saved_queries s ON s.workspace_id = r.workspace_id AND s.id = r.saved_query_id
    LEFT JOIN users ou ON ou.id = r.owner_id
    LEFT JOIN users uu ON uu.id = r.updated_by`

/**
 * Runs of routines in workspace $1 as viewer $2 sees them: conversations only
 * for their owner, and query runs of a saved query private to someone else
 * only for whoever ran them.
 */
const RUN_SELECT = `
  SELECT rr.id, rr.routine_id, rr.trigger, rr.scheduled_for, rr.status, rr.execution_id,
         qe.connection_id AS execution_connection_id,
         coalesce(s.visibility = 'private' AND s.created_by IS DISTINCT FROM $2
                  AND qe.user_id IS DISTINCT FROM $2, false) AS execution_private,
         rr.agent_run_id, CASE WHEN ar.user_id = $2 THEN ar.conversation_id END AS conversation_id,
         rr.error, rr.missed, rr.requested_by, ${authorNameSql("u")} AS requested_by_name,
         rr.created_at, rr.started_at, rr.finished_at
    FROM routine_runs rr
    LEFT JOIN query_executions qe ON qe.workspace_id = rr.workspace_id AND qe.id = rr.execution_id
    LEFT JOIN saved_queries s ON s.workspace_id = qe.workspace_id AND s.id = qe.saved_query_id
    LEFT JOIN agent_runs ar ON ar.workspace_id = rr.workspace_id AND ar.id = rr.agent_run_id
    LEFT JOIN users u ON u.id = rr.requested_by`

/**
 * Newest first: by slot (or when a manual run was asked for), so a note of
 * missed slots sits below the run that followed them.
 */
const RUN_ORDER = "ORDER BY coalesce(rr.scheduled_for, rr.created_at) DESC, rr.created_at DESC, rr.id DESC"

function savedQueryOf(row: RoutineRow): RoutineSavedQuery | null {
  if (row.kind !== "saved_query") return null
  if (!row.saved_query_id || row.saved_query_name === null) return { state: "removed" }
  return row.saved_query_visible
    ? { state: "available", id: row.saved_query_id, name: row.saved_query_name }
    : { state: "private", id: row.saved_query_id }
}

function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    savedQuery: savedQueryOf(row),
    parameters: row.parameters,
    question: row.question,
    connectionIds: row.connection_ids,
    cron: row.cron,
    timeZone: row.timezone,
    schedule: describeSchedule(row.cron),
    enabled: row.enabled,
    pausedReason: row.paused_reason,
    nextRunAt: row.next_run_at?.toISOString() ?? null,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastStatus: row.last_status,
    consecutiveFailures: row.consecutive_failures,
    delivery: row.delivery,
    owner: toAuthor(row.owner_id, row.owner_name),
    version: row.version,
    updatedBy: toAuthor(row.updated_by, row.updated_by_name),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function toRun(row: RunRow): RoutineRun {
  return {
    id: row.id,
    routineId: row.routine_id,
    trigger: row.trigger,
    scheduledFor: row.scheduled_for?.toISOString() ?? null,
    status: row.status,
    execution:
      row.execution_id && row.execution_connection_id && !row.execution_private
        ? { id: row.execution_id, connectionId: row.execution_connection_id }
        : null,
    agentRunId: row.agent_run_id,
    conversationId: row.conversation_id,
    error: row.error,
    missed: row.missed,
    requestedBy: toAuthor(row.requested_by, row.requested_by_name),
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  }
}

/** What a stored routine runs; its saved query is null once deleted. */
export type StoredTarget =
  | { kind: "saved_query"; savedQueryId: string | null; parameters: RunValues }
  | { kind: "question"; question: string; connectionIds: string[] }

/** A stored routine with what a run needs. */
export interface RoutineDefinition {
  id: string
  name: string
  ownerId: string | null
  target: StoredTarget
  timeZone: string
}

/** A routine with the viewer's link to its conversation. */
export type ViewedRoutine = Routine & Pick<RoutineDetail, "conversationId">

export interface NewRoutine {
  workspaceId: string
  ownerId: string
  name: string
  description: string
  target: RoutineTarget
  cron: string
  timeZone: string
  /** Null creates it paused. */
  nextRunAt: Date | null
  delivery: Delivery
}

export interface RoutineChanges {
  name?: string | undefined
  description?: string | undefined
  target?: RoutineTarget | undefined
  cron?: string | undefined
  timeZone?: string | undefined
  enabled?: boolean | undefined
  delivery?: Delivery | undefined
}

/** A routine whose next slot has come, as the dispatcher claims it. */
export interface DueRoutine {
  id: string
  workspaceId: string
  cron: string
  timeZone: string
  nextRunAt: Date
}

/** What claiming a due routine does: run `slot`, note any missed slots, and move on to `next`. */
export interface SlotPlan {
  slot: Date
  next: Date | null
  missed: { slots: MissedSlots; message: string } | null
}

/** A routine run to start. */
export interface QueuedRun {
  id: string
  workspaceId: string
  routineId: string
}

export interface RunOutcome {
  status: Exclude<RoutineRunStatus, "queued" | "running">
  error: RoutineRunError | null
  executionId?: string | undefined
}

/** The next slot of a (valid) schedule after now. */
export type NextRun = (cron: string, timeZone: string) => Date

const UNREADABLE_SCHEDULE: RoutineRunError = {
  code: "ROUTINE_SCHEDULE_UNREADABLE",
  message: "Manifest could not read this routine's schedule or time zone, so it was paused. Edit the schedule, then resume it.",
}

const targetColumns = (target: RoutineTarget) =>
  target.kind === "saved_query"
    ? { savedQueryId: target.savedQueryId, parameters: target.parameters, question: null, connectionIds: [] }
    : { savedQueryId: null, parameters: {}, question: target.question, connectionIds: target.connectionIds }

/**
 * Routines and their runs. Every query on behalf of a request is scoped by
 * workspace_id; claiming due routines and startup recovery work across
 * workspaces, as the scheduler serves them all.
 */
export class RoutinesRepository {
  constructor(private readonly pool: Pool) {}

  /** All of the workspace's routines (at most ROUTINE_LIMITS.perWorkspace), by name. */
  async list(workspaceId: string, viewerId: string): Promise<Routine[]> {
    const { rows } = await this.pool.query<RoutineRow>(
      `${ROUTINE_SELECT} WHERE r.workspace_id = $1 ORDER BY lower(r.name), r.id`,
      [workspaceId, viewerId],
    )
    return rows.map(toRoutine)
  }

  async get(workspaceId: string, viewerId: string, id: string): Promise<ViewedRoutine | null> {
    const { rows } = await this.pool.query<RoutineRow>(
      `${ROUTINE_SELECT} WHERE r.workspace_id = $1 AND r.id = $3`,
      [workspaceId, viewerId, id],
    )
    const row = rows[0]
    return row ? { ...toRoutine(row), conversationId: row.conversation_id } : null
  }

  async count(workspaceId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM routines WHERE workspace_id = $1",
      [workspaceId],
    )
    return rows[0]?.count ?? 0
  }

  /** What a run of the routine needs, read when it starts. */
  async definition(workspaceId: string, id: string): Promise<RoutineDefinition | null> {
    const { rows } = await this.pool.query<{
      name: string
      owner_id: string | null
      kind: RoutineKind
      saved_query_id: string | null
      parameters: RunValues
      question: string | null
      connection_ids: string[]
      timezone: string
    }>(
      `SELECT name, owner_id, kind, saved_query_id, parameters, question, connection_ids, timezone
         FROM routines WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id],
    )
    const row = rows[0]
    if (!row) return null
    return {
      id,
      name: row.name,
      ownerId: row.owner_id,
      timeZone: row.timezone,
      target:
        row.kind === "question"
          ? { kind: "question", question: row.question ?? "", connectionIds: row.connection_ids }
          : { kind: "saved_query", savedQueryId: row.saved_query_id, parameters: row.parameters },
    }
  }

  /** Rejects with a unique violation (23505) when the name is taken in the workspace. */
  async insert(input: NewRoutine): Promise<string> {
    const target = targetColumns(input.target)
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO routines
         (workspace_id, owner_id, name, description, kind, saved_query_id, parameters, question,
          connection_ids, cron, timezone, enabled, paused_reason, next_run_at, delivery, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::timestamptz IS NOT NULL,
               CASE WHEN $12::timestamptz IS NULL THEN 'manual' END, $12, $13::jsonb, $2)
       RETURNING id`,
      [
        input.workspaceId,
        input.ownerId,
        input.name,
        input.description,
        input.target.kind,
        target.savedQueryId,
        JSON.stringify(target.parameters),
        target.question,
        target.connectionIds,
        input.cron,
        input.timeZone,
        input.nextRunAt,
        JSON.stringify(input.delivery),
      ],
    )
    const id = rows[0]?.id
    if (!id) throw new Error("A created routine was not returned")
    return id
  }

  /**
   * Saves changes made from `version`, under a row lock so the next run is
   * computed from the schedule being saved. Resuming (enabled: true) or a
   * new schedule on an enabled routine moves its next run to the schedule's
   * next slot after now; pausing clears it. May reject with a unique
   * violation like insert.
   */
  async update(
    workspaceId: string,
    viewerId: string,
    id: string,
    version: number,
    changes: RoutineChanges,
    nextRun: NextRun,
  ): Promise<VersionedSave<ViewedRoutine>> {
    const outcome = await this.transaction(async (client) => {
      const { rows } = await client.query<{
        version: number
        enabled: boolean
        cron: string
        timezone: string
      }>(
        `SELECT version, enabled, cron, timezone FROM routines
          WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [workspaceId, id],
      )
      const current = rows[0]
      if (!current) return "missing"
      if (current.version !== version) return "stale"
      const cron = changes.cron ?? current.cron
      const timeZone = changes.timeZone ?? current.timezone
      const enabled = changes.enabled ?? current.enabled
      const rescheduled = cron !== current.cron || timeZone !== current.timezone || !current.enabled
      const values: unknown[] = [workspaceId, id, viewerId]
      const param = (value: unknown) => `$${values.push(value)}`
      const set = ["version = version + 1", "updated_by = $3", "updated_at = now()"]
      if (changes.name !== undefined) set.push(`name = ${param(changes.name)}`)
      if (changes.description !== undefined) set.push(`description = ${param(changes.description)}`)
      if (changes.target !== undefined) {
        const target = targetColumns(changes.target)
        set.push(
          `kind = ${param(changes.target.kind)}`,
          `saved_query_id = ${param(target.savedQueryId)}`,
          `parameters = ${param(JSON.stringify(target.parameters))}::jsonb`,
          `question = ${param(target.question)}`,
          `connection_ids = ${param(target.connectionIds)}::uuid[]`,
        )
      }
      if (changes.cron !== undefined) set.push(`cron = ${param(changes.cron)}`)
      if (changes.timeZone !== undefined) set.push(`timezone = ${param(changes.timeZone)}`)
      if (changes.delivery !== undefined) {
        set.push(`delivery = ${param(JSON.stringify(changes.delivery))}::jsonb`)
      }
      if (!enabled) {
        set.push("enabled = false", "paused_reason = coalesce(paused_reason, 'manual')", "next_run_at = NULL")
      } else if (rescheduled) {
        set.push("enabled = true", "paused_reason = NULL", `next_run_at = ${param(nextRun(cron, timeZone))}`)
        if (!current.enabled) set.push("consecutive_failures = 0")
      }
      await client.query(`UPDATE routines SET ${set.join(", ")} WHERE workspace_id = $1 AND id = $2`, values)
      return "saved"
    })
    const record = outcome === "missing" ? null : await this.get(workspaceId, viewerId, id)
    if (!record) return { status: "missing" }
    return outcome === "stale" ? { status: "stale", current: record } : { status: "saved", record }
  }

  /** Pauses the routine (still for 'failures' if it paused itself); false when it does not exist. */
  async pause(workspaceId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE routines
          SET enabled = false, paused_reason = coalesce(paused_reason, 'manual'), next_run_at = NULL
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id],
    )
    return (rowCount ?? 0) > 0
  }

  /**
   * Resumes a paused routine at its schedule's next slot after now (slots
   * that passed while it was paused do not run), with its failure count
   * reset. A routine already running on schedule is left as it is.
   */
  async resume(workspaceId: string, id: string, nextRun: NextRun): Promise<boolean> {
    const found = await this.transaction(async (client) => {
      const { rows } = await client.query<{ enabled: boolean; cron: string; timezone: string }>(
        "SELECT enabled, cron, timezone FROM routines WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
        [workspaceId, id],
      )
      const current = rows[0]
      if (!current) return null
      if (!current.enabled) {
        await client.query(
          `UPDATE routines
              SET enabled = true, paused_reason = NULL, consecutive_failures = 0, next_run_at = $3
            WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, id, nextRun(current.cron, current.timezone)],
        )
      }
      return true
    })
    return found === true
  }

  /** Deletes the routine with its runs; its conversation stays, without the routine badge. */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM routines WHERE workspace_id = $1 AND id = $2", [
      workspaceId,
      id,
    ])
    return (rowCount ?? 0) > 0
  }

  /**
   * Claims up to `limit` routines due at `now` that no other transaction has
   * locked, and in the same transaction queues each one's run for the slot
   * `plan` picks (at most one per slot: a slot already run is skipped),
   * records a note for slots it missed, and moves next_run_at on. Returns the
   * runs queued, to start once committed.
   */
  async claimDue(now: Date, limit: number, plan: (routine: DueRoutine) => SlotPlan): Promise<QueuedRun[]> {
    const queued = await this.transaction(async (client) => {
      const { rows } = await client.query<{
        id: string
        workspace_id: string
        cron: string
        timezone: string
        next_run_at: Date
      }>(
        `SELECT id, workspace_id, cron, timezone, next_run_at FROM routines
          WHERE enabled AND next_run_at <= $1
          ORDER BY next_run_at
          LIMIT $2
            FOR UPDATE SKIP LOCKED`,
        [now, limit],
      )
      const runs: QueuedRun[] = []
      for (const row of rows) {
        let step: SlotPlan
        try {
          step = plan({
            id: row.id,
            workspaceId: row.workspace_id,
            cron: row.cron,
            timeZone: row.timezone,
            nextRunAt: row.next_run_at,
          })
        } catch (error) {
          // Saved schedules were checked with the same parser, so this needs a look. Pausing it
          // records why, and keeps it from being claimed (and taking a place) on every tick.
          console.error(`The schedule of routine ${row.id} could not be read, so it was paused`, error)
          await client.query(
            `INSERT INTO routine_runs
               (workspace_id, routine_id, trigger, scheduled_for, status, error, finished_at)
             VALUES ($1, $2, 'schedule', $3, 'failed', $4::jsonb, now())
             ON CONFLICT (routine_id, scheduled_for) WHERE trigger = 'schedule' DO NOTHING`,
            [row.workspace_id, row.id, row.next_run_at, JSON.stringify(UNREADABLE_SCHEDULE)],
          )
          await client.query(
            `UPDATE routines
                SET enabled = false, paused_reason = 'failures', next_run_at = NULL, last_status = 'failed',
                    consecutive_failures = consecutive_failures + 1
              WHERE workspace_id = $1 AND id = $2`,
            [row.workspace_id, row.id],
          )
          continue
        }
        if (step.missed) {
          await client.query(
            `INSERT INTO routine_runs
               (workspace_id, routine_id, trigger, scheduled_for, status, error, missed, finished_at)
             VALUES ($1, $2, 'schedule', $3, 'skipped', $4::jsonb, $5::jsonb, now())
             ON CONFLICT (routine_id, scheduled_for) WHERE trigger = 'schedule' DO NOTHING`,
            [
              row.workspace_id,
              row.id,
              step.missed.slots.first,
              JSON.stringify({ code: "MISSED_RUNS", message: step.missed.message }),
              JSON.stringify(step.missed.slots),
            ],
          )
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO routine_runs (workspace_id, routine_id, trigger, scheduled_for)
           VALUES ($1, $2, 'schedule', $3)
           ON CONFLICT (routine_id, scheduled_for) WHERE trigger = 'schedule' DO NOTHING
           RETURNING id`,
          [row.workspace_id, row.id, step.slot],
        )
        // A schedule with no slot left pauses (cron schedules that ran once always run again).
        await client.query(
          `UPDATE routines
              SET next_run_at = $3, enabled = $3::timestamptz IS NOT NULL,
                  paused_reason = CASE WHEN $3::timestamptz IS NULL THEN 'failures' END
            WHERE workspace_id = $1 AND id = $2`,
          [row.workspace_id, row.id, step.next],
        )
        const id = inserted.rows[0]?.id
        if (id) runs.push({ id, workspaceId: row.workspace_id, routineId: row.id })
      }
      return runs
    })
    return queued ?? []
  }

  /**
   * Queues a manual run of the routine. A mutation id the routine already
   * ran returns that run (created: false). Null when the routine is gone.
   */
  async insertManualRun(
    workspaceId: string,
    routineId: string,
    mutationId: string,
    requestedBy: string,
  ): Promise<{ id: string; created: boolean } | null> {
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO routine_runs (workspace_id, routine_id, trigger, mutation_id, requested_by)
       SELECT workspace_id, id, 'manual', $3, $4 FROM routines WHERE workspace_id = $1 AND id = $2
       ON CONFLICT (routine_id, mutation_id) DO NOTHING
       RETURNING id`,
      [workspaceId, routineId, mutationId, requestedBy],
    )
    const id = inserted.rows[0]?.id
    if (id) return { id, created: true }
    const found = await this.manualRunId(workspaceId, routineId, mutationId)
    return found ? { id: found, created: false } : null
  }

  /** The manual run a mutation id started, if any. */
  async manualRunId(workspaceId: string, routineId: string, mutationId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      "SELECT id FROM routine_runs WHERE workspace_id = $1 AND routine_id = $2 AND mutation_id = $3",
      [workspaceId, routineId, mutationId],
    )
    return rows[0]?.id ?? null
  }

  /** A queued run starts (its routine notes when it last ran); false when it is no longer queued. */
  async markRunning(workspaceId: string, runId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `WITH run AS (
         UPDATE routine_runs SET status = 'running', started_at = now()
          WHERE workspace_id = $1 AND id = $2 AND status = 'queued'
          RETURNING routine_id
       )
       UPDATE routines r SET last_run_at = now(), last_status = 'running'
         FROM run WHERE r.workspace_id = $1 AND r.id = run.routine_id`,
      [workspaceId, runId],
    )
    return (rowCount ?? 0) > 0
  }

  /** Links a question run's agent run while it is being answered. */
  async linkAgentRun(workspaceId: string, runId: string, agentRunId: string): Promise<void> {
    await this.pool.query("UPDATE routine_runs SET agent_run_id = $3 WHERE workspace_id = $1 AND id = $2", [
      workspaceId,
      runId,
      agentRunId,
    ])
  }

  /**
   * Records how a run ended, unless it already has (a restart marked it
   * interrupted meanwhile), and updates its routine: the last status, and the
   * failures in a row, which pause an enabled routine once they reach
   * ROUTINE_LIMITS.failuresBeforePause. A success resets them; skipped,
   * cancelled, and interrupted runs leave them as they are. Old finished runs
   * beyond ROUTINE_LIMITS.runsKept are pruned.
   */
  async finishRun(workspaceId: string, runId: string, outcome: RunOutcome): Promise<void> {
    // The counts read the routine row as locked by this update (not as the
    // statement began), so runs ending at the same time each count.
    const { rows } = await this.pool.query<{ routine_id: string }>(
      `WITH run AS (
         UPDATE routine_runs
            SET status = $3, error = $4::jsonb, execution_id = coalesce($5, execution_id), finished_at = now()
          WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running')
          RETURNING routine_id
       )
       UPDATE routines r
          SET last_status = $3,
              consecutive_failures = CASE $3 WHEN 'succeeded' THEN 0
                                             WHEN 'failed' THEN r.consecutive_failures + 1
                                             ELSE r.consecutive_failures END,
              enabled = r.enabled AND NOT ($3 = 'failed' AND r.consecutive_failures + 1 >= $6),
              paused_reason = CASE WHEN r.enabled AND $3 = 'failed' AND r.consecutive_failures + 1 >= $6
                                   THEN 'failures' ELSE r.paused_reason END,
              next_run_at = CASE WHEN $3 = 'failed' AND r.consecutive_failures + 1 >= $6
                                 THEN NULL ELSE r.next_run_at END
         FROM run
        WHERE r.workspace_id = $1 AND r.id = run.routine_id
        RETURNING r.id AS routine_id`,
      [
        workspaceId,
        runId,
        outcome.status,
        outcome.error ? JSON.stringify(outcome.error) : null,
        outcome.executionId ?? null,
        ROUTINE_LIMITS.failuresBeforePause,
      ],
    )
    const routineId = rows[0]?.routine_id
    if (!routineId) return
    await this.pool.query(
      `DELETE FROM routine_runs WHERE workspace_id = $1 AND id IN (
         SELECT id FROM routine_runs
          WHERE workspace_id = $1 AND routine_id = $2 AND status NOT IN ('queued', 'running')
          ORDER BY created_at DESC, id DESC
         OFFSET $3)`,
      [workspaceId, routineId, ROUTINE_LIMITS.runsKept],
    )
  }

  async getRun(workspaceId: string, viewerId: string, runId: string): Promise<RoutineRun | null> {
    const { rows } = await this.pool.query<RunRow>(
      `${RUN_SELECT} WHERE rr.workspace_id = $1 AND rr.id = $3`,
      [workspaceId, viewerId, runId],
    )
    return rows[0] ? toRun(rows[0]) : null
  }

  /** One page of the routine's runs, newest first; one more than `limit` tells whether more exist. */
  async runs(
    workspaceId: string,
    viewerId: string,
    routineId: string,
    page: { limit: number; offset: number },
  ): Promise<RoutineRun[]> {
    const { rows } = await this.pool.query<RunRow>(
      `${RUN_SELECT} WHERE rr.workspace_id = $1 AND rr.routine_id = $3 ${RUN_ORDER} LIMIT $4 OFFSET $5`,
      [workspaceId, viewerId, routineId, page.limit + 1, page.offset],
    )
    return rows.map(toRun)
  }

  /**
   * Startup maintenance across all workspaces: no run is being worked on
   * after a restart, so runs left queued or running become interrupted (and
   * are not retried, so a restart never repeats work). Their linked agent
   * runs and query executions are recovered by their own features.
   */
  async recoverAfterRestart(): Promise<number> {
    const error: RoutineRunError = {
      code: "ROUTINE_INTERRUPTED",
      message: "A restart of the backend interrupted this run. It is not retried automatically; run the routine now if you need its result.",
    }
    const { rows } = await this.pool.query<{ count: number }>(
      `WITH run AS (
         UPDATE routine_runs SET status = 'interrupted', error = $1::jsonb, finished_at = now()
          WHERE status IN ('queued', 'running')
          RETURNING workspace_id, routine_id
       ), noted AS (
         UPDATE routines r SET last_status = 'interrupted'
           FROM run
          WHERE r.workspace_id = run.workspace_id AND r.id = run.routine_id
            AND r.last_status IN ('queued', 'running')
       )
       SELECT count(*)::int AS count FROM run`,
      [JSON.stringify(error)],
    )
    return rows[0]?.count ?? 0
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
