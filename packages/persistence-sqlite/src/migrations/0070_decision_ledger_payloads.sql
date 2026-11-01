CREATE TABLE decision_ledger_payloads (
  decision_id TEXT NOT NULL REFERENCES decision_ledger(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0 AND sequence <= 1000000),
  role TEXT NOT NULL CHECK (role IN ('model_input', 'model_output')),
  payload_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  PRIMARY KEY (decision_id, sequence)
) STRICT;

CREATE INDEX decision_ledger_payloads_ref_index ON decision_ledger_payloads(payload_ref);
