INSERT INTO decision_ledger_kinds (kind) VALUES
  ('limit_change'),
  ('delivery_timing'),
  ('proposal');

INSERT INTO decision_ledger_outcomes (kind, outcome) VALUES
  ('limit_change', 'changed'),
  ('delivery_timing', 'delivered'),
  ('delivery_timing', 'deferred'),
  ('delivery_timing', 'deadline_reached'),
  ('delivery_timing', 'shown_in_app'),
  ('proposal', 'proposed'),
  ('proposal', 'blocked'),
  ('proposal', 'accepted'),
  ('proposal', 'dismissed'),
  ('proposal', 'expired'),
  ('proposal', 'executed'),
  ('proposal', 'failed'),
  ('proposal', 'undone'),
  ('proposal', 'not_proposed'),
  ('proposal', 'superseded'),
  ('proposal', 'told');

CREATE TABLE perception_settings (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  disabled_senses TEXT NOT NULL
    CHECK (json_valid(disabled_senses) AND json_type(disabled_senses) = 'array'),
  paused_from TEXT CHECK (paused_from IS NULL OR paused_from GLOB '????-??-??T??:??:??.???Z'),
  paused_until TEXT CHECK (paused_until IS NULL OR paused_until GLOB '????-??-??T??:??:??.???Z'),
  retention_days TEXT NOT NULL
    CHECK (json_valid(retention_days) AND json_type(retention_days) = 'object'),
  limit_overrides TEXT NOT NULL
    CHECK (json_valid(limit_overrides) AND json_type(limit_overrides) = 'object'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (owner_id, agent_id),
  CHECK ((paused_from IS NULL) = (paused_until IS NULL)),
  CHECK (paused_until IS NULL OR paused_until > paused_from)
) STRICT;

CREATE TABLE perception_episodes (
  id TEXT PRIMARY KEY CHECK (length(id) = 40 AND substr(id, 1, 8) = 'episode:'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  ended_at_ms INTEGER NOT NULL CHECK (ended_at_ms >= started_at_ms),
  local_day TEXT NOT NULL CHECK (local_day GLOB '????-??-??'),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  CHECK ((status = 'active') = (record_count > 0))
) STRICT;

CREATE INDEX perception_episodes_day_index
  ON perception_episodes(owner_id, agent_id, local_day, status, started_at_ms, id);

CREATE INDEX perception_episodes_time_index
  ON perception_episodes(owner_id, agent_id, status, started_at_ms, ended_at_ms);

CREATE TABLE perception_records (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 27 AND 75 AND substr(id, 1, 11) = 'perception:'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (length(type) BETWEEN 3 AND 64),
  origin TEXT NOT NULL CHECK (origin IN ('owner_spoken', 'other')),
  capture_source TEXT NOT NULL CHECK (length(capture_source) BETWEEN 1 AND 64),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  occurred_at_device TEXT NOT NULL CHECK (length(occurred_at_device) BETWEEN 1 AND 64),
  local_day TEXT NOT NULL CHECK (local_day GLOB '????-??-??'),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 1000),
  speaker_kind TEXT CHECK (speaker_kind IS NULL OR speaker_kind IN ('owner', 'contact', 'unknown')),
  speaker_ref TEXT CHECK (speaker_ref IS NULL OR length(speaker_ref) BETWEEN 1 AND 128),
  episode_id TEXT REFERENCES perception_episodes(id) ON DELETE SET NULL,
  content_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  data_classification TEXT NOT NULL
    CHECK (data_classification IN ('public', 'private', 'sensitive', 'restricted')),
  evidence TEXT NOT NULL CHECK (json_valid(evidence) AND json_type(evidence) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  CHECK (speaker_ref IS NULL OR speaker_kind = 'contact')
) STRICT;

CREATE INDEX perception_records_day_index
  ON perception_records(owner_id, agent_id, local_day, status, occurred_at_ms, id);

CREATE INDEX perception_records_episode_index
  ON perception_records(episode_id, occurred_at_ms, id)
  WHERE episode_id IS NOT NULL;

CREATE INDEX perception_records_type_index
  ON perception_records(owner_id, agent_id, type, occurred_at_ms);

CREATE INDEX perception_records_content_index
  ON perception_records(content_ref)
  WHERE content_ref IS NOT NULL;

CREATE TABLE device_mirror_items (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
  version INTEGER NOT NULL CHECK (version >= 0),
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  data TEXT CHECK (data IS NULL OR (json_valid(data) AND json_type(data) = 'object')),
  sync_id TEXT NOT NULL CHECK (length(sync_id) BETWEEN 16 AND 64),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (owner_id, agent_id, device_id, kind, external_id),
  CHECK ((deleted = 1) = (data IS NULL))
) STRICT;

CREATE TABLE location_track_points (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  latitude_e7 INTEGER NOT NULL CHECK (latitude_e7 BETWEEN -900000000 AND 900000000),
  longitude_e7 INTEGER NOT NULL CHECK (longitude_e7 BETWEEN -1800000000 AND 1800000000),
  accuracy_dm INTEGER CHECK (accuracy_dm IS NULL OR accuracy_dm BETWEEN 0 AND 1000000),
  speed_cms INTEGER CHECK (speed_cms IS NULL OR speed_cms BETWEEN 0 AND 100000000),
  local_day TEXT NOT NULL CHECK (local_day GLOB '????-??-??'),
  PRIMARY KEY (owner_id, agent_id, device_id, occurred_at_ms)
) STRICT;

CREATE INDEX location_track_points_time_index
  ON location_track_points(owner_id, agent_id, occurred_at_ms);

CREATE TABLE device_upload_grants (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('perception', 'track', 'media')),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  bytes INTEGER NOT NULL CHECK (bytes >= 1),
  record_id_first TEXT CHECK (record_id_first IS NULL OR substr(record_id_first, 1, 11) = 'perception:'),
  record_id_last TEXT CHECK (record_id_last IS NULL OR substr(record_id_last, 1, 11) = 'perception:'),
  batch_id TEXT CHECK (batch_id IS NULL OR length(batch_id) BETWEEN 16 AND 64),
  media_kind TEXT CHECK (media_kind IS NULL OR media_kind IN ('audio', 'image', 'screen')),
  media_ms INTEGER CHECK (media_ms IS NULL OR media_ms BETWEEN 0 AND 86400000),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  used_at TEXT CHECK (used_at IS NULL OR used_at GLOB '????-??-??T??:??:??.???Z'),
  result TEXT CHECK (result IS NULL OR (json_valid(result) AND json_type(result) = 'object')),
  CHECK (expires_at > created_at),
  CHECK ((used_at IS NULL) = (result IS NULL)),
  CHECK ((purpose = 'perception') = (record_id_first IS NOT NULL)),
  CHECK ((record_id_first IS NULL) = (record_id_last IS NULL)),
  CHECK ((purpose = 'perception') = (batch_id IS NULL)),
  CHECK ((purpose = 'media') = (media_kind IS NOT NULL)),
  CHECK (media_ms IS NULL OR media_kind = 'audio')
) STRICT;

CREATE UNIQUE INDEX device_upload_grants_batch_index
  ON device_upload_grants(device_id, purpose, batch_id)
  WHERE batch_id IS NOT NULL;

CREATE INDEX device_upload_grants_expiry_index ON device_upload_grants(expires_at);

CREATE TABLE perception_media_items (
  id TEXT PRIMARY KEY CHECK (length(id) = 70 AND substr(id, 1, 6) = 'media:'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('audio', 'image', 'screen')),
  bytes INTEGER NOT NULL CHECK (bytes >= 1),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  milliseconds INTEGER CHECK (milliseconds IS NULL OR milliseconds BETWEEN 0 AND 86400000),
  received_at TEXT NOT NULL CHECK (received_at GLOB '????-??-??T??:??:??.???Z'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'deleted'))
) STRICT;

CREATE INDEX perception_media_items_status_index
  ON perception_media_items(owner_id, agent_id, status, received_at);

CREATE TABLE limit_usage (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  period_start TEXT NOT NULL CHECK (period_start GLOB '????-??-??T??:??:??.???Z'),
  device_id TEXT NOT NULL DEFAULT '' CHECK (length(device_id) <= 64),
  used INTEGER NOT NULL CHECK (used >= 0 AND used <= 9007199254740991),
  warned_at TEXT CHECK (warned_at IS NULL OR warned_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (owner_id, agent_id, key, period_start, device_id)
) STRICT;
