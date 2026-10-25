ALTER TABLE memory_records ADD COLUMN category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('identity', 'preference', 'relationship', 'goal', 'project', 'rule', 'health', 'finance', 'event', 'other'));
ALTER TABLE memory_records ADD COLUMN importance_permille INTEGER NOT NULL DEFAULT 500 CHECK (importance_permille BETWEEN 0 AND 1000);
ALTER TABLE memory_records ADD COLUMN valid_from TEXT;
ALTER TABLE memory_records ADD COLUMN valid_to TEXT;
ALTER TABLE memory_records ADD COLUMN superseded_by TEXT REFERENCES memory_records(id) ON DELETE SET NULL;
ALTER TABLE memory_records ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0);
ALTER TABLE memory_records ADD COLUMN evidence_verified INTEGER NOT NULL DEFAULT 0 CHECK (evidence_verified IN (0, 1));
ALTER TABLE memory_records ADD COLUMN sensitive_topic TEXT CHECK (sensitive_topic IS NULL OR sensitive_topic IN ('health', 'finance', 'beliefs', 'intimacy', 'third_party', 'location', 'legal', 'other'));

CREATE TABLE memory_entities (
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  PRIMARY KEY (memory_id, name)
) STRICT;

CREATE INDEX memory_entities_name_index ON memory_entities(name);

CREATE TABLE memory_search_index (
  rowid INTEGER PRIMARY KEY,
  memory_id TEXT NOT NULL UNIQUE REFERENCES memory_records(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  memory_revision INTEGER NOT NULL CHECK (memory_revision >= 1),
  embedding_model TEXT,
  embedding_dimensions INTEGER CHECK (embedding_dimensions IS NULL OR embedding_dimensions BETWEEN 1 AND 65536),
  embedding BLOB,
  indexed_at TEXT NOT NULL,
  CHECK ((embedding IS NULL) = (embedding_model IS NULL)),
  CHECK (embedding IS NULL OR length(embedding) = 4 * embedding_dimensions)
) STRICT;

CREATE INDEX memory_search_index_scope_index
  ON memory_search_index(owner_id, agent_id, embedding_model, embedding_dimensions);

CREATE VIRTUAL TABLE memory_search_terms USING fts5(
  terms,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 0'
);

CREATE TRIGGER memory_search_index_terms_cleanup
AFTER DELETE ON memory_search_index
BEGIN
  DELETE FROM memory_search_terms WHERE rowid = old.rowid;
END;
