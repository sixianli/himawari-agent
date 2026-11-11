CREATE TABLE real_eval_questions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  memory_revision INTEGER NOT NULL CHECK (memory_revision >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'time', 'abstain')),
  question_ref TEXT NOT NULL UNIQUE REFERENCES payloads(ref) ON DELETE RESTRICT,
  question_model TEXT NOT NULL CHECK (length(question_model) BETWEEN 1 AND 256),
  prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  retired_at TEXT CHECK (retired_at IS NULL OR retired_at GLOB '????-??-??T??:??:??.???Z'),
  retired_reason TEXT CHECK (
    retired_reason IS NULL OR
    retired_reason IN (
      'memory_inactive', 'memory_tentative', 'memory_superseded', 'memory_expired',
      'memory_not_visible', 'memory_revised'
    )
  ),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL)),
  UNIQUE (memory_id, memory_revision, kind)
) STRICT;

CREATE INDEX real_eval_questions_scope_index
  ON real_eval_questions(owner_id, agent_id, retired_at, created_at);

CREATE TABLE real_eval_runs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??.???Z'),
  finished_at TEXT NOT NULL CHECK (finished_at GLOB '????-??-??T??:??:??.???Z'),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'budget_exceeded', 'failed')),
  trigger TEXT NOT NULL CHECK (trigger IN ('weekly', 'manual')),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
  cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0 AND cost_micros <= 9007199254740991),
  summary TEXT NOT NULL CHECK (json_valid(summary) AND json_type(summary) = 'object')
) STRICT;

CREATE INDEX real_eval_runs_scope_index ON real_eval_runs(owner_id, agent_id, started_at);
