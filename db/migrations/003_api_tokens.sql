-- Tokens that let a CI pipeline publish one blueprint (PUT /api/v1/blueprints/:id). Only a hash is stored.
CREATE TABLE IF NOT EXISTS api_tokens (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  blueprint_id INT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_bp ON api_tokens (blueprint_id);
