-- Conversation persistence and recovery (Cycle 12). Each run numbers its own
-- events (last_seq), so an event is written in the same statement as the state
-- change it describes, without gaps. A restart no longer fails active runs: runs
-- it left queued or running become 'interrupted' with a disposition saying how
-- to recover them, and a run waiting for the user's answer keeps a checkpoint of
-- its model conversation so it goes on once answered, also after a restart.
-- Asking is idempotent through a client-chosen mutation id, and a retried run
-- points at the run it retries (once).

ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check CHECK (status IN (
  'queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled', 'interrupted'));

-- How an interrupted run is recovered: 'retry' when it only read, 'reconcile'
-- when it started a tool with effects outside the run.
ALTER TABLE agent_runs ADD COLUMN disposition text CHECK (disposition IN ('retry', 'reconcile'));
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_interrupted_check
  CHECK ((status = 'interrupted') = (disposition IS NOT NULL));

-- The sequence number of the run's latest event; the next event takes the next number.
ALTER TABLE agent_runs ADD COLUMN last_seq integer NOT NULL DEFAULT 0 CHECK (last_seq >= 0);
UPDATE agent_runs r
   SET last_seq = coalesce((SELECT max(e.seq) FROM agent_run_events e WHERE e.run_id = r.id), 0);

-- What a waiting run needs to go on: the system prompt, the model messages so
-- far, and the turn's other tool results. json, not jsonb, so it is replayed to
-- the model exactly as it was written.
ALTER TABLE agent_runs ADD COLUMN checkpoint json
  CHECK (octet_length(checkpoint::text) <= 3000000);
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_checkpoint_waiting_check
  CHECK (checkpoint IS NULL OR status = 'awaiting_input');

-- A resubmitted question (same mutation id) returns the run it already started.
ALTER TABLE agent_runs ADD COLUMN mutation_id uuid;
CREATE UNIQUE INDEX agent_runs_mutation_idx ON agent_runs (user_id, mutation_id)
  WHERE mutation_id IS NOT NULL;

-- An interrupted run is retried at most once.
ALTER TABLE agent_runs ADD COLUMN retry_of uuid REFERENCES agent_runs (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX agent_runs_retry_idx ON agent_runs (retry_of) WHERE retry_of IS NOT NULL;

ALTER TABLE agent_run_events DROP CONSTRAINT agent_run_events_type_check;
ALTER TABLE agent_run_events ADD CONSTRAINT agent_run_events_type_check CHECK (type IN (
  'run.started', 'tool.started', 'tool.finished', 'answer.delta', 'answer.completed',
  'clarification.requested', 'clarification.answered', 'run.failed', 'run.cancelled',
  'run.interrupted'));

-- The conversation list pages by latest activity, then id.
DROP INDEX conversations_user_idx;
CREATE INDEX conversations_activity_idx
  ON conversations (workspace_id, user_id, updated_at DESC, id DESC);
