CREATE TABLE execution_jobs (
  execution_job_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, agent_id, run_id),
  FOREIGN KEY(owner_id, agent_id, run_id) REFERENCES runs(owner_id, agent_id, id) ON DELETE CASCADE
) STRICT;
CREATE TABLE execution_environments (
  environment_id TEXT PRIMARY KEY,
  execution_job_id TEXT NOT NULL REFERENCES execution_jobs(execution_job_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('primary','network_helper')),
  generation INTEGER NOT NULL CHECK(generation >= 1 AND generation <= 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('reserved','creating','ready','running','unknown','stop_requested','released')),
  rotation_reason TEXT NOT NULL CHECK(rotation_reason IN ('initial','expansion','revocation','expiry','failure')),
  backend_ref TEXT NOT NULL,
  envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
  envelope_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  image_digest TEXT NOT NULL,
  runner_digest TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  create_intent_id TEXT NOT NULL UNIQUE,
  create_dispatched_at TEXT,
  locator_json TEXT CHECK(locator_json IS NULL OR json_valid(locator_json)),
  stop_fence INTEGER NOT NULL DEFAULT 0 CHECK(stop_fence >= 0 AND stop_fence <= 9007199254740991),
  reason_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(execution_job_id, role, generation),
  CHECK((generation = 1) = (rotation_reason = 'initial')),
  CHECK(state NOT IN ('creating','unknown') OR create_dispatched_at IS NOT NULL),
  CHECK(state NOT IN ('ready','running') OR (locator_json IS NOT NULL AND stop_fence = 0))
) STRICT;
CREATE INDEX execution_environments_unreleased ON execution_environments(environment_id)
  WHERE state != 'released';
CREATE TABLE execution_environment_stop_intents (
  environment_id TEXT NOT NULL REFERENCES execution_environments(environment_id) ON DELETE CASCADE,
  stop_fence INTEGER NOT NULL CHECK(stop_fence >= 1),
  stop_intent_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK(reason IN ('run_finished','run_cancelled','expansion','revocation','expiry','failure','supervision_lost')),
  stopped_resource_refs_json TEXT NOT NULL CHECK(json_valid(stopped_resource_refs_json)),
  requested_at TEXT NOT NULL,
  acknowledged_at TEXT,
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
  PRIMARY KEY(environment_id, stop_fence)
) STRICT;
CREATE TABLE execution_environment_leases (
  environment_id TEXT NOT NULL REFERENCES execution_environments(environment_id) ON DELETE CASCADE,
  scope_ref TEXT NOT NULL,
  host_id TEXT NOT NULL,
  claim_json TEXT NOT NULL CHECK(json_valid(claim_json)),
  released_at TEXT,
  PRIMARY KEY(environment_id, scope_ref)
) STRICT;
CREATE INDEX execution_environment_leases_host ON execution_environment_leases(host_id)
  WHERE released_at IS NULL;
CREATE TABLE execution_environment_calls (
  environment_id TEXT NOT NULL REFERENCES execution_environments(environment_id) ON DELETE CASCADE,
  invocation_id TEXT NOT NULL,
  receipt_ref TEXT NOT NULL UNIQUE REFERENCES capability_invocation_receipts(receipt_ref) ON DELETE CASCADE,
  claims_json TEXT NOT NULL CHECK(json_valid(claims_json)),
  linked_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(environment_id, invocation_id)
) STRICT;
CREATE TABLE execution_environment_release_receipts (
  environment_id TEXT PRIMARY KEY REFERENCES execution_environments(environment_id) ON DELETE CASCADE,
  basis TEXT NOT NULL CHECK(basis IN ('create_not_dispatched','never_created','verified_stopped')),
  stop_fence INTEGER NOT NULL,
  accepted_at TEXT NOT NULL,
  proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
  CHECK((basis = 'create_not_dispatched') = (proof_json IS NULL)),
  FOREIGN KEY(environment_id, stop_fence) REFERENCES execution_environment_stop_intents(environment_id, stop_fence)
) STRICT;

CREATE TRIGGER execution_environment_identity_immutable BEFORE UPDATE ON execution_environments
WHEN NEW.execution_job_id IS NOT OLD.execution_job_id OR NEW.role IS NOT OLD.role
  OR NEW.generation IS NOT OLD.generation OR NEW.rotation_reason IS NOT OLD.rotation_reason
  OR NEW.backend_ref IS NOT OLD.backend_ref OR NEW.envelope_json IS NOT OLD.envelope_json
  OR NEW.envelope_digest IS NOT OLD.envelope_digest OR NEW.policy_digest IS NOT OLD.policy_digest
  OR NEW.image_digest IS NOT OLD.image_digest OR NEW.runner_digest IS NOT OLD.runner_digest
  OR NEW.deadline_at IS NOT OLD.deadline_at OR NEW.create_intent_id IS NOT OLD.create_intent_id
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.create_dispatched_at IS NOT NULL AND NEW.create_dispatched_at IS NOT OLD.create_dispatched_at)
  OR (OLD.locator_json IS NOT NULL AND NEW.locator_json IS NOT OLD.locator_json)
BEGIN SELECT RAISE(ABORT, 'Execution environment identity is immutable'); END;
CREATE TRIGGER execution_environment_fence_monotonic BEFORE UPDATE OF stop_fence ON execution_environments
WHEN NEW.stop_fence < OLD.stop_fence
BEGIN SELECT RAISE(ABORT, 'Execution environment stop fence cannot move backwards'); END;
CREATE TRIGGER execution_environment_create_after_stop BEFORE UPDATE OF create_dispatched_at ON execution_environments
WHEN OLD.create_dispatched_at IS NULL AND NEW.create_dispatched_at IS NOT NULL AND OLD.stop_fence != 0
BEGIN SELECT RAISE(ABORT, 'Stopped execution environment cannot dispatch creation'); END;
CREATE TRIGGER execution_environment_release_final BEFORE UPDATE OF state ON execution_environments
WHEN (OLD.state = 'released' AND NEW.state != 'released')
  OR (NEW.state = 'released' AND OLD.state != 'released' AND NOT EXISTS(
    SELECT 1 FROM execution_environment_release_receipts WHERE environment_id = NEW.environment_id))
BEGIN SELECT RAISE(ABORT, 'Execution environment release requires an accepted release receipt'); END;
CREATE TRIGGER execution_environment_previous_released BEFORE INSERT ON execution_environments
WHEN NEW.generation > 1 AND NOT EXISTS(
  SELECT 1 FROM execution_environments p WHERE p.execution_job_id = NEW.execution_job_id
    AND p.role = NEW.role AND p.generation = NEW.generation - 1 AND p.state = 'released')
BEGIN SELECT RAISE(ABORT, 'Next execution environment requires the previous release'); END;
CREATE TRIGGER execution_environment_lease_release BEFORE UPDATE OF released_at ON execution_environment_leases
WHEN (OLD.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at)
  OR (NEW.released_at IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM execution_environment_release_receipts WHERE environment_id = NEW.environment_id))
BEGIN SELECT RAISE(ABORT, 'Environment lease release requires an accepted release receipt'); END;
CREATE TRIGGER execution_environment_release_receipt_immutable BEFORE UPDATE ON execution_environment_release_receipts
BEGIN SELECT RAISE(ABORT, 'Accepted environment release is immutable'); END;
CREATE TRIGGER execution_environment_stop_intent_immutable BEFORE UPDATE ON execution_environment_stop_intents
WHEN NEW.stop_intent_id IS NOT OLD.stop_intent_id OR NEW.reason IS NOT OLD.reason
  OR NEW.stopped_resource_refs_json IS NOT OLD.stopped_resource_refs_json
  OR NEW.requested_at IS NOT OLD.requested_at OR NEW.authority_json IS NOT OLD.authority_json
  OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS NOT OLD.acknowledged_at)
BEGIN SELECT RAISE(ABORT, 'Environment stop intent is immutable'); END;
CREATE TRIGGER execution_environment_delete_guard BEFORE DELETE ON execution_environments
WHEN OLD.state != 'released'
  OR EXISTS(SELECT 1 FROM execution_environment_leases WHERE environment_id = OLD.environment_id AND released_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'Unreleased execution environment cannot be deleted'); END;
