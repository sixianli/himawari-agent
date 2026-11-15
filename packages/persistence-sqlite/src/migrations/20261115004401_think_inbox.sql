CREATE TABLE think_inbox (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 64),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 256),
  source_version TEXT NOT NULL CHECK (length(source_version) <= 256),
  external_content INTEGER NOT NULL CHECK (external_content IN (0, 1)),
  summary_ref TEXT REFERENCES payloads(ref) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 32),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  day TEXT NOT NULL CHECK (day GLOB '????-??-??'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (owner_id, agent_id, source_kind, source_ref, source_version)
);

CREATE INDEX think_inbox_queue ON think_inbox (owner_id, agent_id, status, created_at, id);
CREATE INDEX think_inbox_day ON think_inbox (owner_id, agent_id, day, status);

CREATE TABLE think_inbox_declined (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (day GLOB '????-??-??'),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  declined INTEGER NOT NULL CHECK (declined >= 0),
  PRIMARY KEY (owner_id, agent_id, day, reason_code)
);
