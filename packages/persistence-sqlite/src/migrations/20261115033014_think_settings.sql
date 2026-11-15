CREATE TABLE think_settings (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  overrides TEXT NOT NULL CHECK (json_valid(overrides) AND json_type(overrides) = 'object'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (owner_id, agent_id)
) STRICT;
