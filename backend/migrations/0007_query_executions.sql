-- Controlled query execution (Cycle 09): one row per read query run against
-- a source, whatever started it. The id comes from the client, so a cancel
-- can name a request that is still running; it is unique per workspace.
-- query, error, and result are json rather than jsonb because MongoDB strings
-- may hold NUL characters, which jsonb rejects. result keeps a bounded
-- snapshot of the rows ({columns, rows}: at most 1,000 rows and about 2 MB)
-- as evidence and for reopening; row_count says how many the query returned.
-- History is pruned per workspace, and a backend restart marks rows it left
-- running as failed.

CREATE TABLE query_executions (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  origin text NOT NULL CHECK (origin IN ('console', 'agent', 'saved_query', 'dashboard', 'routine')),
  language text NOT NULL CHECK (language IN ('sql', 'mongodb')),
  query json NOT NULL CHECK (octet_length(query::text) <= 300000),
  max_rows integer NOT NULL CHECK (max_rows BETWEEN 1 AND 5000),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 60000),
  status text NOT NULL
    CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'rejected')),
  row_count integer CHECK (row_count >= 0),
  truncated boolean NOT NULL DEFAULT false,
  truncated_by text CHECK (truncated_by IN ('rows', 'bytes')),
  duration_ms integer CHECK (duration_ms >= 0),
  -- {code, message, reason, name}: written by Manifest, never a raw driver error.
  error json,
  result json,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id) ON DELETE CASCADE,
  CHECK ((status = 'running') = (finished_at IS NULL))
);

CREATE INDEX query_executions_history_idx
  ON query_executions (workspace_id, connection_id, created_at DESC);
CREATE INDEX query_executions_workspace_idx ON query_executions (workspace_id, created_at DESC);
CREATE INDEX query_executions_running_idx ON query_executions (status) WHERE status = 'running';
