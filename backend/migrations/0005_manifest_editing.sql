-- Manifest editing and knowledge base (Cycle 07): meaning that people write
-- about their data. Labels, Markdown descriptions, and notes live next to the
-- discovered metadata on the same stable rows, but refresh publishing only
-- ever writes the discovered columns, so authored meaning survives refreshes
-- and stays on rows that disappear from the source (they are marked not
-- present, never deleted). Every editable row has a version counter: a save
-- names the version it started from and is rejected when someone saved since.

ALTER TABLE manifest_objects
  ADD COLUMN label text CHECK (char_length(label) <= 200),
  ADD COLUMN description text CHECK (char_length(description) <= 20000),
  -- What one row represents, e.g. 'one row per order line'.
  ADD COLUMN row_meaning text CHECK (char_length(row_meaning) <= 500),
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN edited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN edited_at timestamptz;

ALTER TABLE manifest_columns
  ADD COLUMN label text CHECK (char_length(label) <= 200),
  ADD COLUMN description text CHECK (char_length(description) <= 20000),
  ADD COLUMN unit text CHECK (char_length(unit) <= 100),
  -- Allowed or example values, e.g. 'ISO 4217 codes such as USD, EUR'.
  ADD COLUMN value_notes text CHECK (char_length(value_notes) <= 2000),
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN edited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN edited_at timestamptz;

-- Discovered foreign keys can carry a remark; manual rows also record who added them.
ALTER TABLE manifest_relationships
  ADD COLUMN remark text CHECK (char_length(remark) <= 1000),
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN edited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN edited_at timestamptz;

CREATE UNIQUE INDEX manifest_relationships_manual_idx
  ON manifest_relationships (from_object_id, from_columns, to_object_id, to_columns)
  WHERE origin = 'manual';

-- Business definitions such as 'active customer' or 'net revenue'. The optional
-- source link is checked against the entry's workspace when it is saved; when
-- the source is removed the entry stays and loses the link.
CREATE TABLE knowledge_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  connection_id uuid REFERENCES connections (id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 50000),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One entry per term in a workspace, regardless of case.
CREATE UNIQUE INDEX knowledge_entries_title_idx ON knowledge_entries (workspace_id, lower(title));
CREATE INDEX knowledge_entries_updated_idx ON knowledge_entries (workspace_id, updated_at DESC, id);
CREATE INDEX knowledge_entries_connection_idx ON knowledge_entries (connection_id);
