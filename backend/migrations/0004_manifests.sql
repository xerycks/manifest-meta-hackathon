-- Source metadata (Cycle 06): the tables, views, columns, and relationships
-- discovered in a connection's selected schemas, plus the refresh runs that
-- discover them. Rows are matched by their natural keys on every refresh and
-- are never deleted when they disappear from the source: they are marked not
-- present, so ids (and the meaning users attach to them later) survive and
-- come back with the object. A refresh publishes all of its changes in one
-- transaction; until then readers keep seeing the previous metadata.

-- Lets feature tables pin workspace_id to their connection's workspace.
ALTER TABLE connections ADD CONSTRAINT connections_workspace_id_id_key UNIQUE (workspace_id, id);

CREATE TABLE manifest_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  schema_name text NOT NULL,
  object_name text NOT NULL,
  kind text NOT NULL
    CHECK (kind IN ('table', 'view', 'materialized_view', 'partitioned_table', 'foreign_table')),
  source_comment text,
  estimated_rows bigint,
  view_definition text,
  present boolean NOT NULL DEFAULT true,
  removed_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id) ON DELETE CASCADE,
  UNIQUE (connection_id, schema_name, object_name)
);

CREATE INDEX manifest_objects_workspace_idx ON manifest_objects (workspace_id, connection_id);

CREATE TABLE manifest_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES manifest_objects (id) ON DELETE CASCADE,
  name text NOT NULL,
  ordinal integer NOT NULL,
  data_type text NOT NULL,
  is_nullable boolean NOT NULL,
  default_value text,
  is_primary_key boolean NOT NULL DEFAULT false,
  enum_values text[],
  source_comment text,
  present boolean NOT NULL DEFAULT true,
  removed_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_id, name)
);

-- 'foreign_key' rows come from discovery; 'manual' rows are user-authored (Cycle 07)
-- and are never marked missing by a refresh.
CREATE TABLE manifest_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  origin text NOT NULL CHECK (origin IN ('foreign_key', 'manual')),
  constraint_name text,
  from_object_id uuid NOT NULL REFERENCES manifest_objects (id) ON DELETE CASCADE,
  from_columns text[] NOT NULL CHECK (cardinality(from_columns) > 0),
  to_object_id uuid NOT NULL REFERENCES manifest_objects (id) ON DELETE CASCADE,
  to_columns text[] NOT NULL CHECK (cardinality(to_columns) = cardinality(from_columns)),
  present boolean NOT NULL DEFAULT true,
  removed_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id) ON DELETE CASCADE,
  CHECK (origin = 'manual' OR constraint_name IS NOT NULL)
);

-- PostgreSQL constraint names are unique per table, so this is the natural key of a foreign key.
CREATE UNIQUE INDEX manifest_relationships_foreign_key_idx
  ON manifest_relationships (from_object_id, constraint_name) WHERE origin = 'foreign_key';
CREATE INDEX manifest_relationships_to_idx ON manifest_relationships (to_object_id);
CREATE INDEX manifest_relationships_workspace_idx ON manifest_relationships (workspace_id, connection_id);

CREATE TABLE manifest_refreshes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  trigger text NOT NULL CHECK (trigger IN ('manual', 'source_created', 'source_changed')),
  -- Last phase reached, kept after the run ends so a failure shows where it stopped.
  phase text CHECK (phase IN ('connecting', 'reading_objects', 'reading_columns', 'reading_relationships', 'publishing')),
  objects_done integer NOT NULL DEFAULT 0 CHECK (objects_done >= 0),
  objects_total integer CHECK (objects_total >= 0),
  -- Set when the run publishes: {objects, columns, relationships, objectsAdded, ...}.
  counts jsonb,
  error text CHECK (char_length(error) <= 500),
  triggered_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id) ON DELETE CASCADE
);

-- At most one queued or running refresh per connection.
CREATE UNIQUE INDEX manifest_refreshes_active_idx
  ON manifest_refreshes (connection_id) WHERE status IN ('queued', 'running');
CREATE INDEX manifest_refreshes_connection_idx ON manifest_refreshes (connection_id, created_at DESC);
