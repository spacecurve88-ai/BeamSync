-- Closed invitations remain as inaccessible tombstones until their original expiry.
ALTER TABLE IF EXISTS beamsync_quick_pair_v14
  ADD COLUMN IF NOT EXISTS canceled boolean NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS beamsync_quick_pair_live_v14
  ADD COLUMN IF NOT EXISTS canceled boolean NOT NULL DEFAULT false;
