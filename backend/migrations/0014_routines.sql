-- Scheduled routines (Cycle 16): a saved query or a question that runs on a
-- 5-field cron schedule in a time zone, as its owner, with a history of every
-- run. next_run_at is the next slot to run (null while paused). Any backend
-- instance may claim a due routine (SELECT ... FOR UPDATE SKIP LOCKED), and the
-- unique slot index keeps one slot from running twice. A question routine
-- answers in one conversation per routine, which the Ask list marks as its own.

CREATE TABLE routines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Runs act as this user; null once the user is deleted, and runs then fail.
  owner_id uuid REFERENCES users (id) ON DELETE SET NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 5000),
  kind text NOT NULL CHECK (kind IN ('saved_query', 'question')),
  -- Null once the saved query is deleted, and runs then fail. Single-column FK
  -- (as on dashboard panels); the app checks the workspace and joins on it.
  saved_query_id uuid REFERENCES saved_queries (id) ON DELETE SET NULL,
  -- Values by parameter name for every run, in place of the saved query's defaults.
  parameters jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(parameters) = 'object'),
  question text CHECK (char_length(question) BETWEEN 1 AND 4000),
  -- The sources the question may use; empty means every source of the workspace.
  connection_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(connection_ids) <= 10),
  cron text NOT NULL CHECK (char_length(cron) BETWEEN 9 AND 120),
  -- IANA name the schedule is read in.
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 64),
  enabled boolean NOT NULL DEFAULT true,
  paused_reason text CHECK (paused_reason IN ('manual', 'failures')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text CHECK (last_status IN (
    'queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'interrupted')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- Where results go: {"channel": "in_app"} until other channels exist.
  delivery jsonb NOT NULL DEFAULT '{"channel": "in_app"}' CHECK (jsonb_typeof(delivery) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CONSTRAINT routines_target_check CHECK (
    CASE kind
      WHEN 'question' THEN question IS NOT NULL AND saved_query_id IS NULL AND parameters = '{}'
      ELSE question IS NULL AND connection_ids = '{}'
    END),
  CONSTRAINT routines_paused_check CHECK (enabled = (paused_reason IS NULL)),
  CONSTRAINT routines_next_run_check CHECK (enabled = (next_run_at IS NOT NULL))
);

-- Names are unique per workspace regardless of case.
CREATE UNIQUE INDEX routines_name_idx ON routines (workspace_id, lower(name));
CREATE INDEX routines_due_idx ON routines (next_run_at) WHERE enabled;
CREATE INDEX routines_saved_query_idx ON routines (saved_query_id) WHERE saved_query_id IS NOT NULL;

CREATE TABLE routine_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  routine_id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  -- The schedule slot the run is for; null for manual runs.
  scheduled_for timestamptz,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'interrupted')),
  -- The saved query's execution (no FK: history pruning may remove it), or the question's agent run.
  execution_id uuid,
  agent_run_id uuid REFERENCES agent_runs (id) ON DELETE SET NULL,
  -- {code, message}: written by Manifest, never a raw driver or provider error.
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  -- On the one skipped run that notes the slots missed while no backend ran: {count, more, first, last}.
  missed jsonb CHECK (missed IS NULL OR jsonb_typeof(missed) = 'object'),
  -- Chosen by the client for a manual run, so sending it again returns the same run.
  mutation_id uuid,
  requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  FOREIGN KEY (workspace_id, routine_id) REFERENCES routines (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT routine_runs_slot_check CHECK (
    CASE trigger
      WHEN 'schedule' THEN scheduled_for IS NOT NULL AND mutation_id IS NULL
      ELSE scheduled_for IS NULL AND mutation_id IS NOT NULL
    END),
  CONSTRAINT routine_runs_finished_check CHECK ((status IN ('queued', 'running')) = (finished_at IS NULL))
);

-- One run per schedule slot, whichever backend claims it.
CREATE UNIQUE INDEX routine_runs_slot_idx ON routine_runs (routine_id, scheduled_for)
  WHERE trigger = 'schedule';
CREATE UNIQUE INDEX routine_runs_mutation_idx ON routine_runs (routine_id, mutation_id);
CREATE INDEX routine_runs_history_idx ON routine_runs (workspace_id, routine_id, created_at DESC, id DESC);
CREATE INDEX routine_runs_active_idx ON routine_runs (status) WHERE status IN ('queued', 'running');

-- A question routine's conversation; the Ask list badges it.
ALTER TABLE conversations ADD COLUMN routine_id uuid REFERENCES routines (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX conversations_routine_idx ON conversations (routine_id) WHERE routine_id IS NOT NULL;
