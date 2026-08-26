CREATE TABLE product_state_records (
  key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, key)
) STRICT;

CREATE TABLE reliable_events_v2 (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  publication_state TEXT NOT NULL CHECK (publication_state IN ('pending', 'claimed', 'published')),
  claim_id TEXT,
  claim_expires_at TEXT,
  occurred_at TEXT NOT NULL,
  published_at TEXT,
  acknowledgement_ref TEXT,
  CHECK (
    (publication_state = 'published' AND published_at IS NOT NULL) OR
    (publication_state != 'published' AND published_at IS NULL)
  )
) STRICT;

CREATE INDEX reliable_events_v2_command_index
  ON reliable_events_v2(owner_id, agent_id, idempotency_key, id);

CREATE INDEX reliable_events_v2_pending_index
  ON reliable_events_v2(publication_state, occurred_at, id)
  WHERE publication_state != 'published';
