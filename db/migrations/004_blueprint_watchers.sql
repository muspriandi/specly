-- People who asked to be emailed when a blueprint is published.
CREATE TABLE IF NOT EXISTS blueprint_watchers (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blueprint_id INT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blueprint_id)
);
CREATE INDEX IF NOT EXISTS idx_watchers_bp ON blueprint_watchers (blueprint_id);
