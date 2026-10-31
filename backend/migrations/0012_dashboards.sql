-- Dashboards (Cycle 14): a named, ordered set of panels. Number and table
-- panels show a saved query's latest stored result; Markdown panels show their
-- own text. Visibility works like saved queries: everyone in the workspace, or
-- only the creator. version increases with every edit of the name,
-- description, or visibility so stale saves are rejected; panels have their own.

CREATE TABLE dashboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 5000),
  visibility text NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace', 'private')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

-- Names are unique per workspace regardless of case.
CREATE UNIQUE INDEX dashboards_name_idx ON dashboards (workspace_id, lower(name));
CREATE INDEX dashboards_list_idx ON dashboards (workspace_id, updated_at DESC, id);

-- config holds the kind's settings, validated by the application per kind.
-- Later kinds (charts) extend dashboard_panels_kind_check. Deleting a saved
-- query keeps its panels, with saved_query_id cleared: the panel then says its
-- saved query was removed until someone picks another or removes the panel.
-- Removing a source removes its saved queries, so the same applies. The size
-- check is a backstop above the largest config the application accepts (50
-- column names of 300 characters, each of which may take 6 bytes escaped).
CREATE TABLE dashboard_panels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  kind text NOT NULL,
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
  saved_query_id uuid REFERENCES saved_queries (id) ON DELETE SET NULL,
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 100000),
  -- Order on the dashboard, from 0; cycle 15 adds a grid layout.
  position integer NOT NULL CHECK (position >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, dashboard_id) REFERENCES dashboards (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT dashboard_panels_kind_check CHECK (kind IN ('number', 'table', 'markdown')),
  -- Markdown panels never show a saved query.
  CONSTRAINT dashboard_panels_saved_query_check CHECK (kind <> 'markdown' OR saved_query_id IS NULL)
);

CREATE INDEX dashboard_panels_order_idx ON dashboard_panels (workspace_id, dashboard_id, position, created_at);
CREATE INDEX dashboard_panels_saved_query_idx
  ON dashboard_panels (saved_query_id) WHERE saved_query_id IS NOT NULL;
