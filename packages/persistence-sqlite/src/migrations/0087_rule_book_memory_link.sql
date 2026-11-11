CREATE TABLE decision_ledger_keep AS SELECT * FROM decision_ledger;
CREATE TABLE source_insights_keep AS SELECT * FROM source_insights;
CREATE TABLE proactive_processed_messages_keep AS SELECT * FROM proactive_processed_messages;
CREATE TABLE decision_ledger_payloads_keep AS SELECT * FROM decision_ledger_payloads;
CREATE TABLE decision_signals_keep AS SELECT * FROM decision_signals;
CREATE TABLE proactive_push_backoff_keep AS SELECT * FROM proactive_push_backoff;
CREATE TABLE muse_reference_entries_keep AS SELECT * FROM muse_reference_entries;

DROP TABLE source_insights;
DROP TABLE proactive_processed_messages;
DROP TABLE decision_ledger_payloads;
DROP TABLE decision_signals;
DROP TABLE proactive_push_backoff;
DROP TABLE muse_reference_entries;
DROP TABLE decision_ledger;

CREATE TABLE decision_ledger (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'proactive', 'memory_candidate', 'consolidation', 'context_truncation',
      'retrieval_degrade', 'external_read', 'rule_review'
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
    (kind = 'external_read' AND outcome = 'read') OR
    (kind = 'rule_review' AND outcome = 'needs_review')
  )
) STRICT;

CREATE INDEX decision_ledger_push_source_key
  ON decision_ledger (owner_id, agent_id, push_source_key)
  WHERE push_source_key IS NOT NULL;

CREATE INDEX decision_ledger_time_index ON decision_ledger(owner_id, agent_id, kind, checked_at);

INSERT INTO decision_ledger (id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, outcome, reason_code, subject_ref, inputs, reason_ref, content_ref, push_source_key, cost_micros, duration_ms, owner_rating, rated_at, category, confidence_permille, inferred)
SELECT id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, outcome, reason_code, subject_ref, inputs, reason_ref, content_ref, push_source_key, cost_micros, duration_ms, owner_rating, rated_at, category, confidence_permille, inferred FROM decision_ledger_keep;

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
  updated_at TEXT NOT NULL, push_class TEXT
  CHECK (push_class IS NULL OR length(push_class) BETWEEN 1 AND 128),
  UNIQUE (owner_id, agent_id, source, thread_id)
) STRICT;

CREATE INDEX source_insights_push_class_index
  ON source_insights(owner_id, agent_id, push_class)
  WHERE push_class IS NOT NULL;

CREATE INDEX source_insights_status_index ON source_insights(owner_id, agent_id, status, due_at);

INSERT INTO source_insights (id, owner_id, agent_id, source, thread_id, last_message_id, result, floor_raised, content_ref, due_at, priority, status, decision_id, owner_rating, push_source_key, created_at, updated_at, push_class)
SELECT id, owner_id, agent_id, source, thread_id, last_message_id, result, floor_raised, content_ref, due_at, priority, status, decision_id, owner_rating, push_source_key, created_at, updated_at, push_class FROM source_insights_keep;

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
  owner_rating TEXT CHECK (owner_rating IS NULL OR owner_rating IN ('useful', 'unneeded', 'missed')), received_at TEXT,
  PRIMARY KEY (owner_id, agent_id, source, message_id),
  CHECK ((outcome = 'skipped') = (skip_reason IS NOT NULL))
) STRICT;

CREATE INDEX proactive_processed_outcome_index
  ON proactive_processed_messages(owner_id, agent_id, outcome, processed_at);

INSERT INTO proactive_processed_messages (owner_id, agent_id, source, message_id, thread_id, decision_id, outcome, skip_reason, header_ref, processed_at, reviewed_at, owner_rating, received_at)
SELECT owner_id, agent_id, source, message_id, thread_id, decision_id, outcome, skip_reason, header_ref, processed_at, reviewed_at, owner_rating, received_at FROM proactive_processed_messages_keep;

CREATE TABLE decision_ledger_payloads (
  decision_id TEXT NOT NULL REFERENCES decision_ledger(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0 AND sequence <= 1000000),
  role TEXT NOT NULL CHECK (role IN ('model_input', 'model_output')),
  payload_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  PRIMARY KEY (decision_id, sequence)
) STRICT;

CREATE INDEX decision_ledger_payloads_ref_index ON decision_ledger_payloads(payload_ref);

INSERT INTO decision_ledger_payloads (decision_id, sequence, role, payload_ref)
SELECT decision_id, sequence, role, payload_ref FROM decision_ledger_payloads_keep;

CREATE TABLE decision_signals (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES decision_ledger(id) ON DELETE CASCADE,
  signal TEXT NOT NULL CHECK (signal IN ('opened', 'undone', 'replied')),
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.???Z'),
  delay_ms INTEGER NOT NULL CHECK (delay_ms >= 0 AND delay_ms <= 9007199254740991),
  detail TEXT NOT NULL CHECK (json_valid(detail) AND json_type(detail) = 'object'),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 256),
  recorded_at TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (decision_id, signal, source_ref)
) STRICT;

CREATE INDEX decision_signals_decision_index ON decision_signals(decision_id, signal);

CREATE TRIGGER decision_signals_no_delete BEFORE DELETE ON decision_signals
WHEN EXISTS (SELECT 1 FROM decision_ledger WHERE id = OLD.decision_id)
  AND EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)
  AND EXISTS (SELECT 1 FROM owners WHERE id = OLD.owner_id)
BEGIN SELECT RAISE(ABORT, 'DECISION_SIGNAL_IMMUTABLE'); END;

CREATE TRIGGER decision_signals_no_update BEFORE UPDATE ON decision_signals
BEGIN SELECT RAISE(ABORT, 'DECISION_SIGNAL_IMMUTABLE'); END;

INSERT INTO decision_signals (id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms, detail, source_ref, recorded_at)
SELECT id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms, detail, source_ref, recorded_at FROM decision_signals_keep;

CREATE TABLE proactive_push_backoff (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  class_key TEXT NOT NULL CHECK (length(class_key) BETWEEN 1 AND 128),
  stage INTEGER NOT NULL CHECK (stage BETWEEN 0 AND 2),
  since_at TEXT NOT NULL,
  last_push_at TEXT,
  stage_changed_at TEXT,
  step_decision_id TEXT REFERENCES decision_ledger(id) ON DELETE SET NULL,
  ignored_count INTEGER NOT NULL CHECK (ignored_count >= 0 AND ignored_count <= 1000),
  restored_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, class_key)
) STRICT;

INSERT INTO proactive_push_backoff (owner_id, agent_id, class_key, stage, since_at, last_push_at, stage_changed_at, step_decision_id, ignored_count, restored_at, updated_at)
SELECT owner_id, agent_id, class_key, stage, since_at, last_push_at, stage_changed_at, step_decision_id, ignored_count, restored_at, updated_at FROM proactive_push_backoff_keep;

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
  recorded_at TEXT NOT NULL, paired_message_id TEXT
  CHECK (paired_message_id IS NULL OR length(paired_message_id) BETWEEN 1 AND 256),
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

CREATE UNIQUE INDEX muse_reference_entries_intake_key_index
  ON muse_reference_entries(owner_id, agent_id, intake_item_key)
  WHERE intake_item_key IS NOT NULL;

CREATE INDEX muse_reference_entries_time_index ON muse_reference_entries(owner_id, agent_id, muse_at);

INSERT INTO muse_reference_entries (id, owner_id, agent_id, muse_at, muse_reminded, timing_ok, content_ok, content_ref, note_ref, paired_decision_id, intake_item_key, recorded_at, paired_message_id)
SELECT id, owner_id, agent_id, muse_at, muse_reminded, timing_ok, content_ok, content_ref, note_ref, paired_decision_id, intake_item_key, recorded_at, paired_message_id FROM muse_reference_entries_keep;

DROP TABLE decision_ledger_keep;
DROP TABLE source_insights_keep;
DROP TABLE proactive_processed_messages_keep;
DROP TABLE decision_ledger_payloads_keep;
DROP TABLE decision_signals_keep;
DROP TABLE proactive_push_backoff_keep;
DROP TABLE muse_reference_entries_keep;

CREATE TABLE rule_book_rules_next (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 64),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  parameters TEXT NOT NULL CHECK (json_valid(parameters) AND json_type(parameters) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('active', 'needs_review', 'retired')),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 256),
  source_memory_id TEXT CHECK (source_memory_id IS NULL OR length(source_memory_id) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, rule_id)
) STRICT;

INSERT INTO rule_book_rules_next (
  owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id, updated_at
)
SELECT owner_id, agent_id, rule_id, revision, parameters, status, source, NULL, updated_at
FROM rule_book_rules;

DROP TABLE rule_book_rules;

ALTER TABLE rule_book_rules_next RENAME TO rule_book_rules;

CREATE INDEX rule_book_rules_source_memory_index
  ON rule_book_rules (source_memory_id) WHERE source_memory_id IS NOT NULL;

CREATE TABLE rule_book_history_next (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 64),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  parameters TEXT NOT NULL CHECK (json_valid(parameters) AND json_type(parameters) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('active', 'needs_review', 'retired')),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 256),
  source_memory_id TEXT CHECK (source_memory_id IS NULL OR length(source_memory_id) BETWEEN 1 AND 128),
  change_reason TEXT CHECK (change_reason IS NULL OR length(change_reason) BETWEEN 1 AND 64),
  changed_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, rule_id, revision)
) STRICT;

DROP TRIGGER rule_book_history_no_update;
DROP TRIGGER rule_book_history_no_delete;

INSERT INTO rule_book_history_next (
  owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id,
  change_reason, changed_at
)
SELECT owner_id, agent_id, rule_id, revision, parameters, status, source, NULL, NULL, changed_at
FROM rule_book_history;

DROP TABLE rule_book_history;

ALTER TABLE rule_book_history_next RENAME TO rule_book_history;

CREATE TRIGGER rule_book_history_no_update BEFORE UPDATE ON rule_book_history
BEGIN SELECT RAISE(ABORT, 'RULE_BOOK_HISTORY_IMMUTABLE'); END;

CREATE TRIGGER rule_book_history_no_delete BEFORE DELETE ON rule_book_history
WHEN EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)
  AND EXISTS (SELECT 1 FROM owners WHERE id = OLD.owner_id)
BEGIN SELECT RAISE(ABORT, 'RULE_BOOK_HISTORY_IMMUTABLE'); END;

CREATE TRIGGER memory_rule_needs_review AFTER UPDATE ON memory_records
WHEN OLD.category = 'rule'
  AND EXISTS (
    SELECT 1 FROM rule_book_rules
    WHERE source_memory_id = OLD.id AND owner_id = OLD.owner_id AND agent_id = OLD.agent_id
      AND status = 'active'
  )
  AND (
    NEW.content_ref IS NOT OLD.content_ref
    OR (NEW.superseded_by IS NOT NULL AND NEW.superseded_by IS NOT OLD.superseded_by)
    OR (NEW.status IS NOT OLD.status
      AND NEW.status IN ('archived', 'trashed', 'deletion_pending', 'deleted_verified'))
    OR NEW.category IS NOT OLD.category
  )
BEGIN
  INSERT INTO rule_book_history (
    owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id,
    change_reason, changed_at
  )
  SELECT owner_id, agent_id, rule_id, revision + 1, parameters, 'needs_review', source,
    source_memory_id,
    CASE
      WHEN NEW.category IS NOT OLD.category THEN 'memory_reclassified'
      WHEN NEW.superseded_by IS NOT NULL AND NEW.superseded_by IS NOT OLD.superseded_by
        THEN 'memory_superseded'
      WHEN NEW.status IS NOT OLD.status
        AND NEW.status IN ('archived', 'trashed', 'deletion_pending', 'deleted_verified')
        THEN 'memory_removed'
      ELSE 'memory_edited'
    END,
    NEW.updated_at
  FROM rule_book_rules
  WHERE source_memory_id = OLD.id AND owner_id = OLD.owner_id AND agent_id = OLD.agent_id
    AND status = 'active';
  INSERT INTO decision_ledger (
    id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, subject_ref, inputs,
    cost_micros, duration_ms
  )
  SELECT 'rule-review:' || lower(hex(randomblob(12))), owner_id, agent_id, 'rule_review',
    NEW.updated_at, '{}', 'needs_review',
    CASE
      WHEN NEW.category IS NOT OLD.category THEN 'memory_reclassified'
      WHEN NEW.superseded_by IS NOT NULL AND NEW.superseded_by IS NOT OLD.superseded_by
        THEN 'memory_superseded'
      WHEN NEW.status IS NOT OLD.status
        AND NEW.status IN ('archived', 'trashed', 'deletion_pending', 'deleted_verified')
        THEN 'memory_removed'
      ELSE 'memory_edited'
    END,
    rule_id,
    json_object('memoryIds', json_array(OLD.id), 'ruleIds', json_array(rule_id),
      'batchId', NULL, 'resultMemoryIds', json_array()),
    0, 0
  FROM rule_book_rules
  WHERE source_memory_id = OLD.id AND owner_id = OLD.owner_id AND agent_id = OLD.agent_id
    AND status = 'active';
  UPDATE rule_book_rules SET status = 'needs_review', revision = revision + 1,
    updated_at = NEW.updated_at
  WHERE source_memory_id = OLD.id AND owner_id = OLD.owner_id AND agent_id = OLD.agent_id
    AND status = 'active';
END;
