CREATE TABLE github_history_policy_operations (
  monitor_id TEXT PRIMARY KEY REFERENCES github_repository_monitors(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  monitor_revision INTEGER NOT NULL CHECK (monitor_revision >= 1),
  policy TEXT NOT NULL CHECK (policy IN ('retain', 'delete')),
  status TEXT NOT NULL CHECK (status IN ('running', 'retry_wait', 'completed')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  last_error_code TEXT,
  pending_payload_files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_payload_files_json)),
  monitor_json TEXT NOT NULL CHECK (json_valid(monitor_json)),
  CHECK ((status = 'completed' AND completed_at IS NOT NULL AND last_error_code IS NULL)
    OR (status != 'completed' AND completed_at IS NULL))
) STRICT;

CREATE INDEX github_history_policy_retry_index
  ON github_history_policy_operations(status, updated_at, monitor_id)
  WHERE status = 'retry_wait';
