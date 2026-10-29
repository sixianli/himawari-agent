CREATE TABLE memory_profile_pins (
  memory_id TEXT PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX memory_profile_pins_scope_index ON memory_profile_pins(owner_id, agent_id);

ALTER TABLE memory_settings ADD COLUMN last_viewed_at TEXT;
