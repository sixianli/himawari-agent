CREATE TABLE conversation_turns (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (length(day) = 10),
  first_sequence INTEGER NOT NULL CHECK (first_sequence >= 1),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= first_sequence),
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  embedding_model TEXT,
  embedding_dimensions INTEGER CHECK (embedding_dimensions IS NULL OR embedding_dimensions BETWEEN 1 AND 65536),
  embedding BLOB,
  CHECK ((embedding IS NULL) = (embedding_model IS NULL)),
  CHECK (embedding IS NULL OR length(embedding) = 4 * embedding_dimensions),
  UNIQUE (thread_id, first_sequence)
) STRICT;

CREATE INDEX conversation_turns_scope_index ON conversation_turns(owner_id, agent_id, ended_at);

CREATE VIRTUAL TABLE conversation_turn_terms USING fts5(
  terms,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 0'
);

CREATE TRIGGER conversation_turns_terms_cleanup
AFTER DELETE ON conversation_turns
BEGIN
  DELETE FROM conversation_turn_terms WHERE rowid = old.rowid;
END;
