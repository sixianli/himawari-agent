CREATE TABLE proactive_settings (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  quiet_hours TEXT NOT NULL CHECK (json_valid(quiet_hours) AND json_type(quiet_hours) = 'array'),
  important_senders TEXT NOT NULL
    CHECK (json_valid(important_senders) AND json_type(important_senders) = 'array'),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id)
) STRICT;

CREATE TABLE proactive_connections (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('gmail')),
  account_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  token_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  cursor TEXT CHECK (cursor IS NULL OR length(cursor) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs_reconnect')),
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, source)
) STRICT;

CREATE TABLE proactive_decisions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scenario TEXT NOT NULL CHECK (scenario IN ('gmail')),
  checked_at TEXT NOT NULL,
  counts TEXT NOT NULL CHECK (json_valid(counts) AND json_type(counts) = 'object'),
  verdict TEXT NOT NULL CHECK (
    verdict IN ('pushed', 'silent', 'deferred', 'failed', 'capped', 'capped_daily', 'needs_owner')
  ),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  push_source_key TEXT CHECK (push_source_key IS NULL OR length(push_source_key) BETWEEN 1 AND 256),
  cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0 AND cost_micros <= 9007199254740991),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0 AND duration_ms <= 86400000),
  owner_rating TEXT CHECK (owner_rating IS NULL OR owner_rating IN ('useful', 'unneeded', 'missed')),
  rated_at TEXT,
  CHECK ((owner_rating IS NULL) = (rated_at IS NULL))
) STRICT;

CREATE INDEX proactive_decisions_time_index ON proactive_decisions(owner_id, agent_id, checked_at);

CREATE TABLE source_insights (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('gmail')),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 256),
  last_message_id TEXT NOT NULL CHECK (length(last_message_id) BETWEEN 1 AND 256),
  result TEXT NOT NULL CHECK (result IN ('act', 'know', 'check')),
  floor_raised INTEGER NOT NULL CHECK (floor_raised IN (0, 1)),
  content_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  due_at TEXT,
  priority TEXT CHECK (priority IS NULL OR priority IN ('high', 'medium', 'low')),
  status TEXT NOT NULL CHECK (status IN ('open', 'replied', 'done', 'muted')),
  decision_id TEXT NOT NULL REFERENCES proactive_decisions(id) ON DELETE CASCADE,
  owner_rating TEXT CHECK (owner_rating IS NULL OR owner_rating IN ('useful', 'unneeded', 'missed')),
  push_source_key TEXT CHECK (push_source_key IS NULL OR length(push_source_key) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, source, thread_id)
) STRICT;

CREATE INDEX source_insights_status_index ON source_insights(owner_id, agent_id, status, due_at);

CREATE TABLE proactive_processed_messages (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('gmail')),
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 256),
  decision_id TEXT NOT NULL REFERENCES proactive_decisions(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('act', 'know', 'check', 'ignore', 'skipped')),
  skip_reason TEXT CHECK (skip_reason IS NULL OR skip_reason IN ('category', 'sensitive', 'own_mail')),
  header_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  processed_at TEXT NOT NULL,
  reviewed_at TEXT,
  owner_rating TEXT CHECK (owner_rating IS NULL OR owner_rating IN ('useful', 'unneeded', 'missed')),
  PRIMARY KEY (owner_id, agent_id, source, message_id),
  CHECK ((outcome = 'skipped') = (skip_reason IS NOT NULL))
) STRICT;

CREATE INDEX proactive_processed_outcome_index
  ON proactive_processed_messages(owner_id, agent_id, outcome, processed_at);

CREATE TABLE proactive_pushes (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ready_at TEXT NOT NULL,
  insight_ids TEXT NOT NULL CHECK (json_valid(insight_ids) AND json_type(insight_ids) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'enqueued')),
  created_at TEXT NOT NULL,
  enqueued_at TEXT,
  CHECK ((status = 'enqueued') = (enqueued_at IS NOT NULL))
) STRICT;

CREATE INDEX proactive_pushes_ready_index ON proactive_pushes(owner_id, agent_id, status, ready_at);
