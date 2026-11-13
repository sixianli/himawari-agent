CREATE TABLE mcp_connections (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 1 AND 128 AND id GLOB '[A-Za-z0-9]*' AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  secret_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(secret_sha256) = 64 AND secret_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  capabilities TEXT NOT NULL CHECK (
    json_valid(capabilities) AND json_type(capabilities) = 'array'
  ),
  read_ceiling TEXT NOT NULL CHECK (read_ceiling IN ('public', 'private', 'sensitive')),
  push_policy TEXT NOT NULL CHECK (push_policy IN ('ask', 'direct')),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked')),
  reported_client TEXT CHECK (reported_client IS NULL OR length(reported_client) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  secret_rotated_at TEXT CHECK (
    secret_rotated_at IS NULL OR secret_rotated_at GLOB '????-??-??T??:??:??.???Z'
  ),
  last_seen_at TEXT CHECK (last_seen_at IS NULL OR last_seen_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX mcp_connections_scope_index ON mcp_connections(owner_id, agent_id, created_at, id);

CREATE TABLE mcp_connection_usage_daily (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  tool TEXT NOT NULL CHECK (length(tool) BETWEEN 1 AND 64),
  entry TEXT NOT NULL CHECK (entry IN ('oauth', 'service_token')),
  auto INTEGER NOT NULL CHECK (auto IN (0, 1)),
  counter TEXT NOT NULL CHECK (length(counter) BETWEEN 1 AND 64),
  value INTEGER NOT NULL CHECK (value >= 0),
  PRIMARY KEY (owner_id, agent_id, connection_id, day, tool, entry, auto, counter)
) STRICT;

CREATE INDEX mcp_connection_usage_daily_day_index
  ON mcp_connection_usage_daily(owner_id, agent_id, day);
CREATE INDEX mcp_connection_usage_daily_connection_index
  ON mcp_connection_usage_daily(connection_id);
