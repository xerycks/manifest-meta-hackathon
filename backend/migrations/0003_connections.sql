-- Source connections (Cycle 05): databases a workspace analyses.
-- config holds only non-secret settings (host, port, database, username,
-- sslMode). The password lives in sealed_secret as an AES-256-GCM envelope
-- bound to this row's workspace and id; it is never returned by the API.
-- 'mongodb' is reserved for the MongoDB adapter (Cycle 08).

CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  engine text NOT NULL CHECK (engine IN ('postgres', 'mongodb')),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  sealed_secret text,
  selected_schemas text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'connected', 'failed')),
  last_tested_at timestamptz,
  last_error text CHECK (char_length(last_error) <= 500),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Names are unique per workspace regardless of case; also serves workspace lookups.
CREATE UNIQUE INDEX connections_workspace_name_idx ON connections (workspace_id, lower(name));
