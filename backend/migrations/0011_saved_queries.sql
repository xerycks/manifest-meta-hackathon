-- Saved queries (Cycle 13): a read query kept with its source, name, Markdown
-- description, and date parameter definitions, so anyone it is visible to can
-- reopen and rerun it. query is the read-query contract with {{name}} (SQL) or
-- {"$param": "name"} (MongoDB) placeholders; it is json like the executions'
-- query, so MongoDB strings may hold NUL characters. origin records the answer
-- and execution it was saved from. version increases with every edit so stale
-- saves are rejected. last_execution_id is the latest succeeded run, kept pinned
-- so its result stays openable; removing the source removes its saved queries.

CREATE TABLE saved_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 20000),
  query json NOT NULL CHECK (octet_length(query::text) <= 300000),
  -- [{name, label, type, default, required}]
  parameters jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(parameters) = 'array'),
  visibility text NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace', 'private')),
  -- {runId, executionId} when saved from an answer's evidence.
  origin jsonb CHECK (origin IS NULL OR jsonb_typeof(origin) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_execution_id uuid,
  last_run_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id) ON DELETE CASCADE
);

-- Names are unique per workspace regardless of case.
CREATE UNIQUE INDEX saved_queries_name_idx ON saved_queries (workspace_id, lower(name));
CREATE INDEX saved_queries_list_idx ON saved_queries (workspace_id, updated_at DESC, id);
CREATE INDEX saved_queries_connection_idx ON saved_queries (workspace_id, connection_id);

-- Each saved query's runs, with the parameter values they resolved to.
ALTER TABLE query_executions
  ADD COLUMN saved_query_id uuid REFERENCES saved_queries (id) ON DELETE SET NULL;
ALTER TABLE query_executions
  ADD COLUMN parameters jsonb CHECK (parameters IS NULL OR jsonb_typeof(parameters) = 'object');
CREATE INDEX query_executions_saved_query_idx
  ON query_executions (saved_query_id, created_at DESC) WHERE saved_query_id IS NOT NULL;
