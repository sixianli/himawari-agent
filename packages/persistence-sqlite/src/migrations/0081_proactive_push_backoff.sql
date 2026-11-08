ALTER TABLE source_insights ADD COLUMN push_class TEXT
  CHECK (push_class IS NULL OR length(push_class) BETWEEN 1 AND 128);

CREATE INDEX source_insights_push_class_index
  ON source_insights(owner_id, agent_id, push_class)
  WHERE push_class IS NOT NULL;

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
