-- Sessions also end after a period of inactivity (SESSION_IDLE_HOURS, default 24), not only after 7 days.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
