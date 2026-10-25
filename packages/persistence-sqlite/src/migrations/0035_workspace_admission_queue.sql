-- Queue entries are priority, not execution authority or held resource locks.
-- The version boundary also prevents older writers from applying content-only
-- recovery to new staged file publication records in product_state_records.
CREATE TABLE sandbox_admission_queue (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  handle_ref TEXT NOT NULL REFERENCES capability_handles(id) ON DELETE CASCADE,
  deadline_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'admitted', 'cancelled')),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  claims_json TEXT NOT NULL CHECK (json_valid(claims_json))
) STRICT;
CREATE INDEX sandbox_admission_queue_waiters ON sandbox_admission_queue(host_id, sequence) WHERE status='queued';
