ALTER TABLE subthreads ADD COLUMN progress_ref TEXT
  CHECK (progress_ref IS NULL OR length(progress_ref) BETWEEN 1 AND 256);

ALTER TABLE subthreads ADD COLUMN progress_at TEXT
  CHECK (progress_at IS NULL OR progress_at GLOB '????-??-??T??:??:??.???Z');

ALTER TABLE subthreads ADD COLUMN asked_at TEXT
  CHECK (asked_at IS NULL OR asked_at GLOB '????-??-??T??:??:??.???Z');

ALTER TABLE subthreads ADD COLUMN budget_micros INTEGER
  CHECK (budget_micros IS NULL OR budget_micros BETWEEN 1 AND 1000000000);

ALTER TABLE subthreads ADD COLUMN budget_hit_at TEXT
  CHECK (budget_hit_at IS NULL OR budget_hit_at GLOB '????-??-??T??:??:??.???Z');

ALTER TABLE subthreads ADD COLUMN title TEXT
  CHECK (title IS NULL OR length(title) BETWEEN 1 AND 20);

CREATE TABLE subthread_exchanges (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES subthreads(thread_id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (length(direction) BETWEEN 1 AND 32),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
  text_ref TEXT NOT NULL CHECK (length(text_ref) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX subthread_exchanges_thread ON subthread_exchanges(thread_id, created_at);
