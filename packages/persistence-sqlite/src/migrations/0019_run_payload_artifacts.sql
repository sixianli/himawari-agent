CREATE TABLE run_payload_artifacts (
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('trace', 'context', 'final_answer', 'worker_result')),
  operation_key TEXT NOT NULL CHECK (length(trim(operation_key)) > 0),
  payload_ref TEXT NOT NULL CHECK (length(trim(payload_ref)) > 0),
  content_digest TEXT NOT NULL CHECK (length(trim(content_digest)) > 0),
  content_type TEXT NOT NULL CHECK (length(trim(content_type)) > 0),
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  PRIMARY KEY (owner_id, agent_id, run_id, purpose, operation_key),
  FOREIGN KEY (owner_id, agent_id, run_id)
    REFERENCES runs(owner_id, agent_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, agent_id, payload_ref)
    REFERENCES payloads(owner_id, agent_id, ref) ON DELETE RESTRICT
) STRICT;

CREATE INDEX run_payload_artifacts_payload_ref
  ON run_payload_artifacts(owner_id, agent_id, payload_ref);
