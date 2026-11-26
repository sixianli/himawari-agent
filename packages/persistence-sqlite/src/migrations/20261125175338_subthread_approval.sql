ALTER TABLE subthreads ADD COLUMN approval_run_id TEXT
  CHECK (approval_run_id IS NULL OR length(approval_run_id) BETWEEN 1 AND 256);
