ALTER TABLE memory_records ADD COLUMN last_used_at TEXT;

ALTER TABLE memory_projection_jobs ADD COLUMN claimed_by TEXT;
ALTER TABLE memory_projection_jobs ADD COLUMN claimed_at TEXT;
ALTER TABLE memory_projection_jobs ADD COLUMN claim_expires_at TEXT;

CREATE INDEX memory_records_active_recent_index
  ON memory_records(owner_id, agent_id, status, last_used_at, updated_at);

CREATE INDEX memory_projection_jobs_claim_index
  ON memory_projection_jobs(status, claim_expires_at, next_retry_at);
