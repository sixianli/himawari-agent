CREATE TABLE vault_items (
  id TEXT PRIMARY KEY CHECK (length(id) = 25 AND id GLOB 'vi_*' AND substr(id, 4) NOT GLOB '*[^A-Za-z0-9_-]*'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
  origins TEXT NOT NULL CHECK (json_valid(origins) AND json_type(origins) = 'array'),
  fields TEXT NOT NULL CHECK (json_valid(fields) AND json_type(fields) = 'array'),
  version INTEGER NOT NULL CHECK (version >= 1),
  background_allowed INTEGER NOT NULL CHECK (background_allowed IN (0, 1)),
  wrapped_key TEXT NOT NULL CHECK (length(wrapped_key) = 80),
  ciphertexts TEXT NOT NULL CHECK (json_valid(ciphertexts) AND json_type(ciphertexts) = 'object'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX vault_items_scope_index ON vault_items(owner_id, agent_id, id);

CREATE TABLE vault_manifests (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  signature TEXT NOT NULL CHECK (length(signature) = 44),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (owner_id, agent_id)
) STRICT;

CREATE TABLE vault_release_requests (
  id TEXT PRIMARY KEY CHECK (length(id) = 25 AND id GLOB 'vr_*' AND substr(id, 4) NOT GLOB '*[^A-Za-z0-9_-]*'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 128),
  purpose TEXT NOT NULL CHECK (length(purpose) <= 300),
  item_ids TEXT NOT NULL CHECK (json_valid(item_ids) AND json_type(item_ids) = 'array'),
  item_versions TEXT NOT NULL CHECK (json_valid(item_versions) AND json_type(item_versions) = 'array'),
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 9 AND 300),
  page_version TEXT CHECK (page_version IS NULL OR length(page_version) BETWEEN 1 AND 128),
  ephemeral_public_key TEXT NOT NULL CHECK (length(ephemeral_public_key) = 88),
  nonce TEXT NOT NULL UNIQUE CHECK (length(nonce) = 43),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  decided_at TEXT CHECK (decided_at IS NULL OR decided_at GLOB '????-??-??T??:??:??.???Z'),
  device_id TEXT CHECK (device_id IS NULL OR length(device_id) BETWEEN 1 AND 128),
  CHECK ((status = 'pending') = (decided_at IS NULL))
) STRICT;

CREATE INDEX vault_release_requests_pending_index
  ON vault_release_requests(owner_id, agent_id, status, expires_at);

CREATE TABLE vault_usage (
  sequence INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK (length(request_id) = 25),
  item_id TEXT NOT NULL CHECK (length(item_id) = 25),
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 9 AND 300),
  outcome TEXT NOT NULL CHECK (length(outcome) BETWEEN 1 AND 32),
  at TEXT NOT NULL CHECK (at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX vault_usage_item_index ON vault_usage(owner_id, agent_id, item_id, sequence);
