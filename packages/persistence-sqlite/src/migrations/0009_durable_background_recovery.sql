ALTER TABLE job_occurrences ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision >= 1);
ALTER TABLE job_occurrences ADD COLUMN category TEXT NOT NULL DEFAULT 'default';
ALTER TABLE job_occurrences ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'private'
  CHECK (data_classification IN ('public', 'private', 'sensitive', 'restricted'));
ALTER TABLE job_occurrences ADD COLUMN foreground INTEGER NOT NULL DEFAULT 0
  CHECK (foreground IN (0, 1));
ALTER TABLE job_occurrences ADD COLUMN parallel_safe INTEGER NOT NULL DEFAULT 0
  CHECK (parallel_safe IN (0, 1));
ALTER TABLE job_occurrences ADD COLUMN estimated_cost_micros INTEGER NOT NULL DEFAULT 0
  CHECK (estimated_cost_micros >= 0);
ALTER TABLE job_occurrences ADD COLUMN reserved_cost_micros INTEGER NOT NULL DEFAULT 0
  CHECK (reserved_cost_micros >= 0);
ALTER TABLE job_occurrences ADD COLUMN spent_cost_micros INTEGER NOT NULL DEFAULT 0
  CHECK (spent_cost_micros >= 0);
ALTER TABLE job_occurrences ADD COLUMN work_lease_id TEXT;
ALTER TABLE job_occurrences ADD COLUMN work_lease_holder_id TEXT;
ALTER TABLE job_occurrences ADD COLUMN work_lease_acquired_at TEXT;
ALTER TABLE job_occurrences ADD COLUMN work_lease_expires_at TEXT;
ALTER TABLE job_occurrences ADD COLUMN last_error_code TEXT;
ALTER TABLE job_occurrences ADD COLUMN record_json TEXT
  CHECK (record_json IS NULL OR json_valid(record_json));

CREATE INDEX job_occurrences_active_job_index
  ON job_occurrences(job_id, status, work_lease_expires_at);

CREATE INDEX job_occurrences_capacity_index
  ON job_occurrences(owner_id, agent_id, status, foreground, category);

CREATE INDEX job_occurrences_budget_index
  ON job_occurrences(owner_id, agent_id, data_classification,
    reserved_cost_micros, spent_cost_micros);

ALTER TABLE run_checkpoints ADD COLUMN record_json TEXT
  CHECK (record_json IS NULL OR json_valid(record_json));
