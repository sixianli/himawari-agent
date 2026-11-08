CREATE TABLE gap_case_marks (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL CHECK (case_id GLOB 'gap_*' AND length(case_id) = 24),
  snapshot_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  marked_at TEXT NOT NULL CHECK (marked_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (owner_id, agent_id, case_id)
) STRICT;
