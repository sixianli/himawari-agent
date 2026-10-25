DROP TRIGGER execution_environment_release_final;
DROP TRIGGER execution_environment_lease_release;
CREATE TABLE execution_environment_release_receipts_next (
  environment_id TEXT PRIMARY KEY REFERENCES execution_environments(environment_id) ON DELETE CASCADE,
  basis TEXT NOT NULL CHECK(basis IN ('create_not_dispatched','never_created','verified_stopped','process_group_gone')),
  stop_fence INTEGER NOT NULL,
  accepted_at TEXT NOT NULL,
  proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
  CHECK((basis = 'create_not_dispatched') = (proof_json IS NULL)),
  FOREIGN KEY(environment_id, stop_fence) REFERENCES execution_environment_stop_intents(environment_id, stop_fence)
) STRICT;
INSERT INTO execution_environment_release_receipts_next(environment_id,basis,stop_fence,accepted_at,proof_json,authority_json)
  SELECT environment_id,basis,stop_fence,accepted_at,proof_json,authority_json
  FROM execution_environment_release_receipts;
DROP TABLE execution_environment_release_receipts;
ALTER TABLE execution_environment_release_receipts_next RENAME TO execution_environment_release_receipts;
CREATE TRIGGER execution_environment_release_final BEFORE UPDATE OF state ON execution_environments
WHEN (OLD.state = 'released' AND NEW.state != 'released')
  OR (NEW.state = 'released' AND OLD.state != 'released' AND NOT EXISTS(
    SELECT 1 FROM execution_environment_release_receipts WHERE environment_id = NEW.environment_id))
BEGIN SELECT RAISE(ABORT, 'Execution environment release requires an accepted release receipt'); END;
CREATE TRIGGER execution_environment_lease_release BEFORE UPDATE OF released_at ON execution_environment_leases
WHEN (OLD.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at)
  OR (NEW.released_at IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM execution_environment_release_receipts WHERE environment_id = NEW.environment_id))
BEGIN SELECT RAISE(ABORT, 'Environment lease release requires an accepted release receipt'); END;
CREATE TRIGGER execution_environment_release_receipt_immutable BEFORE UPDATE ON execution_environment_release_receipts
BEGIN SELECT RAISE(ABORT, 'Accepted environment release is immutable'); END;
