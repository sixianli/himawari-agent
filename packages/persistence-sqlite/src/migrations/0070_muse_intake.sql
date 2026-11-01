CREATE TABLE muse_intake_batches (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL CHECK (length(sender_id) BETWEEN 1 AND 64),
  batch_seq INTEGER NOT NULL CHECK (batch_seq >= 1),
  sent_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  accepted_count INTEGER NOT NULL CHECK (accepted_count >= 0),
  duplicate_count INTEGER NOT NULL CHECK (duplicate_count >= 0),
  conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0),
  rejected_count INTEGER NOT NULL CHECK (rejected_count >= 0),
  dropped_field_count INTEGER NOT NULL CHECK (dropped_field_count >= 0),
  UNIQUE (owner_id, agent_id, sender_id, batch_seq)
) STRICT;

CREATE TABLE muse_intake_items (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('proactive', 'scheduled')),
  natural_key TEXT NOT NULL CHECK (length(natural_key) BETWEEN 1 AND 150),
  state TEXT NOT NULL CHECK (state IN ('delivered', 'suppressed', 'succeeded', 'failed')),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  decision TEXT CHECK (decision IS NULL OR decision IN ('send', 'skip', 'defer')),
  reason_enum TEXT CHECK (reason_enum IS NULL OR length(reason_enum) BETWEEN 1 AND 64),
  priority TEXT CHECK (priority IS NULL OR priority IN ('regular', 'high')),
  occurred_at TEXT NOT NULL,
  scheduled_for TEXT,
  started_at TEXT,
  prepared_at TEXT,
  handoff_accepted_at TEXT,
  title_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  text_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  text_withheld INTEGER NOT NULL CHECK (text_withheld IN (0, 1)),
  options TEXT NOT NULL,
  sources TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK (length(content_digest) BETWEEN 8 AND 128),
  batch_id TEXT NOT NULL REFERENCES muse_intake_batches(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, kind, natural_key),
  CHECK (
    (kind = 'proactive' AND state IN ('delivered', 'suppressed')) OR
    (kind = 'scheduled' AND state IN ('succeeded', 'failed'))
  )
) STRICT;

CREATE INDEX muse_intake_items_time_index ON muse_intake_items(owner_id, agent_id, occurred_at);

CREATE TABLE muse_intake_conflicts (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('proactive', 'scheduled')),
  natural_key TEXT NOT NULL,
  conflict_count INTEGER NOT NULL CHECK (conflict_count >= 1),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, kind, natural_key)
) STRICT;

CREATE TABLE muse_intake_channel (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  last_batch_at TEXT,
  last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
  gap_count INTEGER NOT NULL CHECK (gap_count >= 0),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  outage_started_at TEXT,
  outage_notified_at TEXT,
  PRIMARY KEY (owner_id, agent_id)
) STRICT;
