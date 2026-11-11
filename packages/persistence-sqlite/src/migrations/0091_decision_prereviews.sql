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

CREATE UNIQUE INDEX decision_prereviews_decision_done
  ON decision_prereviews(decision_id, prompt_id, model_ref)
  WHERE status = 'done' AND decision_id IS NOT NULL;

CREATE UNIQUE INDEX decision_prereviews_mail_done
  ON decision_prereviews(owner_id, agent_id, mail_source, message_id, prompt_id, model_ref)
  WHERE status = 'done' AND message_id IS NOT NULL;

CREATE INDEX decision_prereviews_time_index
  ON decision_prereviews(owner_id, agent_id, created_at);

CREATE INDEX decision_prereviews_mail_index
  ON decision_prereviews(owner_id, agent_id, mail_source, message_id)
  WHERE message_id IS NOT NULL;

CREATE TRIGGER decision_prereviews_no_update BEFORE UPDATE ON decision_prereviews
BEGIN SELECT RAISE(ABORT, 'DECISION_PREREVIEW_IMMUTABLE'); END;

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

CREATE TABLE model_usage_observations_keep AS SELECT * FROM model_usage_observations;

DROP TABLE model_usage_observations;

CREATE TABLE model_usage_observations (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL CHECK (length(trim(run_id)) > 0),
  invocation_id TEXT NOT NULL CHECK (length(trim(invocation_id)) > 0),
  purpose TEXT NOT NULL CHECK (
    purpose IN (
      'chat', 'thread-title', 'memory-capture', 'memory-episode',
      'memory-consolidation', 'mail-judgment', 'action-review', 'review-prereview', 'other'
    )
  ),
  source TEXT NOT NULL CHECK (source IN ('model-port', 'agent-stream')),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0 AND input_tokens <= 9007199254740991),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0 AND output_tokens <= 9007199254740991),
  cache_read_tokens INTEGER NOT NULL CHECK (
    cache_read_tokens >= 0 AND cache_read_tokens <= input_tokens
  ),
  cache_write_tokens INTEGER NOT NULL CHECK (
    cache_write_tokens >= 0 AND cache_write_tokens <= input_tokens - cache_read_tokens
  ),
  cache_reported INTEGER NOT NULL CHECK (cache_reported IN (0, 1)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, run_id, invocation_id),
  CHECK (cache_reported = 1 OR (cache_read_tokens = 0 AND cache_write_tokens = 0))
) STRICT;

INSERT INTO model_usage_observations (owner_id, agent_id, run_id, invocation_id, purpose, source, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_reported, occurred_at)
SELECT owner_id, agent_id, run_id, invocation_id, purpose, source, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_reported, occurred_at FROM model_usage_observations_keep;

DROP TABLE model_usage_observations_keep;

CREATE INDEX model_usage_observations_time_index
  ON model_usage_observations(owner_id, agent_id, occurred_at);
