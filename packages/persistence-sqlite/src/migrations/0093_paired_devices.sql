CREATE TABLE paired_devices (
  id TEXT PRIMARY KEY CHECK (length(id) = 26 AND substr(id, 1, 4) = 'dev_'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('iphone', 'watch', 'mac')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  release_channel TEXT NOT NULL CHECK (release_channel IN ('direct', 'testflight', 'app_store', 'mac_direct')),
  device_public_key TEXT NOT NULL CHECK (length(device_public_key) BETWEEN 1 AND 256),
  confirm_public_key TEXT NOT NULL CHECK (length(confirm_public_key) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  supported_actions TEXT NOT NULL CHECK (json_valid(supported_actions) AND json_type(supported_actions) = 'array'),
  web_device_id TEXT REFERENCES devices(id),
  web_session_id TEXT REFERENCES product_sessions(id),
  paired_at TEXT NOT NULL CHECK (paired_at GLOB '????-??-??T??:??:??.???Z'),
  confirmed_at TEXT CHECK (confirmed_at IS NULL OR confirmed_at GLOB '????-??-??T??:??:??.???Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.???Z'),
  last_seen_at TEXT CHECK (last_seen_at IS NULL OR last_seen_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (status <> 'active' OR (confirmed_at IS NOT NULL AND web_device_id IS NOT NULL AND web_session_id IS NOT NULL)),
  CHECK ((web_device_id IS NULL) = (web_session_id IS NULL)),
  CHECK (device_public_key <> confirm_public_key)
) STRICT;

CREATE INDEX paired_devices_scope_index ON paired_devices(owner_id, agent_id, status, paired_at);

CREATE TABLE device_pairing_codes (
  code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  used_at TEXT CHECK (used_at IS NULL OR used_at GLOB '????-??-??T??:??:??.???Z'),
  device_id TEXT REFERENCES paired_devices(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX device_pairing_codes_expiry_index ON device_pairing_codes(expires_at);

CREATE TABLE device_request_nonces (
  device_id TEXT NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 16 AND 64),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (device_id, nonce)
) STRICT;

CREATE INDEX device_request_nonces_expiry_index ON device_request_nonces(device_id, expires_at);
