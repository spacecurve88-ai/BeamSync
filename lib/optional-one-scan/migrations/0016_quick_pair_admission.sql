-- Optional package admission quota.
ALTER TABLE beamsync_quick_pair_v14 ADD COLUMN IF NOT EXISTS source_hash text
  CHECK (source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$');
CREATE INDEX IF NOT EXISTS beamsync_quick_pair_v14_source_expiry
  ON beamsync_quick_pair_v14 (source_hash, expires_at);
