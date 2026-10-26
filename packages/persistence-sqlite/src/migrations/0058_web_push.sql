CREATE TABLE web_push_subscriptions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 9 AND 2048 AND substr(endpoint, 1, 8) = 'https://'),
  p256dh TEXT NOT NULL CHECK (length(p256dh) BETWEEN 1 AND 256),
  auth TEXT NOT NULL CHECK (length(auth) BETWEEN 1 AND 64),
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'en', 'ja')),
  device_label TEXT NOT NULL CHECK (length(device_label) BETWEEN 1 AND 64),
  state TEXT NOT NULL CHECK (state IN ('active', 'paused')),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_delivered_at TEXT
) STRICT;

CREATE UNIQUE INDEX web_push_subscriptions_endpoint_index ON web_push_subscriptions(owner_id, agent_id, endpoint);

CREATE TABLE web_push_outbox (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
  kind TEXT NOT NULL CHECK (kind IN ('reminder', 'approval', 'run')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 256),
  thread_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, source_key)
) STRICT;

CREATE INDEX web_push_outbox_expiry_index ON web_push_outbox(owner_id, agent_id, expires_at);

CREATE TABLE web_push_attempts (
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'suppressed', 'expired', 'gone', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at TEXT,
  last_code TEXT CHECK (last_code IS NULL OR length(last_code) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, source_key, subscription_id),
  FOREIGN KEY (owner_id, agent_id, source_key) REFERENCES web_push_outbox(owner_id, agent_id, source_key) ON DELETE CASCADE
) STRICT;

CREATE TABLE web_push_cursors (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('finished-runs')),
  cursor TEXT NOT NULL CHECK (length(cursor) BETWEEN 1 AND 256),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, source)
) STRICT;

CREATE INDEX runs_scope_updated_index ON runs(owner_id, agent_id, updated_at, id);
