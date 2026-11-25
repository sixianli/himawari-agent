CREATE TABLE main_threads (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id)
) STRICT;

ALTER TABLE thread_messages ADD COLUMN internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0, 1));

UPDATE threads SET origin = 'legacy';
