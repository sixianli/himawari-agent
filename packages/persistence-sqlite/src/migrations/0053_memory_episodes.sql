ALTER TABLE memory_records ADD COLUMN recorded_at TEXT;
UPDATE memory_records SET recorded_at = updated_at;

CREATE TABLE memory_episodes (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (length(day) = 10),
  source TEXT NOT NULL CHECK (source IN ('day_summary', 'compaction')),
  content_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  first_sequence INTEGER NOT NULL CHECK (first_sequence >= 1),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= first_sequence),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  embedding_model TEXT,
  embedding_dimensions INTEGER CHECK (embedding_dimensions IS NULL OR embedding_dimensions BETWEEN 1 AND 65536),
  embedding BLOB,
  CHECK ((embedding IS NULL) = (embedding_model IS NULL)),
  CHECK (embedding IS NULL OR length(embedding) = 4 * embedding_dimensions),
  UNIQUE (thread_id, source, first_sequence)
) STRICT;

CREATE INDEX memory_episodes_scope_index ON memory_episodes(owner_id, agent_id, day);

CREATE VIRTUAL TABLE memory_episode_terms USING fts5(
  terms,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 0'
);

CREATE TRIGGER memory_episodes_terms_cleanup
AFTER DELETE ON memory_episodes
BEGIN
  DELETE FROM memory_episode_terms WHERE rowid = old.rowid;
END;
