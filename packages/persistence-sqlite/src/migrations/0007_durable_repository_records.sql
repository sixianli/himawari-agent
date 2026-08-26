ALTER TABLE payloads ADD COLUMN content_type TEXT;
ALTER TABLE trace_events ADD COLUMN record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json));
ALTER TABLE approval_requests ADD COLUMN record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json));
ALTER TABLE grants ADD COLUMN record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json));
ALTER TABLE capability_declarations ADD COLUMN record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json));
ALTER TABLE capability_handles ADD COLUMN record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json));
ALTER TABLE scheduled_jobs ADD COLUMN record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json));
ALTER TABLE attention_decisions ADD COLUMN record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json));
ALTER TABLE inbox_deliveries ADD COLUMN record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json));
ALTER TABLE deletion_tombstones ADD COLUMN record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json));

CREATE TABLE attention_policy_states (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id)
) STRICT;

CREATE TABLE gateway_thread_snapshots (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, thread_id)
) STRICT;

CREATE TABLE gateway_run_snapshots (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, run_id)
) STRICT;

CREATE TABLE gateway_stream_events (
  cursor_sequence INTEGER PRIMARY KEY CHECK (cursor_sequence >= 1),
  cursor TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_sequence INTEGER NOT NULL CHECK (run_sequence >= 1),
  recorded_at TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  UNIQUE (run_id, run_sequence)
) STRICT;

CREATE INDEX gateway_stream_events_scope_cursor_index
  ON gateway_stream_events(owner_id, agent_id, session_id, thread_id, run_id, cursor_sequence);

CREATE TABLE reliable_event_consumptions (
  consumer_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES reliable_events(id) ON DELETE CASCADE,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (consumer_id, event_id)
) STRICT;

CREATE TABLE gateway_read_model_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
