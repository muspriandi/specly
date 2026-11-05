-- Idempotent: safe to run on every start.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member','guest')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

-- One-time tokens for guest invitations and password resets.
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('invite','reset')),
  email TEXT NOT NULL,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  invited_by INT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blueprints (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  version TEXT,
  description TEXT,
  format TEXT NOT NULL CHECK (format IN ('yaml','json')),
  spec JSONB NOT NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Flattened operations, used by search.
CREATE TABLE IF NOT EXISTS endpoints (
  id SERIAL PRIMARY KEY,
  blueprint_id INT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  summary TEXT,
  operation_id TEXT,
  tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_endpoints_bp ON endpoints(blueprint_id);

CREATE TABLE IF NOT EXISTS access_requests (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blueprint_id INT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by INT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_requests_user ON access_requests(user_id, blueprint_id);


-- Every saved state of a blueprint, newest = highest version_no.
CREATE TABLE IF NOT EXISTS blueprint_versions (
  id SERIAL PRIMARY KEY,
  blueprint_id INT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  version_no INT NOT NULL,
  title TEXT NOT NULL,
  version TEXT,
  format TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (blueprint_id, version_no)
);

-- Append-only record of who did what. actor_label survives user deletion.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id INT REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);

-- ---- Indexes added for the hot paths (all idempotent) ----
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);            -- end all sessions of a user, cascade deletes
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);      -- hourly purge
CREATE INDEX IF NOT EXISTS idx_tokens_expires ON tokens (expires_at);          -- hourly purge
CREATE INDEX IF NOT EXISTS idx_tokens_email ON tokens (type, email);           -- "newest link wins" replace
CREATE INDEX IF NOT EXISTS idx_requests_bp ON access_requests (blueprint_id);  -- cascade deletes, per-blueprint counts
CREATE INDEX IF NOT EXISTS idx_requests_pending ON access_requests (created_at) WHERE status = 'pending'; -- header badge + review queue
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_id);
CREATE INDEX IF NOT EXISTS idx_blueprints_title ON blueprints (lower(title));

-- A user can hold at most one live (pending or approved) request per blueprint, even under concurrent clicks.
-- Skipped (not fatal) if old data already contains duplicates.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_requests_live ON access_requests (user_id, blueprint_id) WHERE status IN ('pending','approved');
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'uq_requests_live skipped: duplicate live requests exist';
END $$;

-- Substring search (ILIKE '%x%') on endpoints uses trigram indexes when the extension is available.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS idx_endpoints_path_trgm ON endpoints USING gin (path gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_endpoints_summary_trgm ON endpoints USING gin (summary gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_trgm unavailable, search falls back to sequential scan';
END $$;

-- Migration: the raw text now lives only in blueprint_versions (latest row = current). Older databases still have
-- blueprints.source: give blueprints without a revision a v1 from it, then drop the duplicate column.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='blueprints' AND column_name='source') THEN
    INSERT INTO blueprint_versions (blueprint_id, version_no, title, version, format, source, note, created_by, created_at)
    SELECT b.id, 1, b.title, b.version, b.format, b.source, 'Initial version', b.created_by, b.created_at
    FROM blueprints b WHERE NOT EXISTS (SELECT 1 FROM blueprint_versions v WHERE v.blueprint_id=b.id);
    ALTER TABLE blueprints DROP COLUMN source;
  END IF;
END $$;

-- ---- Soft delete ----
-- Deleted users/blueprints keep their row (and history) but are hidden everywhere; admins can restore them from the trash.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE blueprints ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- An email is unique among live accounts only, so a deleted user's address can be invited or registered again.
DROP INDEX IF EXISTS users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_live ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_blueprints_deleted ON blueprints (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_deleted ON users (deleted_at) WHERE deleted_at IS NOT NULL;
-- Requests still pending when their user or blueprint is deleted become 'cancelled'.
ALTER TABLE access_requests DROP CONSTRAINT IF EXISTS access_requests_status_check;
ALTER TABLE access_requests ADD CONSTRAINT access_requests_status_check CHECK (status IN ('pending','approved','rejected','cancelled'));
