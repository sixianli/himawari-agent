CREATE TABLE memory_checkup_items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  related_memory_id TEXT REFERENCES memory_records(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (reason IN ('conflict', 'unused', 'low_confidence', 'source_unavailable')),
  action TEXT CHECK (action IS NULL OR action IN ('confirm', 'delete', 'merge')),
  kept_memory_id TEXT REFERENCES memory_records(id) ON DELETE SET NULL,
  before_state TEXT CHECK (before_state IS NULL OR json_valid(before_state)),
  handled_at TEXT,
  undone_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((action IS NULL) = (handled_at IS NULL)),
  CHECK ((action IS NULL) = (before_state IS NULL)),
  CHECK (related_memory_id IS NULL OR reason = 'conflict'),
  CHECK (kept_memory_id IS NULL OR action = 'merge'),
  UNIQUE (owner_id, agent_id, week_start, memory_id)
) STRICT;

CREATE INDEX memory_checkup_items_week_index
  ON memory_checkup_items(owner_id, agent_id, week_start);
CREATE INDEX memory_checkup_items_memory_index
  ON memory_checkup_items(memory_id);
