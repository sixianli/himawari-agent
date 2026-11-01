CREATE TABLE decision_ledger (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'proactive', 'memory_candidate', 'consolidation', 'context_truncation',
      'retrieval_degrade', 'external_read'
    )
  ),
  scenario TEXT CHECK (scenario IS NULL OR scenario IN ('gmail')),
  checked_at TEXT NOT NULL,
  counts TEXT NOT NULL CHECK (json_valid(counts) AND json_type(counts) = 'object'),
  verdict TEXT CHECK (
    verdict IS NULL OR
    verdict IN ('pushed', 'silent', 'deferred', 'failed', 'capped', 'capped_daily', 'needs_owner')
  ),
  outcome TEXT CHECK (outcome IS NULL OR length(outcome) BETWEEN 1 AND 64),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  subject_ref TEXT CHECK (subject_ref IS NULL OR length(subject_ref) BETWEEN 1 AND 256),
  inputs TEXT NOT NULL CHECK (json_valid(inputs) AND json_type(inputs) = 'object'),
  reason_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  content_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  push_source_key TEXT CHECK (push_source_key IS NULL OR length(push_source_key) BETWEEN 1 AND 256),
  cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0 AND cost_micros <= 9007199254740991),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0 AND duration_ms <= 86400000),
  owner_rating TEXT CHECK (owner_rating IS NULL OR owner_rating IN ('useful', 'unneeded', 'missed')),
  rated_at TEXT,
  category TEXT CHECK (
    category IS NULL OR
    category IN (
      'identity', 'preference', 'relationship', 'goal', 'project', 'rule', 'health',
      'finance', 'event', 'other'
    )
  ),
  confidence_permille INTEGER CHECK (
    confidence_permille IS NULL OR (confidence_permille >= 0 AND confidence_permille <= 1000)
  ),
  inferred INTEGER CHECK (inferred IS NULL OR inferred IN (0, 1)),
  CHECK ((owner_rating IS NULL) = (rated_at IS NULL)),
  CHECK (
    kind = 'memory_candidate' OR
    (category IS NULL AND confidence_permille IS NULL AND inferred IS NULL)
  ),
  CHECK ((kind = 'proactive') = (scenario IS NOT NULL)),
  CHECK ((kind = 'proactive') = (verdict IS NOT NULL)),
  CHECK ((kind = 'proactive') = (outcome IS NULL)),
  CHECK (
    kind = 'proactive' OR
    (kind = 'memory_candidate' AND outcome IN ('kept', 'discarded', 'pending_approval')) OR
    (kind = 'consolidation' AND outcome IN ('merge', 'supersede', 'archive', 'reflect')) OR
    (kind = 'context_truncation' AND outcome = 'truncated') OR
    (kind = 'retrieval_degrade' AND outcome = 'degraded') OR
    (kind = 'external_read' AND outcome = 'read')
  )
) STRICT;

INSERT INTO decision_ledger (
  id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, outcome, reason_code,
  subject_ref, inputs, reason_ref, content_ref, push_source_key, cost_micros, duration_ms,
  owner_rating, rated_at
)
SELECT id, owner_id, agent_id, 'proactive', scenario, checked_at, counts, verdict, NULL, reason_code,
  NULL, '{}', NULL, NULL, push_source_key, cost_micros, duration_ms, owner_rating, rated_at
FROM proactive_decisions;

CREATE TABLE source_insights_keep AS SELECT * FROM source_insights;
CREATE TABLE proactive_processed_messages_keep AS SELECT * FROM proactive_processed_messages;

DROP TABLE source_insights;
DROP TABLE proactive_processed_messages;
DROP TABLE proactive_decisions;

CREATE INDEX decision_ledger_time_index ON decision_ledger(owner_id, agent_id, kind, checked_at);

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
  decision_id TEXT NOT NULL REFERENCES decision_ledger(id) ON DELETE CASCADE,
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
  decision_id TEXT NOT NULL REFERENCES decision_ledger(id) ON DELETE CASCADE,
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

INSERT INTO source_insights SELECT * FROM source_insights_keep;
INSERT INTO proactive_processed_messages SELECT * FROM proactive_processed_messages_keep;

DROP TABLE source_insights_keep;
DROP TABLE proactive_processed_messages_keep;

CREATE TABLE muse_reference_entries (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  muse_at TEXT NOT NULL,
  muse_reminded INTEGER NOT NULL CHECK (muse_reminded IN (0, 1)),
  timing_ok INTEGER CHECK (timing_ok IS NULL OR timing_ok IN (0, 1)),
  content_ok INTEGER CHECK (content_ok IS NULL OR content_ok IN (0, 1)),
  content_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  note_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  paired_decision_id TEXT REFERENCES decision_ledger(id) ON DELETE SET NULL,
  intake_item_key TEXT CHECK (intake_item_key IS NULL OR length(intake_item_key) BETWEEN 3 AND 200),
  recorded_at TEXT NOT NULL,
  CHECK (
    muse_reminded = 0 OR
    (timing_ok IS NOT NULL AND content_ok IS NOT NULL AND
      (content_ref IS NOT NULL OR intake_item_key IS NOT NULL))
  ),
  CHECK (
    muse_reminded = 1 OR
    (timing_ok IS NULL AND content_ok IS NULL AND content_ref IS NULL)
  )
) STRICT;

CREATE INDEX muse_reference_entries_time_index ON muse_reference_entries(owner_id, agent_id, muse_at);

CREATE UNIQUE INDEX muse_reference_entries_intake_key_index
  ON muse_reference_entries(owner_id, agent_id, intake_item_key)
  WHERE intake_item_key IS NOT NULL;
