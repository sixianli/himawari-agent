-- Preserve every existing protection and accepted release; no inferred repairs.
DROP TRIGGER sandbox_barrier_delete_guard;
ALTER TABLE sandbox_workspace_barriers RENAME TO sandbox_workspace_barriers_v41;
DROP INDEX sandbox_workspace_barriers_pending;
CREATE TABLE sandbox_workspace_barriers (
  job_id TEXT NOT NULL REFERENCES sandbox_execution_records(job_id) ON DELETE CASCADE,
  barrier_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('control_unacknowledged','resource_contradiction')),
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  verification_json TEXT CHECK(verification_json IS NULL OR json_valid(verification_json)),
  authority_json TEXT CHECK(authority_json IS NULL OR json_valid(authority_json)),
  resolution_json TEXT CHECK(resolution_json IS NULL OR json_valid(resolution_json)),
  CHECK(kind != 'resource_contradiction' OR (verification_json IS NOT NULL AND authority_json IS NOT NULL)),
  PRIMARY KEY(job_id, barrier_id)
) STRICT;
INSERT INTO sandbox_workspace_barriers(job_id,barrier_id,kind,reason_code,created_at,resolved_at)
SELECT job_id,barrier_id,kind,reason_code,created_at,resolved_at FROM sandbox_workspace_barriers_v41;
DROP TABLE sandbox_workspace_barriers_v41;
CREATE INDEX sandbox_workspace_barriers_pending ON sandbox_workspace_barriers(job_id)
  WHERE resolved_at IS NULL;
CREATE TRIGGER sandbox_barrier_delete_guard BEFORE DELETE ON sandbox_execution_records
WHEN EXISTS(SELECT 1 FROM sandbox_workspace_barriers WHERE job_id=OLD.job_id AND resolved_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'Unresolved sandbox barrier cannot be deleted'); END;
CREATE TRIGGER sandbox_resource_incident_immutable BEFORE UPDATE ON sandbox_workspace_barriers
WHEN OLD.kind='resource_contradiction' AND (
  NEW.job_id IS NOT OLD.job_id OR NEW.barrier_id IS NOT OLD.barrier_id OR
  NEW.kind IS NOT OLD.kind OR NEW.reason_code IS NOT OLD.reason_code OR
  NEW.created_at IS NOT OLD.created_at OR NEW.verification_json IS NOT OLD.verification_json OR NEW.authority_json IS NOT OLD.authority_json OR
  (OLD.resolved_at IS NOT NULL AND (NEW.resolved_at IS NOT OLD.resolved_at OR NEW.resolution_json IS NOT OLD.resolution_json)) OR
  (NEW.resolved_at IS NOT NULL AND NEW.resolution_json IS NULL)
)
BEGIN SELECT RAISE(ABORT, 'Resource incident evidence is immutable'); END;
