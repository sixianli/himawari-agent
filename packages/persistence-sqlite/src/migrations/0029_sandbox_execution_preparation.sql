-- Existing v2 observations retain their original interpretation. New admissions
-- reserve identity/occupancy before a Worker has compiled a runtime policy.
ALTER TABLE sandbox_execution_records ADD COLUMN preparation_state TEXT NOT NULL DEFAULT 'legacy_bound'
  CHECK(preparation_state IN ('legacy_bound','reserved','bound'));
CREATE TRIGGER sandbox_preparation_transition BEFORE UPDATE OF preparation_state ON sandbox_execution_records
WHEN NEW.preparation_state != OLD.preparation_state
 AND NOT (OLD.preparation_state='reserved' AND NEW.preparation_state='bound'
          AND NEW.started_at IS NOT NULL AND NEW.start_policy_digest IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'Invalid sandbox preparation transition'); END;
CREATE TRIGGER sandbox_start_binding_immutable BEFORE UPDATE ON sandbox_execution_records
WHEN OLD.preparation_state='bound' AND
 (NEW.started_at IS NOT OLD.started_at OR NEW.start_policy_digest IS NOT OLD.start_policy_digest
  OR json_extract(NEW.facts_json,'$.environment') IS NOT json_extract(OLD.facts_json,'$.environment'))
BEGIN SELECT RAISE(ABORT,'Sandbox runtime binding is immutable'); END;
