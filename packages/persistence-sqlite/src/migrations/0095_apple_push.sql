ALTER TABLE paired_devices ADD COLUMN companion_of TEXT REFERENCES paired_devices(id)
  CHECK (companion_of IS NULL OR (kind = 'watch' AND companion_of <> id));

CREATE INDEX paired_devices_companion_index ON paired_devices(companion_of);

ALTER TABLE web_push_outbox ADD COLUMN channel TEXT
  CHECK (channel IS NULL OR channel IN ('web_push', 'apns'));

CREATE TABLE apns_registrations (
  id TEXT PRIMARY KEY CHECK (length(id) = 26 AND substr(id, 1, 4) = 'apn_'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
  push_type TEXT NOT NULL CHECK (push_type IN ('alert', 'widgets', 'liveactivity')),
  activity_ref TEXT NOT NULL CHECK (length(activity_ref) <= 128),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 2 AND 512 AND token NOT GLOB '*[^0-9a-f]*'),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 255),
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'en', 'ja')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  last_delivered_at TEXT CHECK (last_delivered_at IS NULL OR last_delivered_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK (push_type = 'liveactivity' OR activity_ref = '')
) STRICT;

CREATE UNIQUE INDEX apns_registrations_target_index
  ON apns_registrations(device_id, push_type, activity_ref);

CREATE INDEX apns_registrations_scope_index
  ON apns_registrations(owner_id, agent_id, push_type, status);

CREATE TABLE notification_action_tokens (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 32 AND action NOT GLOB '*[^a-z_]*'),
  owner_presence INTEGER NOT NULL CHECK (owner_presence IN (0, 1)),
  approval_request_id TEXT CHECK (approval_request_id IS NULL OR length(approval_request_id) BETWEEN 1 AND 256),
  approval_revision INTEGER CHECK (approval_revision IS NULL OR approval_revision >= 1),
  approval_snapshot_hash TEXT CHECK (approval_snapshot_hash IS NULL OR length(approval_snapshot_hash) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  used_at TEXT CHECK (used_at IS NULL OR used_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK (expires_at > created_at),
  CHECK ((approval_request_id IS NULL) = (approval_revision IS NULL)),
  CHECK ((approval_request_id IS NULL) = (approval_snapshot_hash IS NULL))
) STRICT;

CREATE INDEX notification_action_tokens_source_index
  ON notification_action_tokens(owner_id, agent_id, source_key, device_id);

CREATE INDEX notification_action_tokens_expiry_index
  ON notification_action_tokens(expires_at);

CREATE TABLE web_push_attempts_rebuilt (
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('web_push', 'apns')),
  push_type TEXT CHECK (push_type IS NULL OR push_type IN ('alert', 'widgets', 'liveactivity')),
  subscription_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'suppressed', 'expired', 'gone', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at TEXT,
  last_code TEXT CHECK (last_code IS NULL OR length(last_code) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, source_key, channel, subscription_id),
  FOREIGN KEY (owner_id, agent_id, source_key) REFERENCES web_push_outbox(owner_id, agent_id, source_key) ON DELETE CASCADE,
  CHECK ((channel = 'apns') = (push_type IS NOT NULL))
) STRICT;

INSERT INTO web_push_attempts_rebuilt (
  owner_id, agent_id, source_key, channel, push_type, subscription_id, status, attempts,
  next_attempt_at, last_code, updated_at
)
SELECT owner_id, agent_id, source_key, 'web_push', NULL, subscription_id, status, attempts,
  next_attempt_at, last_code, updated_at
FROM web_push_attempts;

DROP TABLE web_push_attempts;

ALTER TABLE web_push_attempts_rebuilt RENAME TO web_push_attempts;

CREATE TABLE web_push_feedback_rebuilt (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 64),
  kind TEXT NOT NULL CHECK (kind IN ('reminder', 'approval', 'run')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 256),
  thread_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('web_push', 'apns')),
  first_sent_at TEXT NOT NULL,
  devices INTEGER NOT NULL CHECK (devices BETWEEN 1 AND 100),
  opened_at TEXT,
  dismissed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, source_key)
) STRICT;

INSERT INTO web_push_feedback_rebuilt (
  owner_id, agent_id, source_key, tag, kind, source_ref, thread_id, channel, first_sent_at,
  devices, opened_at, dismissed_at, updated_at
)
SELECT owner_id, agent_id, source_key, tag, kind, source_ref, thread_id, channel, first_sent_at,
  devices, opened_at, dismissed_at, updated_at
FROM web_push_feedback;

DROP TABLE web_push_feedback;

ALTER TABLE web_push_feedback_rebuilt RENAME TO web_push_feedback;

CREATE UNIQUE INDEX web_push_feedback_tag_index ON web_push_feedback(owner_id, agent_id, tag);

CREATE INDEX web_push_feedback_sent_index ON web_push_feedback(owner_id, agent_id, first_sent_at);
