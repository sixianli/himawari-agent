-- No historical proof is manufactured. Existing rows require fresh host verification.
CREATE TABLE sandbox_release_receipts (
  job_id TEXT PRIMARY KEY REFERENCES sandbox_execution_records(job_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  accepted_at TEXT NOT NULL,
  verification_json TEXT NOT NULL CHECK(json_valid(verification_json)),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
  FOREIGN KEY(job_id, sequence) REFERENCES sandbox_execution_observations(job_id, sequence)
) STRICT;
CREATE TRIGGER sandbox_release_receipt_immutable BEFORE UPDATE ON sandbox_release_receipts
BEGIN SELECT RAISE(ABORT, 'Accepted sandbox release is immutable'); END;
CREATE TRIGGER sandbox_occupancy_release_monotonic BEFORE UPDATE OF released_at ON sandbox_workspace_occupancy
WHEN OLD.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at
BEGIN SELECT RAISE(ABORT, 'Workspace release cannot be revoked'); END;

-- Separate protections for later evidence and dispatched control messages.
CREATE TABLE sandbox_workspace_barriers (
  job_id TEXT NOT NULL REFERENCES sandbox_execution_records(job_id) ON DELETE CASCADE,
  barrier_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('control_unacknowledged')),
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY(job_id, barrier_id)
) STRICT;
CREATE INDEX sandbox_workspace_barriers_pending ON sandbox_workspace_barriers(job_id)
  WHERE resolved_at IS NULL;
CREATE TRIGGER sandbox_barrier_delete_guard BEFORE DELETE ON sandbox_execution_records
WHEN EXISTS(SELECT 1 FROM sandbox_workspace_barriers WHERE job_id=OLD.job_id AND resolved_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'Unresolved sandbox barrier cannot be deleted'); END;

-- Recovery belongs to the existing durable execution record, with no new execution authority.
ALTER TABLE sandbox_execution_records ADD COLUMN recovery_json TEXT
  CHECK(recovery_json IS NULL OR json_valid(recovery_json));
