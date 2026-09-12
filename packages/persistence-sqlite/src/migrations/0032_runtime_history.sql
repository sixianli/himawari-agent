CREATE TABLE run_payload_artifacts_next (
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('trace', 'context', 'final_answer', 'worker_result', 'runtime_history')),
  operation_key TEXT NOT NULL CHECK (length(trim(operation_key)) > 0),
  payload_ref TEXT NOT NULL CHECK (length(trim(payload_ref)) > 0),
  content_digest TEXT NOT NULL CHECK (length(trim(content_digest)) > 0),
  content_type TEXT NOT NULL CHECK (length(trim(content_type)) > 0),
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  history_sequence INTEGER NOT NULL DEFAULT 0 CHECK (history_sequence >= 0),
  PRIMARY KEY (owner_id, agent_id, run_id, purpose, operation_key),
  FOREIGN KEY (owner_id, agent_id, run_id) REFERENCES runs(owner_id, agent_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, agent_id, payload_ref) REFERENCES payloads(owner_id, agent_id, ref) ON DELETE RESTRICT
) STRICT;
INSERT INTO run_payload_artifacts_next (
  owner_id, agent_id, run_id, purpose, operation_key, payload_ref,
  content_digest, content_type, classification, created_at
) SELECT owner_id, agent_id, run_id, purpose, operation_key, payload_ref,
  content_digest, content_type, classification, created_at FROM run_payload_artifacts;
DROP TABLE run_payload_artifacts;
ALTER TABLE run_payload_artifacts_next RENAME TO run_payload_artifacts;
CREATE INDEX run_payload_artifacts_payload_ref ON run_payload_artifacts(owner_id, agent_id, payload_ref);
CREATE UNIQUE INDEX run_payload_artifacts_history_sequence
  ON run_payload_artifacts(owner_id, agent_id, run_id, history_sequence)
  WHERE history_sequence > 0;

ALTER TABLE thread_fork_lineage ADD COLUMN runtime_history_json TEXT;
