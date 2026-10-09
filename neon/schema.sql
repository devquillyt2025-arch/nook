-- Nook cloud data store
-- Run once against your Neon database to initialise the schema.

CREATE TABLE IF NOT EXISTS nook_data (
  user_id TEXT      NOT NULL,
  key     TEXT      NOT NULL,
  value   JSONB     NOT NULL DEFAULT 'null'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_nook_data_user ON nook_data (user_id);
