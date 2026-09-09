-- v1 rows retain their original interpretation. v2 uses the same invocation authority.
CREATE TABLE sandbox_execution_records (
  job_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  receipt_ref TEXT NOT NULL UNIQUE REFERENCES capability_invocation_receipts(receipt_ref) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL UNIQUE,
  resource_ref TEXT UNIQUE,
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  admission_json TEXT NOT NULL CHECK(json_valid(admission_json)),
  start_policy_digest TEXT,
  started_at TEXT,
  facts_json TEXT NOT NULL CHECK(json_valid(facts_json)),
  sequence INTEGER NOT NULL CHECK(sequence >= 1 AND sequence <= 9007199254740991),
  operation_revision INTEGER NOT NULL DEFAULT 0 CHECK(operation_revision >= 0 AND operation_revision <= 9007199254740991),
  UNIQUE(owner_id, agent_id, run_id, invocation_id),
  FOREIGN KEY(owner_id, agent_id, run_id) REFERENCES runs(owner_id, agent_id, id) ON DELETE CASCADE,
  CHECK((start_policy_digest IS NULL) = (started_at IS NULL))
) STRICT;
CREATE TABLE sandbox_execution_observations (
  job_id TEXT NOT NULL REFERENCES sandbox_execution_records(job_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence >= 1 AND sequence <= 9007199254740991),
  facts_json TEXT NOT NULL CHECK(json_valid(facts_json)),
  PRIMARY KEY(job_id, sequence)
) STRICT;
CREATE TABLE sandbox_workspace_occupancy (
  job_id TEXT NOT NULL REFERENCES sandbox_execution_records(job_id) ON DELETE CASCADE,
  scope_ref TEXT NOT NULL,
  host_id TEXT NOT NULL,
  claim_json TEXT NOT NULL CHECK(json_valid(claim_json)),
  released_at TEXT,
  PRIMARY KEY(job_id, scope_ref)
) STRICT;
CREATE INDEX sandbox_workspace_host ON sandbox_workspace_occupancy(host_id) WHERE released_at IS NULL;
CREATE TABLE sandbox_execution_intents (
  intent_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES sandbox_execution_records(job_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('tool_result', 'continue')),
  sequence INTEGER NOT NULL,
  operation_revision INTEGER NOT NULL CHECK(operation_revision >= 0 AND operation_revision <= 9007199254740991),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  acknowledged_at TEXT,
  observation_json TEXT CHECK(observation_json IS NULL OR json_valid(observation_json)),
  CHECK(acknowledged_at IS NULL OR dispatched_at IS NOT NULL),
  CHECK(observation_json IS NULL OR dispatched_at IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX sandbox_single_tool_delivery ON sandbox_execution_intents(job_id) WHERE kind = 'tool_result';
-- Old jobs have no verified directory lineage. Their host remains blocked until
-- the old contract confirms cleanup. A missing host conservatively blocks all hosts.
CREATE TABLE sandbox_legacy_occupancy (
  job_id TEXT PRIMARY KEY REFERENCES sandbox_jobs(job_id) ON DELETE CASCADE,
  host_id TEXT,
  released_at TEXT
) STRICT;
INSERT INTO sandbox_legacy_occupancy(job_id, host_id)
  SELECT job_id, json_extract(plan_json, '$.identity.hostId') FROM sandbox_jobs
  WHERE json_extract(observation_json, '$.state') NOT IN ('completed','failed')
     OR json_extract(observation_json, '$.state') IS NULL
     OR coalesce(json_extract(observation_json, '$.cleanup'), '') != 'confirmed';
CREATE TRIGGER sandbox_legacy_insert AFTER INSERT ON sandbox_jobs
WHEN json_extract(NEW.observation_json, '$.state') NOT IN ('completed','failed')
 OR json_extract(NEW.observation_json, '$.state') IS NULL
 OR coalesce(json_extract(NEW.observation_json, '$.cleanup'), '') != 'confirmed'
BEGIN
  INSERT INTO sandbox_legacy_occupancy(job_id, host_id)
  VALUES (NEW.job_id, json_extract(NEW.plan_json, '$.identity.hostId'));
END;
CREATE TRIGGER sandbox_legacy_release AFTER UPDATE OF observation_json ON sandbox_jobs
WHEN json_extract(NEW.observation_json, '$.state') IN ('completed','failed')
 AND json_extract(NEW.observation_json, '$.cleanup') = 'confirmed'
BEGIN
  UPDATE sandbox_legacy_occupancy SET released_at = json_extract(NEW.observation_json, '$.occurredAt') WHERE job_id = NEW.job_id;
END;

CREATE TABLE sandbox_operation_observations (
  job_id TEXT NOT NULL REFERENCES sandbox_execution_records(job_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 1 AND revision <= 9007199254740991),
  operation_json TEXT NOT NULL CHECK(json_valid(operation_json)),
  PRIMARY KEY(job_id, revision)
) STRICT;

CREATE TRIGGER sandbox_execution_delete_guard BEFORE DELETE ON sandbox_execution_records
WHEN EXISTS(SELECT 1 FROM sandbox_workspace_occupancy WHERE job_id=OLD.job_id AND released_at IS NULL)
  OR EXISTS(SELECT 1 FROM sandbox_execution_intents WHERE job_id=OLD.job_id AND dispatched_at IS NOT NULL AND acknowledged_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'Unresolved sandbox resource cannot be deleted'); END;
CREATE TRIGGER sandbox_legacy_delete_guard BEFORE DELETE ON sandbox_jobs
WHEN EXISTS(SELECT 1 FROM sandbox_legacy_occupancy WHERE job_id=OLD.job_id AND released_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'Unresolved legacy sandbox resource cannot be deleted'); END;
