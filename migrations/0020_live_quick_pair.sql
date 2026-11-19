-- Independent live mailbox. Existing draft invitations remain in their original table.
CREATE TABLE IF NOT EXISTS beamsync_quick_pair_live_v14 (
  slot smallint PRIMARY KEY CHECK (slot BETWEEN 0 AND 63),
  room text NOT NULL CHECK (room ~ '^[0-9a-f]{32}$'),
  owner_hash text NOT NULL CHECK (owner_hash ~ '^[0-9a-f]{64}$'),
  guest_hash text NOT NULL CHECK (guest_hash ~ '^[0-9a-f]{64}$'),
  offer text NOT NULL CHECK (length(offer) BETWEEN 40 AND 65600),
  answer text CHECK (length(answer) BETWEEN 40 AND 65600),
  expires_at timestamptz NOT NULL
);
