CREATE TABLE perception_extractions (
  episode_id TEXT PRIMARY KEY REFERENCES perception_episodes(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'done', 'retry', 'waiting_budget', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  next_attempt_at TEXT
    CHECK (next_attempt_at IS NULL OR next_attempt_at GLOB '????-??-??T??:??:??.???Z'),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK ((status IN ('done', 'failed')) = (next_attempt_at IS NULL))
) STRICT;

CREATE INDEX perception_extractions_status_index
  ON perception_extractions(owner_id, agent_id, status, next_attempt_at);

CREATE TABLE perception_command_utterances (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  utterance_id TEXT NOT NULL CHECK (length(utterance_id) BETWEEN 1 AND 64),
  recorded_at TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (owner_id, agent_id, utterance_id)
) STRICT;
