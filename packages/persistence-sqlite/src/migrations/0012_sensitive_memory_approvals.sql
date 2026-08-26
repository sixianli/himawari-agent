CREATE TABLE memory_approval_requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES memory_generations(id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  source_classification TEXT NOT NULL CHECK (source_classification IN ('public', 'private', 'sensitive', 'restricted')),
  candidate_ordinal INTEGER NOT NULL CHECK (candidate_ordinal >= 0),
  product_memory_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('create', 'update', 'merge', 'unchanged')),
  existing_memory_id TEXT REFERENCES memory_records(id) ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification IN ('sensitive', 'restricted')),
  policy_version TEXT NOT NULL,
  model_descriptor_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'edited', 'rejected', 'expired', 'committed')),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('deliverable', 'queued_no_ui')),
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  committed_at TEXT,
  UNIQUE (generation_id, source_ref, candidate_ordinal)
) STRICT;

CREATE INDEX memory_approval_requests_pending_index
  ON memory_approval_requests(owner_id, thread_id, status, requested_at);
