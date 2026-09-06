-- Preserve dependent rows before rebuilding the account parent constraint.
CREATE TEMP TABLE saved_model_invocation_identities AS SELECT * FROM model_invocation_identities;
CREATE TEMP TABLE saved_model_budget_allocations AS SELECT * FROM model_budget_allocations;
CREATE TEMP TABLE saved_model_budget_accounts AS SELECT * FROM model_budget_accounts;
DROP TABLE model_invocation_identities;
DROP TABLE model_budget_allocations;
DROP TABLE model_budget_accounts;
CREATE TABLE model_budget_accounts (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL CHECK (length(trim(account_id)) > 0),
  parent_kind TEXT NOT NULL CHECK (parent_kind IN ('run', 'occurrence', 'memory-projection')),
  run_id TEXT,
  occurrence_id TEXT,
  projection_job_id TEXT REFERENCES memory_projection_jobs(id) ON DELETE CASCADE,
  data_classification TEXT NOT NULL
    CHECK (data_classification IN ('public', 'private', 'sensitive', 'restricted')),
  reserved_cost_micros INTEGER NOT NULL
    CHECK (reserved_cost_micros >= 0 AND reserved_cost_micros <= 9007199254740991),
  spent_cost_micros INTEGER NOT NULL
    CHECK (spent_cost_micros >= 0 AND spent_cost_micros <= 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('active', 'reconcile_required', 'over_budget')),
  revision INTEGER NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991),
  CHECK (reserved_cost_micros <= 9007199254740991 - spent_cost_micros),
  PRIMARY KEY (owner_id, agent_id, account_id),
  UNIQUE (owner_id, agent_id, run_id),
  UNIQUE (owner_id, agent_id, occurrence_id),
  UNIQUE (owner_id, agent_id, projection_job_id),
  CHECK (
    (parent_kind = 'run' AND run_id IS NOT NULL AND occurrence_id IS NULL AND projection_job_id IS NULL) OR
    (parent_kind = 'occurrence' AND run_id IS NULL AND occurrence_id IS NOT NULL AND projection_job_id IS NULL) OR
    (parent_kind = 'memory-projection' AND run_id IS NULL AND occurrence_id IS NULL AND projection_job_id IS NOT NULL)
  ),
  CHECK (
    (parent_kind = 'run' AND account_id = 'run:' || run_id) OR
    (parent_kind = 'occurrence' AND account_id = 'occurrence:' || occurrence_id) OR
    (parent_kind = 'memory-projection' AND account_id = 'memory-projection:' || projection_job_id)
  ),
  FOREIGN KEY (owner_id, agent_id, run_id)
    REFERENCES runs(owner_id, agent_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, agent_id, occurrence_id)
    REFERENCES job_occurrences(owner_id, agent_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE model_budget_allocations (
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation_key TEXT NOT NULL CHECK (length(trim(operation_key)) > 0),
  model_ref TEXT NOT NULL CHECK (length(trim(model_ref)) > 0),
  data_classification TEXT NOT NULL
    CHECK (data_classification IN ('public', 'private', 'sensitive', 'restricted')),
  estimated_cost_micros INTEGER NOT NULL
    CHECK (estimated_cost_micros >= 0 AND estimated_cost_micros <= 9007199254740991),
  actual_cost_micros INTEGER
    CHECK (actual_cost_micros IS NULL OR
      (actual_cost_micros >= 0 AND actual_cost_micros <= 9007199254740991)),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'started', 'unknown', 'settled', 'released')),
  reserved_at TEXT NOT NULL,
  started_at TEXT,
  observed_at TEXT,
  settled_at TEXT,
  reason_code TEXT CHECK (reason_code IN (
    'provider_unresolved', 'transport_unresolved', 'cancel_unresolved'
  )),
  PRIMARY KEY (owner_id, agent_id, account_id, operation_key),
  FOREIGN KEY (owner_id, agent_id, account_id)
    REFERENCES model_budget_accounts(owner_id, agent_id, account_id) ON DELETE CASCADE,
  CHECK (
    (status IN ('reserved', 'started', 'settled', 'released') AND reason_code IS NULL) OR
    (status = 'unknown' AND reason_code IS NOT NULL)
  ),
  CHECK (
    (status = 'settled' AND actual_cost_micros IS NOT NULL AND settled_at IS NOT NULL) OR
    (status <> 'settled' AND actual_cost_micros IS NULL AND settled_at IS NULL)
  ),
  CHECK (status <> 'unknown' OR observed_at IS NOT NULL)
) STRICT;

CREATE INDEX model_budget_accounts_scope
  ON model_budget_accounts(owner_id, agent_id, status);

CREATE INDEX model_budget_allocations_scope
  ON model_budget_allocations(owner_id, agent_id, status);

CREATE TABLE model_invocation_identities (
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  logical_slot TEXT NOT NULL CHECK (length(trim(logical_slot)) > 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 1 AND sequence <= 9007199254740991),
  invocation_id TEXT NOT NULL CHECK (length(trim(invocation_id)) > 0),
  model_ref TEXT NOT NULL CHECK (length(trim(model_ref)) > 0),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  model_version TEXT,
  data_classification TEXT NOT NULL
    CHECK (data_classification IN ('public', 'private', 'sensitive', 'restricted')),
  source TEXT NOT NULL CHECK (source IN ('model-port', 'agent-stream', 'embedding')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 9007199254740991),
  pricing_input REAL NOT NULL CHECK (pricing_input >= 0),
  pricing_output REAL NOT NULL CHECK (pricing_output >= 0),
  pricing_cache_read REAL NOT NULL CHECK (pricing_cache_read >= 0),
  pricing_cache_write REAL NOT NULL CHECK (pricing_cache_write >= 0),
  pricing_fingerprint TEXT NOT NULL CHECK (length(trim(pricing_fingerprint)) > 0),
  estimated_cost_micros INTEGER NOT NULL
    CHECK (estimated_cost_micros >= 0 AND estimated_cost_micros <= 9007199254740991),
  budget_account_id TEXT NOT NULL CHECK (length(trim(budget_account_id)) > 0),
  budget_operation_key TEXT NOT NULL CHECK (length(trim(budget_operation_key)) > 0),
  authority_lease_id TEXT NOT NULL,
  authority_deployment_id TEXT NOT NULL,
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1 AND authority_epoch <= 9007199254740991),
  authority_fencing_token INTEGER NOT NULL
    CHECK (authority_fencing_token >= 1 AND authority_fencing_token <= 9007199254740991),
  execution_lease_id TEXT NOT NULL CHECK (length(trim(execution_lease_id)) > 0),
  execution_expected_lease_revision INTEGER NOT NULL
    CHECK (execution_expected_lease_revision >= 0 AND execution_expected_lease_revision <= 9007199254740991),
  execution_authority_lease_id TEXT NOT NULL,
  execution_authority_fencing_token INTEGER NOT NULL
    CHECK (execution_authority_fencing_token >= 1 AND execution_authority_fencing_token <= 9007199254740991),
  execution_deployment_id TEXT NOT NULL,
  execution_authority_epoch INTEGER NOT NULL
    CHECK (execution_authority_epoch >= 1 AND execution_authority_epoch <= 9007199254740991),
  execution_fencing_token INTEGER NOT NULL
    CHECK (execution_fencing_token >= 1 AND execution_fencing_token <= 9007199254740991),
  execution_consumer_id TEXT NOT NULL CHECK (length(trim(execution_consumer_id)) > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'started', 'unknown', 'settled', 'released')),
  reserved_at TEXT NOT NULL,
  started_at TEXT,
  observed_at TEXT,
  settled_at TEXT,
  released_at TEXT,
  actual_cost_micros INTEGER
    CHECK (actual_cost_micros IS NULL OR
      (actual_cost_micros >= 0 AND actual_cost_micros <= 9007199254740991)),
  reason_code TEXT CHECK (reason_code IN (
    'provider_unresolved', 'transport_unresolved', 'cancel_unresolved'
  )),
  PRIMARY KEY (owner_id, agent_id, run_id, logical_slot, sequence),
  UNIQUE (owner_id, agent_id, invocation_id),
  UNIQUE (owner_id, agent_id, run_id, budget_operation_key),
  FOREIGN KEY (owner_id, agent_id, run_id)
    REFERENCES runs(owner_id, agent_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, agent_id, budget_account_id, budget_operation_key)
    REFERENCES model_budget_allocations(owner_id, agent_id, account_id, operation_key)
    ON DELETE CASCADE,
  FOREIGN KEY (authority_lease_id)
    REFERENCES authority_leases(id) ON DELETE RESTRICT,
  CHECK (model_version IS NULL OR length(trim(model_version)) > 0),
  CHECK (
    (status IN ('reserved', 'started', 'settled', 'released') AND reason_code IS NULL) OR
    (status = 'unknown' AND reason_code IS NOT NULL)
  ),
  CHECK (
    (status = 'settled' AND actual_cost_micros IS NOT NULL AND settled_at IS NOT NULL) OR
    (status <> 'settled' AND actual_cost_micros IS NULL AND settled_at IS NULL)
  ),
  CHECK (status <> 'unknown' OR observed_at IS NOT NULL),
  CHECK (
    (status = 'released' AND released_at IS NOT NULL) OR
    (status <> 'released' AND released_at IS NULL)
  ),
  CHECK (
    (status IN ('reserved', 'released') AND started_at IS NULL) OR
    (status IN ('started', 'unknown', 'settled') AND started_at IS NOT NULL)
  ),
  CHECK (authority_fencing_token = execution_authority_fencing_token),
  CHECK (authority_lease_id = execution_authority_lease_id),
  CHECK (authority_deployment_id = execution_deployment_id),
  CHECK (authority_epoch = execution_authority_epoch)
) STRICT;


CREATE INDEX model_invocation_identities_scope ON model_invocation_identities(owner_id, agent_id, run_id, logical_slot, sequence);
CREATE INDEX model_invocation_identities_status ON model_invocation_identities(owner_id, agent_id, status);

INSERT INTO model_budget_accounts (owner_id, agent_id, account_id, parent_kind, run_id, occurrence_id, data_classification, reserved_cost_micros, spent_cost_micros, status, revision) SELECT owner_id, agent_id, account_id, parent_kind, run_id, occurrence_id, data_classification, reserved_cost_micros, spent_cost_micros, status, revision FROM saved_model_budget_accounts;
INSERT INTO model_budget_allocations SELECT * FROM saved_model_budget_allocations;
INSERT INTO model_invocation_identities SELECT * FROM saved_model_invocation_identities;
DROP TABLE saved_model_invocation_identities;
DROP TABLE saved_model_budget_allocations;
DROP TABLE saved_model_budget_accounts;
