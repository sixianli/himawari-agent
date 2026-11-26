CREATE TABLE message_urgency (
  message_id TEXT PRIMARY KEY REFERENCES thread_messages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  urgency TEXT NOT NULL CHECK (urgency IN ('low', 'normal', 'high')),
  recorded_at TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;
