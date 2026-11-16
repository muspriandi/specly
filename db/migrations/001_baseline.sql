-- 001 baseline: the schema as it stood when migrations were introduced.
-- Every statement is idempotent, so this is also safe on a database that was created by the old schema.sql: it changes
-- nothing there and simply gets recorded as applied. New changes go in new files (002_*.sql, 003_*.sql, ...):
-- see `npm run migrate:new -- <name>` and the "Database migrations" section of the README. Never edit an applied migration.

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

-- Where and when each session started, so people can see and end their own devices (account menu > Active sessions).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;

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

-- Two-factor sign-in (TOTP). totp_secret with no totp_enabled_at is a setup that was started but not confirmed.
-- recovery_codes holds hashes of the unused single-use codes; totp_last_step stops a code being used twice.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_codes TEXT[];
-- A password-correct login that still needs its second factor waits here for a few minutes (type 'login2fa').
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='tokens'::regclass AND conname='tokens_type_check' AND pg_get_constraintdef(oid) LIKE '%login2fa%') THEN
    ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_type_check;
    ALTER TABLE tokens ADD CONSTRAINT tokens_type_check CHECK (type IN ('invite','reset','login2fa'));
  END IF;
END $$;

-- An invitation can also carry the role the new account gets and the blueprints assigned to it on acceptance.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS role TEXT CHECK (role IN ('member','guest'));
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS blueprint_ids INT[];

CREATE TABLE IF NOT EXISTS blueprints (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  version TEXT,
  description TEXT,
  format TEXT NOT NULL CHECK (format IN ('yaml','json')),
  spec JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Flattened operations, used by search.
-- The primary key also serves "all endpoints of a blueprint" (its first column), so there is no separate index for that.
CREATE TABLE IF NOT EXISTS endpoints (
  blueprint_id INT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  summary TEXT,
  operation_id TEXT,
  tag TEXT,
  deprecated BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (blueprint_id, method, path)
);
-- Older databases: add the column nullable; bootstrap.js fills it in and then makes it NOT NULL (see backfillDeprecated).
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS deprecated BOOLEAN;
-- x-status (WIP, beta…): '' = none, NULL = not indexed yet (bootstrap.js backfillStatus fills it in).
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS status TEXT;
-- Older databases: replace the unused serial id with the natural key (skipped, with a notice, if duplicates exist).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='endpoints' AND column_name='id') THEN
    IF EXISTS (SELECT 1 FROM endpoints GROUP BY blueprint_id, method, path HAVING count(*) > 1) THEN
      RAISE NOTICE 'endpoints key migration skipped: duplicate (blueprint, method, path) rows exist';
    ELSE
      ALTER TABLE endpoints DROP CONSTRAINT IF EXISTS endpoints_pkey;
      ALTER TABLE endpoints DROP COLUMN id;
      ALTER TABLE endpoints ADD PRIMARY KEY (blueprint_id, method, path);
    END IF;
  END IF;
END $$;
DROP INDEX IF EXISTS idx_endpoints_bp;

CREATE TABLE IF NOT EXISTS access_requests (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blueprint_id INT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by INT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_requests_user ON access_requests(user_id, blueprint_id);


-- Share links: read-only access to one blueprint for people without an account, until they expire or are revoked.
-- Only the hash of the token is stored.
CREATE TABLE IF NOT EXISTS share_links (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  blueprint_id INT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  label TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_share_bp ON share_links (blueprint_id);

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
-- (No index on "at": the log is read newest-first by id.)
DROP INDEX IF EXISTS idx_audit_at;
-- Serves the group filter (action LIKE 'request.%') under any database collation, which a plain btree does not.
CREATE INDEX IF NOT EXISTS idx_audit_action_prefix ON audit_log (action text_pattern_ops);
DROP INDEX IF EXISTS idx_audit_action;

-- ---- Indexes added for the hot paths (all idempotent) ----
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);            -- end all sessions of a user, cascade deletes
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);      -- hourly purge
-- (No index on tokens.expires_at: the table only holds outstanding links, so the hourly purge scans a handful of rows.)
DROP INDEX IF EXISTS idx_tokens_expires;
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
  CREATE INDEX IF NOT EXISTS idx_endpoints_opid_trgm ON endpoints USING gin (operation_id gin_trgm_ops);
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
-- Only rewritten when it does not list 'cancelled' yet: re-adding a constraint locks and re-checks the whole table.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='access_requests'::regclass AND conname='access_requests_status_check'
                 AND pg_get_constraintdef(oid) LIKE '%cancelled%') THEN
    ALTER TABLE access_requests DROP CONSTRAINT IF EXISTS access_requests_status_check;
    ALTER TABLE access_requests ADD CONSTRAINT access_requests_status_check CHECK (status IN ('pending','approved','rejected','cancelled'));
  END IF;
END $$;

-- ---- Trim: columns nobody read (history lives in blueprint_versions, whose first row has the author and date) ----
-- Kept after the source-column migration above, which still copies them for very old databases.
ALTER TABLE blueprints DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS created_at;

-- ---- Compression: every revision stores the whole document, so these grow fastest. lz4 is quicker than the
-- default and only applies to newly written values (PostgreSQL 14+ built with lz4; otherwise left alone). ----
DO $$ BEGIN
  IF current_setting('server_version_num')::int >= 140000
     AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='blueprint_versions'::regclass AND attname='source' AND attcompression <> 'l') THEN
    ALTER TABLE blueprint_versions ALTER COLUMN source SET COMPRESSION lz4;
    ALTER TABLE blueprints ALTER COLUMN spec SET COMPRESSION lz4;
  END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'lz4 compression not applied: %', SQLERRM;
END $$;
