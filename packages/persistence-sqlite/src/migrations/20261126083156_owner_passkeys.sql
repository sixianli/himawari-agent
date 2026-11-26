CREATE TABLE owner_passkeys (
  credential_id TEXT PRIMARY KEY CHECK (length(credential_id) BETWEEN 16 AND 1366 AND credential_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL CHECK (length(public_key) BETWEEN 16 AND 2048 AND public_key NOT GLOB '*[^A-Za-z0-9_-]*'),
  sign_count INTEGER NOT NULL CHECK (sign_count >= 0),
  transports TEXT NOT NULL CHECK (json_valid(transports) AND json_type(transports) = 'array'),
  backed_up INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  last_used_at TEXT CHECK (last_used_at IS NULL OR last_used_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX owner_passkeys_owner_index ON owner_passkeys(owner_id, agent_id, created_at);

CREATE TABLE sign_in_setup_code_uses (
  code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES owner_passkeys(credential_id) ON DELETE CASCADE,
  used_at TEXT NOT NULL CHECK (used_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

DROP TABLE device_pairing_codes;
