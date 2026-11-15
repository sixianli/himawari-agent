CREATE TABLE delivery_timing_settings (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  overrides TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(overrides)),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id)
) STRICT;
