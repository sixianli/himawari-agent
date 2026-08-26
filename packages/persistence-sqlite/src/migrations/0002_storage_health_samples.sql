CREATE TABLE storage_health_samples (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('normal', 'warning', 'write_restricted')),
  free_bytes INTEGER NOT NULL CHECK (free_bytes >= 0),
  wal_bytes INTEGER NOT NULL CHECK (wal_bytes >= 0),
  queue_depth INTEGER NOT NULL CHECK (queue_depth >= 0),
  reason_code TEXT,
  UNIQUE (deployment_id, observed_at)
) STRICT;

CREATE INDEX reliable_events_pending_index
  ON reliable_events(publication_state, occurred_at)
  WHERE publication_state != 'published';

CREATE INDEX job_occurrences_recovery_index
  ON job_occurrences(status, next_retry_at, deadline_at);

CREATE INDEX memory_projection_jobs_pending_index
  ON memory_projection_jobs(status, next_retry_at);

CREATE INDEX trace_events_scope_index
  ON trace_events(owner_id, agent_id, thread_id, run_id, sequence);
