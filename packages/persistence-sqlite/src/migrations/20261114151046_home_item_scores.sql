CREATE TABLE home_item_scores (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  invocation_id TEXT NOT NULL CHECK (length(invocation_id) BETWEEN 1 AND 128),
  item_key TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 256),
  approval_request_id TEXT REFERENCES approval_requests(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('done', 'failed')),
  score INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 1000)),
  sentence_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  affirm_label TEXT CHECK (affirm_label IS NULL OR length(affirm_label) BETWEEN 1 AND 64),
  copy_locale TEXT CHECK (copy_locale IS NULL OR length(copy_locale) BETWEEN 2 AND 16),
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
  CHECK ((status = 'done') = (score IS NOT NULL)),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CHECK (sentence_ref IS NULL OR (status = 'done' AND approval_request_id IS NOT NULL)),
  CHECK (affirm_label IS NULL OR (status = 'done' AND approval_request_id IS NOT NULL)),
  CHECK ((copy_locale IS NOT NULL) = (sentence_ref IS NOT NULL OR affirm_label IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX home_item_scores_done
  ON home_item_scores(owner_id, agent_id, item_key, text_digest)
  WHERE status = 'done';

CREATE INDEX home_item_scores_item_index
  ON home_item_scores(owner_id, agent_id, item_key, created_at);

CREATE INDEX home_item_scores_time_index
  ON home_item_scores(owner_id, agent_id, created_at);

CREATE INDEX home_item_scores_approval_index
  ON home_item_scores(approval_request_id)
  WHERE approval_request_id IS NOT NULL;

CREATE INDEX home_item_scores_sentence_index
  ON home_item_scores(sentence_ref)
  WHERE sentence_ref IS NOT NULL;

CREATE TRIGGER home_item_scores_no_update BEFORE UPDATE ON home_item_scores
BEGIN SELECT RAISE(ABORT, 'HOME_ITEM_SCORE_IMMUTABLE'); END;

CREATE TRIGGER home_item_scores_no_delete BEFORE DELETE ON home_item_scores
WHEN EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)
  AND EXISTS (SELECT 1 FROM owners WHERE id = OLD.owner_id)
  AND (
    OLD.approval_request_id IS NULL
    OR EXISTS (SELECT 1 FROM approval_requests WHERE id = OLD.approval_request_id)
  )
BEGIN SELECT RAISE(ABORT, 'HOME_ITEM_SCORE_IMMUTABLE'); END;

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
      'memory-consolidation', 'mail-judgment', 'action-review', 'review-prereview',
      'rule-review', 'home-urgency', 'other'
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
