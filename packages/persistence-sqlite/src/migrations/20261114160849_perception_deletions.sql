CREATE TABLE perception_deletions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 64),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'verified')),
  target TEXT NOT NULL CHECK (json_valid(target) AND json_type(target) = 'object'),
  bound_ms INTEGER NOT NULL CHECK (bound_ms >= 0),
  plan TEXT NOT NULL CHECK (json_valid(plan) AND json_type(plan) = 'object'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  started_at TEXT CHECK (started_at IS NULL OR started_at GLOB '????-??-??T??:??:??.???Z'),
  finished_at TEXT CHECK (finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
  receipt TEXT CHECK (receipt IS NULL OR (json_valid(receipt) AND json_type(receipt) = 'object')),
  pending_refs TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(pending_refs) AND json_type(pending_refs) = 'array'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  CHECK ((status = 'planned') = (started_at IS NULL)),
  CHECK ((status = 'verified') = (finished_at IS NOT NULL))
) STRICT;

CREATE INDEX perception_deletions_state_index
  ON perception_deletions(owner_id, agent_id, status, created_at);

CREATE TABLE perception_deletion_scopes (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  deletion_id TEXT NOT NULL REFERENCES perception_deletions(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('records', 'episode', 'day', 'types')),
  device_id TEXT CHECK (device_id IS NULL OR length(device_id) BETWEEN 1 AND 64),
  local_day TEXT CHECK (local_day IS NULL OR local_day GLOB '????-??-??'),
  types TEXT NOT NULL CHECK (json_valid(types) AND json_type(types) = 'array'),
  record_ids TEXT NOT NULL CHECK (json_valid(record_ids) AND json_type(record_ids) = 'array'),
  track INTEGER NOT NULL CHECK (track IN (0, 1)),
  bound_ms INTEGER NOT NULL CHECK (bound_ms >= 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX perception_deletion_scopes_owner_index
  ON perception_deletion_scopes(owner_id, agent_id, revision);

CREATE TABLE perception_media_links (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES perception_media_items(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 27 AND 75 AND substr(record_id, 1, 11) = 'perception:'),
  PRIMARY KEY (owner_id, agent_id, media_id, record_id)
) STRICT;

CREATE INDEX perception_media_links_record_index
  ON perception_media_links(owner_id, agent_id, record_id);

CREATE TABLE device_upload_grant_records (
  token_hash TEXT NOT NULL REFERENCES device_upload_grants(token_hash) ON DELETE CASCADE,
  record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 27 AND 75 AND substr(record_id, 1, 11) = 'perception:'),
  PRIMARY KEY (token_hash, record_id)
) STRICT;
