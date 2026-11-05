CREATE TABLE thread_prompt_bundles (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  origin TEXT NOT NULL CHECK (origin IN (
    'new_thread', 'rollout', 'tool_set_changed', 'tool_missing', 'tool_schema_changed',
    'model_changed', 'thinking_level_changed', 'answer_locale_changed', 'classification_lower',
    'rebuild_requested'
  )),
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  system_prompt_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  tools_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  system_prompt_sha256 TEXT NOT NULL CHECK (length(system_prompt_sha256) = 64),
  tools_sha256 TEXT NOT NULL CHECK (length(tools_sha256) = 64),
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  created_by_run_id TEXT NOT NULL CHECK (length(created_by_run_id) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  rebuild_reason TEXT CHECK (rebuild_reason IS NULL OR length(rebuild_reason) BETWEEN 1 AND 500),
  rebuild_operator TEXT CHECK (rebuild_operator IS NULL OR length(rebuild_operator) BETWEEN 1 AND 128),
  PRIMARY KEY (owner_id, agent_id, thread_id, generation),
  FOREIGN KEY (owner_id, agent_id, thread_id)
    REFERENCES threads(owner_id, agent_id, id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX thread_prompt_bundles_one_current
  ON thread_prompt_bundles(owner_id, agent_id, thread_id)
  WHERE superseded_at IS NULL;
