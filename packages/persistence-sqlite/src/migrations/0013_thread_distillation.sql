ALTER TABLE thread_checkpoint_jobs ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'owner_explicit'
  CHECK (trigger_kind IN ('owner_explicit', 'controlled_idle', 'pre_compaction', 'source_threshold'));
ALTER TABLE thread_checkpoint_jobs ADD COLUMN next_retry_at TEXT;
ALTER TABLE thread_checkpoint_jobs ADD COLUMN claimed_by TEXT;
ALTER TABLE thread_checkpoint_jobs ADD COLUMN claimed_at TEXT;
ALTER TABLE thread_checkpoint_jobs ADD COLUMN claim_expires_at TEXT;

CREATE TABLE thread_checkpoint_sources (
  checkpoint_job_id TEXT NOT NULL REFERENCES thread_checkpoint_jobs(id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'run')),
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  PRIMARY KEY (checkpoint_job_id, source_ref),
  UNIQUE (checkpoint_job_id, source_sequence, source_kind)
) STRICT;

CREATE TABLE thread_summaries (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL UNIQUE REFERENCES memory_generations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  content_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  source_start_sequence INTEGER NOT NULL CHECK (source_start_sequence >= 1),
  source_end_sequence INTEGER NOT NULL CHECK (source_end_sequence >= source_start_sequence),
  source_watermark INTEGER NOT NULL CHECK (source_watermark >= source_end_sequence),
  policy_version TEXT NOT NULL,
  model_descriptor_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE thread_derivative_candidates (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES memory_generations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('memory', 'experience', 'commitment')),
  content_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'awaiting_sensitive_approval')),
  policy_version TEXT NOT NULL,
  model_descriptor_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (generation_id, ordinal),
  CHECK ((status = 'candidate' AND content_ref IS NOT NULL)
    OR (status = 'awaiting_sensitive_approval' AND content_ref IS NULL))
) STRICT;

CREATE TABLE thread_derivative_provenance (
  candidate_id TEXT NOT NULL REFERENCES thread_derivative_candidates(id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL,
  PRIMARY KEY (candidate_id, source_ref)
) STRICT;

CREATE INDEX thread_checkpoint_jobs_ready_index
  ON thread_checkpoint_jobs(status, next_retry_at, claim_expires_at, requested_at);

CREATE INDEX thread_summaries_latest_index
  ON thread_summaries(thread_id, source_watermark DESC, created_at DESC);
