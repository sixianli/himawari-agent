CREATE TABLE thread_artifacts_next (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL CHECK (length(tool_call_id) BETWEEN 1 AND 256),
  source TEXT NOT NULL CHECK (source IN ('write', 'edit', 'bash', 'upload')),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  kind TEXT NOT NULL CHECK (kind IN ('document', 'code', 'web', 'image', 'pdf', 'data', 'other')),
  media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 128),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  version INTEGER NOT NULL CHECK (version >= 1),
  copy_ref TEXT CHECK (copy_ref IS NULL OR length(copy_ref) BETWEEN 1 AND 128),
  overlapped INTEGER NOT NULL CHECK (overlapped IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, thread_id, path, version),
  UNIQUE (owner_id, agent_id, run_id, tool_call_id, path)
) STRICT;

INSERT INTO thread_artifacts_next (
  id, owner_id, agent_id, thread_id, run_id, tool_call_id, source, path, kind, media_type,
  size_bytes, sha256, version, copy_ref, overlapped, created_at
)
SELECT id, owner_id, agent_id, thread_id, run_id, tool_call_id, source, path, kind, media_type,
  size_bytes, sha256, version, copy_ref, overlapped, created_at
FROM thread_artifacts;

DROP TABLE thread_artifacts;

ALTER TABLE thread_artifacts_next RENAME TO thread_artifacts;

CREATE INDEX thread_artifacts_thread_index ON thread_artifacts(owner_id, agent_id, thread_id, created_at, id);
CREATE INDEX thread_artifacts_recent_index ON thread_artifacts(owner_id, agent_id, created_at, id);
