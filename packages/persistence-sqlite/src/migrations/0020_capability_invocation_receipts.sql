CREATE TABLE capability_invocation_receipts (
  receipt_ref TEXT PRIMARY KEY CHECK (length(trim(receipt_ref)) > 0),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  handle_ref TEXT NOT NULL CHECK (length(trim(handle_ref)) > 0),
  invocation_id TEXT NOT NULL CHECK (length(trim(invocation_id)) > 0),
  worker_run_id TEXT NOT NULL CHECK (length(trim(worker_run_id)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  capability_ref TEXT NOT NULL CHECK (length(trim(capability_ref)) > 0),
  capability_version TEXT NOT NULL CHECK (length(trim(capability_version)) > 0),
  authorization_type TEXT NOT NULL CHECK (authorization_type IN ('policy', 'grant')),
  authorization_ref TEXT NOT NULL CHECK (length(trim(authorization_ref)) > 0),
  operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
  input_ref TEXT NOT NULL CHECK (length(trim(input_ref)) > 0),
  delegated_context_refs_json TEXT NOT NULL
    CHECK (json_valid(delegated_context_refs_json) AND json_type(delegated_context_refs_json) = 'array'),
  secret_refs_json TEXT NOT NULL
    CHECK (json_valid(secret_refs_json) AND json_type(secret_refs_json) = 'array'),
  data_classification TEXT NOT NULL
    CHECK (data_classification IN ('public', 'private', 'sensitive', 'restricted')),
  resource_ceiling_json TEXT NOT NULL
    CHECK (json_valid(resource_ceiling_json) AND json_type(resource_ceiling_json) = 'object'),
  requested_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  effective_expires_at TEXT NOT NULL,
  deployment_id TEXT NOT NULL CHECK (length(trim(deployment_id)) > 0),
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  lease_id TEXT NOT NULL CHECK (length(trim(lease_id)) > 0),
  lease_fencing_token INTEGER NOT NULL CHECK (lease_fencing_token >= 1),
  agent_service_instance_id TEXT NOT NULL CHECK (length(trim(agent_service_instance_id)) > 0),
  agent_service_boot_id TEXT NOT NULL CHECK (length(trim(agent_service_boot_id)) > 0),
  worker_instance_id TEXT NOT NULL CHECK (length(trim(worker_instance_id)) > 0),
  worker_boot_id TEXT NOT NULL CHECK (length(trim(worker_boot_id)) > 0),
  semantic_fingerprint TEXT NOT NULL CHECK (length(trim(semantic_fingerprint)) > 0),
  consumed_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  FOREIGN KEY (owner_id, agent_id, run_id)
    REFERENCES runs(owner_id, agent_id, id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX capability_invocation_receipts_key
  ON capability_invocation_receipts(owner_id, agent_id, idempotency_key);

CREATE UNIQUE INDEX capability_invocation_receipts_invocation
  ON capability_invocation_receipts(owner_id, agent_id, run_id, invocation_id);
