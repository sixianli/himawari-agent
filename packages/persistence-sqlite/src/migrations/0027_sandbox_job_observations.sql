CREATE TABLE sandbox_jobs (
  job_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  receipt_ref TEXT NOT NULL UNIQUE REFERENCES capability_invocation_receipts(receipt_ref) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1 AND sequence <= 9007199254740991),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
  UNIQUE (owner_id, agent_id, run_id, invocation_id),
  FOREIGN KEY (owner_id, agent_id, run_id) REFERENCES runs(owner_id, agent_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE sandbox_job_observations (
  job_id TEXT NOT NULL REFERENCES sandbox_jobs(job_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1 AND sequence <= 9007199254740991),
  observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
  PRIMARY KEY (job_id, sequence)
) STRICT;

CREATE INDEX sandbox_jobs_pending ON sandbox_jobs(owner_id, agent_id, job_id)
  WHERE json_extract(observation_json, '$.state') NOT IN ('completed', 'failed');
