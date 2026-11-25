CREATE TABLE run_message_folds (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  folded_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES thread_messages(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 1),
  folded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, folded_run_id),
  UNIQUE (run_id, position)
) STRICT;

CREATE INDEX run_message_folds_scope_index ON run_message_folds(owner_id, agent_id, run_id);
