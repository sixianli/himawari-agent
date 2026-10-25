CREATE TABLE memory_reminders (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL UNIQUE REFERENCES memory_records(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  remind_at TEXT NOT NULL,
  repeat TEXT NOT NULL CHECK (repeat IN ('none', 'yearly')),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'dismissed')),
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'dismissed') = (dismissed_at IS NOT NULL))
) STRICT;

CREATE INDEX memory_reminders_due_index ON memory_reminders(owner_id, agent_id, status, remind_at);
CREATE INDEX memory_reminders_agenda_index ON memory_reminders(owner_id, agent_id, status, due_at);
