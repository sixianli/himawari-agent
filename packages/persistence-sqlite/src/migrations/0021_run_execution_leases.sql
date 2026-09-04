CREATE TABLE run_execution_leases (
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991),
  authority_lease_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1 AND authority_epoch <= 9007199254740991),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1 AND fencing_token <= 9007199254740991),
  consumer_id TEXT NOT NULL CHECK (length(trim(consumer_id)) > 0),
  execution_lease_id TEXT NOT NULL CHECK (length(trim(execution_lease_id)) > 0),
  claimed_at TEXT NOT NULL,
  initial_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY (owner_id, agent_id, run_id),
  UNIQUE (execution_lease_id),
  FOREIGN KEY (owner_id, agent_id, run_id)
    REFERENCES runs(owner_id, agent_id, id) ON DELETE CASCADE,
  FOREIGN KEY (authority_lease_id)
    REFERENCES authority_leases(id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, agent_id, deployment_id)
    REFERENCES deployments(owner_id, agent_id, id) ON DELETE RESTRICT,
  CHECK (initial_expires_at > claimed_at),
  CHECK (expires_at > claimed_at),
  CHECK (released_at IS NULL OR released_at >= claimed_at)
) STRICT;

CREATE INDEX run_execution_leases_expiry
  ON run_execution_leases(owner_id, agent_id, expires_at)
  WHERE released_at IS NULL;
