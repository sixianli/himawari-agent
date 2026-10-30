CREATE TABLE model_usage_observations (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL CHECK (length(trim(run_id)) > 0),
  invocation_id TEXT NOT NULL CHECK (length(trim(invocation_id)) > 0),
  purpose TEXT NOT NULL CHECK (
    purpose IN (
      'chat', 'thread-title', 'memory-capture', 'memory-episode',
      'memory-consolidation', 'mail-judgment', 'action-review', 'other'
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

CREATE INDEX model_usage_observations_time_index
  ON model_usage_observations(owner_id, agent_id, occurred_at);
