ALTER TABLE memory_records ADD COLUMN tentative INTEGER NOT NULL DEFAULT 0 CHECK (tentative IN (0, 1));

CREATE TABLE memory_consolidation_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (length(day) = 10),
  trigger_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  reviewed_through TEXT,
  model_called INTEGER NOT NULL CHECK (model_called IN (0, 1)),
  change_count INTEGER NOT NULL DEFAULT 0 CHECK (change_count >= 0),
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (owner_id, agent_id, day)
) STRICT;

CREATE TABLE memory_consolidation_changes (
  id TEXT PRIMARY KEY,
  consolidation_id TEXT NOT NULL REFERENCES memory_consolidation_runs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  related_memory_id TEXT REFERENCES memory_records(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('merge', 'supersede', 'archive', 'reflect')),
  before_revision INTEGER CHECK (before_revision IS NULL OR before_revision >= 1),
  after_revision INTEGER NOT NULL CHECK (after_revision >= 1),
  before_status TEXT,
  before_superseded_by TEXT,
  before_valid_to TEXT,
  created_at TEXT NOT NULL,
  undone_at TEXT
) STRICT;

CREATE INDEX memory_consolidation_changes_scope_index
  ON memory_consolidation_changes(owner_id, agent_id, created_at);
CREATE INDEX memory_consolidation_changes_memory_index
  ON memory_consolidation_changes(memory_id);
