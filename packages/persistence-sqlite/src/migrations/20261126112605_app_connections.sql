CREATE TABLE app_connections (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64 AND name GLOB '[a-z]*' AND name NOT GLOB '*[^a-z0-9_]*'),
  tokens_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs_reconnect')),
  connected_at TEXT NOT NULL CHECK (connected_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (owner_id, agent_id, name)
) STRICT;
