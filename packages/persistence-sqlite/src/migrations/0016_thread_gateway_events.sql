CREATE TABLE thread_gateway_events (
  cursor_sequence INTEGER PRIMARY KEY CHECK (cursor_sequence >= 1),
  cursor TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL,
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  thread_revision INTEGER NOT NULL CHECK (thread_revision >= 1),
  causation_command_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_ref TEXT,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX thread_gateway_events_scope_cursor_index
  ON thread_gateway_events(owner_id, agent_id, cursor_sequence);

CREATE INDEX thread_gateway_events_thread_revision_index
  ON thread_gateway_events(owner_id, agent_id, thread_id, thread_revision, cursor_sequence);
