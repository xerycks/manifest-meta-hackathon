-- Ask interface (Cycle 11): a run can pause for the user's answer to a
-- clarification, and a question can carry a few small text files that the
-- model reads through a tool. A run waiting for input is still active: it
-- holds its conversation, and a restart fails it like any other active run.

ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled'));
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_finished_check
  CHECK ((status IN ('queued', 'running', 'awaiting_input')) = (finished_at IS NULL));

-- The question the run is waiting on: {id, question, options, allowFreeText}; set only while awaiting_input.
ALTER TABLE agent_runs ADD COLUMN clarification jsonb;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_clarification_check
  CHECK ((status = 'awaiting_input') = (clarification IS NOT NULL));

DROP INDEX agent_runs_active_conversation_idx;
CREATE UNIQUE INDEX agent_runs_active_conversation_idx
  ON agent_runs (conversation_id) WHERE status IN ('queued', 'running', 'awaiting_input');
DROP INDEX agent_runs_active_idx;
CREATE INDEX agent_runs_active_idx
  ON agent_runs (status) WHERE status IN ('queued', 'running', 'awaiting_input');

ALTER TABLE agent_run_events DROP CONSTRAINT agent_run_events_type_check;
ALTER TABLE agent_run_events ADD CONSTRAINT agent_run_events_type_check CHECK (type IN (
  'run.started', 'tool.started', 'tool.finished', 'answer.delta', 'answer.completed',
  'clarification.requested', 'clarification.answered', 'run.failed', 'run.cancelled'));

-- Files sent with a question: at most 3 per run, UTF-8 text up to 256 KB each.
-- The model reads them (in bounded slices) for the rest of the conversation.
CREATE TABLE agent_run_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  -- The file's place among the run's files, as they were sent.
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  media_type text NOT NULL CHECK (media_type IN (
    'text/plain', 'text/csv', 'text/tab-separated-values', 'text/markdown', 'application/json')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144),
  content text NOT NULL CHECK (octet_length(content) = size_bytes),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, position)
);
