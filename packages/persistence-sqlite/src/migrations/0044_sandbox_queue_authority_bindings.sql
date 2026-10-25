-- Keep the original queued request and every authority binding as separate facts.
-- A schema-43 writer cannot interpret bindings and must not admit this queue.
CREATE TABLE sandbox_queue_authority_bindings (
  job_id TEXT NOT NULL REFERENCES sandbox_admission_queue(job_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, revision)
) STRICT;

CREATE TRIGGER sandbox_queue_bindings_no_update BEFORE UPDATE ON sandbox_queue_authority_bindings
BEGIN SELECT RAISE(ABORT, 'Queue authority bindings are immutable'); END;
CREATE TRIGGER sandbox_queue_bindings_no_delete BEFORE DELETE ON sandbox_queue_authority_bindings
BEGIN SELECT RAISE(ABORT, 'Queue authority bindings cannot be deleted'); END;

CREATE TRIGGER sandbox_queue_original_request_immutable
BEFORE UPDATE OF job_id, owner_id, agent_id, run_id, host_id, handle_ref,
  deadline_at, sequence, request_json, claims_json ON sandbox_admission_queue
BEGIN SELECT RAISE(ABORT, 'Original queue request is immutable'); END;
