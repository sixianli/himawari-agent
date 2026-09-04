CREATE UNIQUE INDEX job_occurrences_scope_identity
  ON job_occurrences(owner_id, agent_id, id);

CREATE TEMP TABLE model_budget_migration_scope_totals (
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  reserved_cost_micros INTEGER NOT NULL
    CHECK (reserved_cost_micros >= 0 AND reserved_cost_micros <= 9007199254740991),
  spent_cost_micros INTEGER NOT NULL
    CHECK (spent_cost_micros >= 0 AND spent_cost_micros <= 9007199254740991),
  CHECK (reserved_cost_micros <= 9007199254740991 - spent_cost_micros)
) STRICT;

INSERT INTO model_budget_migration_scope_totals (
  owner_id, agent_id, reserved_cost_micros, spent_cost_micros
)
SELECT owner_id, agent_id, SUM(reserved_cost_micros), SUM(spent_cost_micros)
FROM job_occurrences
GROUP BY owner_id, agent_id;

DROP TABLE model_budget_migration_scope_totals;

CREATE TABLE model_budget_accounts (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL CHECK (length(trim(account_id)) > 0),
  parent_kind TEXT NOT NULL CHECK (parent_kind IN ('run', 'occurrence')),
  run_id TEXT,
  occurrence_id TEXT,
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
  CHECK (
    (parent_kind = 'run' AND run_id IS NOT NULL AND occurrence_id IS NULL) OR
    (parent_kind = 'occurrence' AND run_id IS NULL AND occurrence_id IS NOT NULL)
  ),
  CHECK (
    (parent_kind = 'run' AND account_id = 'run:' || run_id) OR
    (parent_kind = 'occurrence' AND account_id = 'occurrence:' || occurrence_id)
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

INSERT INTO model_budget_accounts (
  owner_id, agent_id, account_id, parent_kind, run_id, occurrence_id,
  data_classification, reserved_cost_micros, spent_cost_micros, status, revision
)
SELECT
  owner_id,
  agent_id,
  'occurrence:' || id,
  'occurrence',
  NULL,
  id,
  data_classification,
  reserved_cost_micros,
  spent_cost_micros,
  CASE
    WHEN last_error_code = 'EXTERNAL_RESULT_UNKNOWN' THEN 'reconcile_required'
    ELSE 'active'
  END,
  0
FROM job_occurrences;
