ALTER TABLE threads ADD COLUMN title_ref TEXT REFERENCES payloads(ref) ON DELETE SET NULL;
ALTER TABLE threads ADD COLUMN title_source TEXT CHECK (title_source IN ('automatic', 'owner'));
ALTER TABLE threads ADD COLUMN title_revision INTEGER NOT NULL DEFAULT 0 CHECK (title_revision >= 0);
ALTER TABLE threads ADD COLUMN pin_order INTEGER CHECK (pin_order >= 0);
ALTER TABLE threads ADD COLUMN answer_locale TEXT NOT NULL DEFAULT 'zh-CN'
  CHECK (answer_locale IN ('zh-CN', 'en', 'ja'));
ALTER TABLE threads ADD COLUMN message_watermark INTEGER NOT NULL DEFAULT 0
  CHECK (message_watermark >= 0);
ALTER TABLE threads ADD COLUMN archived_at TEXT;
ALTER TABLE threads ADD COLUMN trashed_at TEXT;

ALTER TABLE thread_messages ADD COLUMN turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL;
ALTER TABLE thread_messages ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE thread_messages ADD COLUMN message_status TEXT NOT NULL DEFAULT 'committed'
  CHECK (message_status IN ('committed', 'partial', 'failed'));

CREATE TABLE thread_fork_lineage (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  source_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  source_thread_marker TEXT NOT NULL,
  source_turn_marker TEXT NOT NULL,
  source_watermark INTEGER NOT NULL CHECK (source_watermark >= 1),
  summary_refs_json TEXT NOT NULL CHECK (json_valid(summary_refs_json)),
  policy_refs_json TEXT NOT NULL CHECK (json_valid(policy_refs_json)),
  source_content_available INTEGER NOT NULL DEFAULT 1 CHECK (source_content_available IN (0, 1)),
  forked_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, thread_id)
) STRICT;

CREATE TABLE thread_command_receipts (
  command_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  command_type TEXT NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  thread_revision INTEGER NOT NULL CHECK (thread_revision >= 1),
  result_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  committed_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, idempotency_key)
) STRICT;

CREATE TABLE thread_search_projection (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES thread_messages(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  token_ref TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  PRIMARY KEY (thread_id, message_id, token_ref, projection_version)
) STRICT;

CREATE TABLE thread_title_search_projection (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  title_revision INTEGER NOT NULL CHECK (title_revision >= 1),
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  token_ref TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  PRIMARY KEY (thread_id, token_ref, projection_version)
) STRICT;

CREATE TRIGGER thread_fork_source_deleted
AFTER DELETE ON threads
BEGIN
  UPDATE thread_fork_lineage
  SET source_content_available = 0
  WHERE source_thread_marker = OLD.id;
END;

CREATE INDEX threads_lifecycle_query_index
  ON threads(owner_id, agent_id, status, archived_at, pin_order, updated_at DESC, id);
CREATE INDEX thread_messages_turn_index ON thread_messages(thread_id, turn_id, sequence);
CREATE INDEX thread_search_token_index
  ON thread_search_projection(owner_id, agent_id, token_ref, projection_version, thread_id);
CREATE INDEX thread_title_search_token_index
  ON thread_title_search_projection(owner_id, agent_id, token_ref, projection_version, thread_id);
