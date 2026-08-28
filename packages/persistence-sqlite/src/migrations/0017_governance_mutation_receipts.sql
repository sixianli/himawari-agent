CREATE TABLE governance_mutation_receipts (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  command_type TEXT NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('executing', 'completed')),
  result_ref TEXT,
  started_at TEXT NOT NULL,
  committed_at TEXT,
  PRIMARY KEY (owner_id, agent_id, idempotency_key),
  CHECK (
    (phase = 'executing' AND result_ref IS NULL AND committed_at IS NULL) OR
    (phase = 'completed' AND result_ref IS NOT NULL AND committed_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX governance_mutation_receipts_phase_index
  ON governance_mutation_receipts(owner_id, agent_id, phase, started_at);
