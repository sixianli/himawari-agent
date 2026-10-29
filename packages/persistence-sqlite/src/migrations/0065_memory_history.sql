ALTER TABLE memory_records ADD COLUMN stance TEXT CHECK (stance IS NULL OR length(stance) BETWEEN 1 AND 16);

CREATE TABLE memory_history_events (
  rowid INTEGER PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'updated', 'reaffirmed', 'edited', 'restored')),
  content_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  stance TEXT CHECK (stance IS NULL OR length(stance) BETWEEN 1 AND 16),
  quote_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  source_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  source_deleted INTEGER NOT NULL DEFAULT 0 CHECK (source_deleted IN (0, 1)),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX memory_history_events_memory_index ON memory_history_events(memory_id, occurred_at);
CREATE INDEX memory_history_events_thread_index ON memory_history_events(source_thread_id);

INSERT INTO memory_history_events (memory_id, kind, content_ref, source_thread_id, occurred_at)
SELECT id, 'created', content_ref, source_thread_id, COALESCE(recorded_at, updated_at)
FROM memory_records
WHERE status NOT IN ('deletion_pending', 'deleted_verified')
ORDER BY COALESCE(recorded_at, updated_at), id;
