-- Time-limited access: an approved assignment can end on its own (NULL = no end).
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
