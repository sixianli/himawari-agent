CREATE TABLE model_invocation_identities_next (
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


INSERT INTO model_invocation_identities_next SELECT * FROM model_invocation_identities;
DROP TABLE model_invocation_identities;
ALTER TABLE model_invocation_identities_next RENAME TO model_invocation_identities;
CREATE INDEX model_invocation_identities_scope ON model_invocation_identities(owner_id, agent_id, run_id, logical_slot, sequence);
CREATE INDEX model_invocation_identities_status ON model_invocation_identities(owner_id, agent_id, status);
