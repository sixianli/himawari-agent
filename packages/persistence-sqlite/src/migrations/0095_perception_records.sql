CREATE TABLE decision_ledger_keep AS SELECT * FROM decision_ledger;
CREATE TABLE decision_ledger_payloads_keep AS SELECT * FROM decision_ledger_payloads;
CREATE TABLE proactive_processed_messages_keep AS SELECT * FROM proactive_processed_messages;
CREATE TABLE decision_prereviews_keep AS SELECT * FROM decision_prereviews;
CREATE TABLE decision_signals_keep AS SELECT * FROM decision_signals;
CREATE TABLE muse_reference_entries_keep AS SELECT * FROM muse_reference_entries;
CREATE TABLE proactive_push_backoff_keep AS SELECT * FROM proactive_push_backoff;
CREATE TABLE source_insights_keep AS SELECT * FROM source_insights;

DROP TABLE source_insights;
DROP TABLE proactive_push_backoff;
DROP TABLE muse_reference_entries;
DROP TABLE decision_signals;
DROP TABLE decision_prereviews;
DROP TABLE proactive_processed_messages;
DROP TABLE decision_ledger_payloads;
DROP TABLE decision_ledger;

CREATE TABLE decision_ledger (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'proactive', 'memory_candidate', 'consolidation', 'context_truncation',
      'retrieval_degrade', 'external_read', 'rule_review',
      'limit_change', 'delivery_timing', 'proposal'
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
    (kind = 'memory_candidate' AND outcome IN (
      'kept', 'discarded', 'pending_approval', 'capture_retrying', 'capture_queued',
      'capture_gave_up'
    )) OR
    (kind = 'consolidation' AND outcome IN ('merge', 'supersede', 'archive', 'reflect', 'hold')) OR
    (kind = 'context_truncation' AND outcome = 'truncated') OR
    (kind = 'retrieval_degrade' AND outcome = 'degraded') OR
    (kind = 'external_read' AND outcome = 'read') OR
    (kind = 'rule_review' AND outcome = 'needs_review') OR
    (kind = 'limit_change' AND outcome = 'changed') OR
    (kind = 'delivery_timing' AND outcome IN (
      'delivered', 'deferred', 'deadline_reached', 'shown_in_app'
    )) OR
    (kind = 'proposal' AND outcome IN (
      'proposed', 'blocked', 'accepted', 'dismissed', 'expired', 'executed', 'failed', 'undone', 'not_proposed', 'superseded'
    ))
  )
) STRICT;

INSERT INTO decision_ledger (id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, outcome, reason_code, subject_ref, inputs, reason_ref, content_ref, push_source_key, cost_micros, duration_ms, owner_rating, rated_at, category, confidence_permille, inferred)
SELECT id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, outcome, reason_code, subject_ref, inputs, reason_ref, content_ref, push_source_key, cost_micros, duration_ms, owner_rating, rated_at, category, confidence_permille, inferred FROM decision_ledger_keep;

CREATE INDEX decision_ledger_push_source_key
  ON decision_ledger (owner_id, agent_id, push_source_key)
  WHERE push_source_key IS NOT NULL;

CREATE INDEX decision_ledger_time_index ON decision_ledger(owner_id, agent_id, kind, checked_at);

CREATE TABLE decision_ledger_payloads (
  decision_id TEXT NOT NULL REFERENCES decision_ledger(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0 AND sequence <= 1000000),
  role TEXT NOT NULL CHECK (role IN ('model_input', 'model_output')),
  payload_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  PRIMARY KEY (decision_id, sequence)
) STRICT;

INSERT INTO decision_ledger_payloads (decision_id, sequence, role, payload_ref)
SELECT decision_id, sequence, role, payload_ref FROM decision_ledger_payloads_keep;

CREATE INDEX decision_ledger_payloads_ref_index ON decision_ledger_payloads(payload_ref);

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

INSERT INTO proactive_processed_messages (owner_id, agent_id, source, message_id, thread_id, decision_id, outcome, skip_reason, header_ref, processed_at, reviewed_at, owner_rating, received_at)
SELECT owner_id, agent_id, source, message_id, thread_id, decision_id, outcome, skip_reason, header_ref, processed_at, reviewed_at, owner_rating, received_at FROM proactive_processed_messages_keep;

CREATE INDEX proactive_processed_outcome_index
  ON proactive_processed_messages(owner_id, agent_id, outcome, processed_at);

CREATE TABLE decision_prereviews (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  decision_id TEXT REFERENCES decision_ledger(id) ON DELETE CASCADE,
  mail_source TEXT CHECK (mail_source IS NULL OR mail_source IN ('gmail')),
  message_id TEXT CHECK (message_id IS NULL OR length(message_id) BETWEEN 1 AND 256),
  calibration_group TEXT NOT NULL CHECK (
    calibration_group IN (
      'proactive_pushed', 'proactive_silent', 'memory_skipped', 'memory_kept', 'consolidation'
    )
  ),
  category TEXT CHECK (category IS NULL OR length(category) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('done', 'failed')),
  rating TEXT CHECK (rating IS NULL OR rating IN ('useful', 'unneeded', 'missed', 'unsure')),
  confidence_permille INTEGER CHECK (
    confidence_permille IS NULL OR (confidence_permille >= 0 AND confidence_permille <= 1000)
  ),
  history_conflict INTEGER CHECK (history_conflict IS NULL OR history_conflict IN (0, 1)),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128),
  model_ref TEXT NOT NULL CHECK (length(model_ref) BETWEEN 1 AND 256),
  prompt_id TEXT NOT NULL CHECK (length(prompt_id) BETWEEN 1 AND 128),
  text_digest TEXT NOT NULL CHECK (length(text_digest) = 64 AND text_digest NOT GLOB '*[^0-9a-f]*'),
  data_classification TEXT NOT NULL CHECK (
    data_classification IN ('public', 'private', 'sensitive')
  ),
  cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0 AND cost_micros <= 9007199254740991),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0 AND duration_ms <= 86400000),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  FOREIGN KEY (owner_id, agent_id, mail_source, message_id)
    REFERENCES proactive_processed_messages(owner_id, agent_id, source, message_id)
    ON DELETE CASCADE,
  CHECK ((decision_id IS NULL) <> (message_id IS NULL)),
  CHECK ((message_id IS NULL) = (mail_source IS NULL)),
  CHECK (message_id IS NULL OR (calibration_group = 'proactive_silent' AND category IS NULL)),
  CHECK ((status = 'done') = (rating IS NOT NULL)),
  CHECK ((status = 'done') = (confidence_permille IS NOT NULL)),
  CHECK ((status = 'done') = (history_conflict IS NOT NULL)),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CHECK (
    rating IS NULL OR rating = 'unsure' OR
    (calibration_group IN ('proactive_pushed', 'memory_kept', 'consolidation')
      AND rating IN ('useful', 'unneeded')) OR
    (calibration_group IN ('proactive_silent', 'memory_skipped') AND rating IN ('useful', 'missed'))
  )
) STRICT;

INSERT INTO decision_prereviews (id, owner_id, agent_id, decision_id, mail_source, message_id, calibration_group, category, status, rating, confidence_permille, history_conflict, failure_code, model_ref, prompt_id, text_digest, data_classification, cost_micros, duration_ms, created_at)
SELECT id, owner_id, agent_id, decision_id, mail_source, message_id, calibration_group, category, status, rating, confidence_permille, history_conflict, failure_code, model_ref, prompt_id, text_digest, data_classification, cost_micros, duration_ms, created_at FROM decision_prereviews_keep;

CREATE UNIQUE INDEX decision_prereviews_decision_done
  ON decision_prereviews(decision_id, prompt_id, model_ref)
  WHERE status = 'done' AND decision_id IS NOT NULL;

CREATE UNIQUE INDEX decision_prereviews_mail_done
  ON decision_prereviews(owner_id, agent_id, mail_source, message_id, prompt_id, model_ref)
  WHERE status = 'done' AND message_id IS NOT NULL;

CREATE INDEX decision_prereviews_mail_index
  ON decision_prereviews(owner_id, agent_id, mail_source, message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX decision_prereviews_time_index
  ON decision_prereviews(owner_id, agent_id, created_at);

CREATE TRIGGER decision_prereviews_no_delete BEFORE DELETE ON decision_prereviews
WHEN EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)
  AND EXISTS (SELECT 1 FROM owners WHERE id = OLD.owner_id)
  AND (
    EXISTS (SELECT 1 FROM decision_ledger WHERE id = OLD.decision_id)
    OR EXISTS (
      SELECT 1 FROM proactive_processed_messages
      WHERE owner_id = OLD.owner_id AND agent_id = OLD.agent_id
        AND source = OLD.mail_source AND message_id = OLD.message_id
    )
  )
BEGIN SELECT RAISE(ABORT, 'DECISION_PREREVIEW_IMMUTABLE'); END;

CREATE TRIGGER decision_prereviews_no_update BEFORE UPDATE ON decision_prereviews
BEGIN SELECT RAISE(ABORT, 'DECISION_PREREVIEW_IMMUTABLE'); END;

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

INSERT INTO decision_signals (id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms, detail, source_ref, recorded_at)
SELECT id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms, detail, source_ref, recorded_at FROM decision_signals_keep;

CREATE INDEX decision_signals_decision_index ON decision_signals(decision_id, signal);

CREATE TRIGGER decision_signals_no_delete BEFORE DELETE ON decision_signals
WHEN EXISTS (SELECT 1 FROM decision_ledger WHERE id = OLD.decision_id)
  AND EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)
  AND EXISTS (SELECT 1 FROM owners WHERE id = OLD.owner_id)
BEGIN SELECT RAISE(ABORT, 'DECISION_SIGNAL_IMMUTABLE'); END;

CREATE TRIGGER decision_signals_no_update BEFORE UPDATE ON decision_signals
BEGIN SELECT RAISE(ABORT, 'DECISION_SIGNAL_IMMUTABLE'); END;

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

INSERT INTO muse_reference_entries (id, owner_id, agent_id, muse_at, muse_reminded, timing_ok, content_ok, content_ref, note_ref, paired_decision_id, intake_item_key, recorded_at, paired_message_id)
SELECT id, owner_id, agent_id, muse_at, muse_reminded, timing_ok, content_ok, content_ref, note_ref, paired_decision_id, intake_item_key, recorded_at, paired_message_id FROM muse_reference_entries_keep;

CREATE UNIQUE INDEX muse_reference_entries_intake_key_index
  ON muse_reference_entries(owner_id, agent_id, intake_item_key)
  WHERE intake_item_key IS NOT NULL;

CREATE INDEX muse_reference_entries_time_index ON muse_reference_entries(owner_id, agent_id, muse_at);

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

INSERT INTO source_insights (id, owner_id, agent_id, source, thread_id, last_message_id, result, floor_raised, content_ref, due_at, priority, status, decision_id, owner_rating, push_source_key, created_at, updated_at, push_class)
SELECT id, owner_id, agent_id, source, thread_id, last_message_id, result, floor_raised, content_ref, due_at, priority, status, decision_id, owner_rating, push_source_key, created_at, updated_at, push_class FROM source_insights_keep;

CREATE INDEX source_insights_push_class_index
  ON source_insights(owner_id, agent_id, push_class)
  WHERE push_class IS NOT NULL;

CREATE INDEX source_insights_status_index ON source_insights(owner_id, agent_id, status, due_at);

DROP TABLE decision_ledger_keep;
DROP TABLE decision_ledger_payloads_keep;
DROP TABLE proactive_processed_messages_keep;
DROP TABLE decision_prereviews_keep;
DROP TABLE decision_signals_keep;
DROP TABLE muse_reference_entries_keep;
DROP TABLE proactive_push_backoff_keep;
DROP TABLE source_insights_keep;

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
