CREATE TABLE IF NOT EXISTS beamsync_signals (
  room_id TEXT NOT NULL,
  role TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, role),
  CONSTRAINT beamsync_signals_room_id_chk CHECK (room_id ~ '^[a-f0-9]{32}$'),
  CONSTRAINT beamsync_signals_role_chk CHECK (role IN ('offer','answer','restart_offer','restart_answer')),
  CONSTRAINT beamsync_signals_payload_len_chk CHECK (char_length(payload) BETWEEN 20 AND 65536)
);

CREATE INDEX IF NOT EXISTS beamsync_signals_expires_idx ON beamsync_signals (expires_at);