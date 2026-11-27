CREATE TABLE mcp_oauth_clients (
  client_id TEXT PRIMARY KEY CHECK (length(client_id) BETWEEN 1 AND 512),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  registration TEXT NOT NULL CHECK (length(registration) BETWEEN 1 AND 32),
  client_name TEXT NOT NULL CHECK (length(client_name) BETWEEN 1 AND 128),
  redirect_uris TEXT NOT NULL CHECK (
    json_valid(redirect_uris) AND json_type(redirect_uris) = 'array'
  ),
  connection_id TEXT UNIQUE REFERENCES mcp_connections(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX mcp_oauth_clients_scope_index
  ON mcp_oauth_clients(owner_id, agent_id, connection_id, created_at);

CREATE TABLE mcp_oauth_tokens (
  token_sha256 TEXT PRIMARY KEY CHECK (
    length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 16),
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 512),
  family_id TEXT NOT NULL CHECK (length(family_id) BETWEEN 1 AND 64),
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  resource TEXT NOT NULL CHECK (length(resource) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  used_at TEXT CHECK (used_at IS NULL OR used_at GLOB '????-??-??T??:??:??.???Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX mcp_oauth_tokens_family_index ON mcp_oauth_tokens(owner_id, agent_id, family_id);
CREATE INDEX mcp_oauth_tokens_connection_index
  ON mcp_oauth_tokens(owner_id, agent_id, connection_id);
CREATE INDEX mcp_oauth_tokens_expiry_index ON mcp_oauth_tokens(owner_id, agent_id, expires_at);
