-- Agent runtime (Cycle 10): conversations, the question runs inside them, and
-- each run's ordered events. Conversations and runs are private to the user
-- who created them. A run keeps its structured answer (Markdown plus the
-- evidence it cites), a safe error, token usage, and a bounded transcript of
-- the model messages so later cycles can resume or inspect it. Only one run
-- per conversation may be active, and a backend restart fails runs it left
-- queued or running.

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The first question, trimmed to 120 characters.
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX conversations_user_idx ON conversations (workspace_id, user_id, updated_at DESC);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 4000),
  -- The sources the question may use; empty means every source of the workspace.
  connection_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(connection_ids) <= 10),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 120),
  -- {markdown, status, missing, evidence: [{executionId, label, columns, rows, ...}]}
  answer jsonb,
  -- {code, message}: written by Manifest, never a raw provider or driver error.
  error jsonb,
  usage jsonb NOT NULL DEFAULT '{"inputTokens": 0, "outputTokens": 0}',
  steps integer NOT NULL DEFAULT 0 CHECK (steps >= 0),
  transcript jsonb NOT NULL DEFAULT '[]' CHECK (octet_length(transcript::text) <= 2000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES conversations (workspace_id, id) ON DELETE CASCADE,
  CHECK ((status IN ('queued', 'running')) = (finished_at IS NULL))
);

CREATE UNIQUE INDEX agent_runs_active_conversation_idx
  ON agent_runs (conversation_id) WHERE status IN ('queued', 'running');
CREATE INDEX agent_runs_conversation_idx ON agent_runs (workspace_id, conversation_id, created_at);
CREATE INDEX agent_runs_active_idx ON agent_runs (status) WHERE status IN ('queued', 'running');

-- Ordered per run by seq, so a client can read the events after the last one it saw.
CREATE TABLE agent_run_events (
  run_id uuid NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 1),
  type text NOT NULL CHECK (type IN (
    'run.started', 'tool.started', 'tool.finished', 'answer.delta', 'answer.completed',
    'run.failed', 'run.cancelled')),
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

-- Executions an answer cites stay openable: history pruning skips pinned ones.
ALTER TABLE query_executions ADD COLUMN pinned boolean NOT NULL DEFAULT false;
