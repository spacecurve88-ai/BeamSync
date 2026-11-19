-- Optional package: owner cancellation stays inaccessible until expiry.
ALTER TABLE IF EXISTS beamsync_quick_pair_v14
  ADD COLUMN IF NOT EXISTS canceled boolean NOT NULL DEFAULT false;
