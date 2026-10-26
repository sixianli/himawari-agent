CREATE TABLE memory_import_batches (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('codex', 'assistant', 'himawari')),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 500),
  created_at TEXT NOT NULL,
  undone_at TEXT
) STRICT;

CREATE INDEX memory_import_batches_scope_index ON memory_import_batches(owner_id, agent_id, created_at);

ALTER TABLE memory_records ADD COLUMN sub_category TEXT CHECK (sub_category IS NULL OR length(sub_category) BETWEEN 1 AND 32);
ALTER TABLE memory_records ADD COLUMN import_batch_id TEXT REFERENCES memory_import_batches(id) ON DELETE SET NULL;

CREATE TABLE memory_settings (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  capture_paused INTEGER NOT NULL CHECK (capture_paused IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id)
) STRICT;

CREATE TABLE memory_people (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  relation TEXT CHECK (relation IS NULL OR length(relation) BETWEEN 1 AND 32),
  reverse_relation TEXT CHECK (reverse_relation IS NULL OR length(reverse_relation) BETWEEN 1 AND 32),
  merged_into TEXT REFERENCES memory_people(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (merged_into IS NULL OR merged_into != id)
) STRICT;

CREATE INDEX memory_people_scope_index ON memory_people(owner_id, agent_id, merged_into);

CREATE TABLE memory_person_aliases (
  person_id TEXT NOT NULL REFERENCES memory_people(id) ON DELETE CASCADE,
  alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 64),
  PRIMARY KEY (person_id, alias)
) STRICT;

CREATE TABLE memory_person_links (
  person_id TEXT NOT NULL REFERENCES memory_people(id) ON DELETE CASCADE,
  other_person_id TEXT NOT NULL REFERENCES memory_people(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (length(relation) BETWEEN 1 AND 32),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (person_id, other_person_id),
  CHECK (person_id != other_person_id)
) STRICT;

CREATE TABLE memory_person_mentions (
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES memory_people(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, person_id)
) STRICT;

CREATE INDEX memory_person_mentions_person_index ON memory_person_mentions(person_id);

CREATE TABLE memory_person_suggestions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES memory_people(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES memory_people(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'merged', 'rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (person_id, candidate_id),
  CHECK (person_id != candidate_id),
  CHECK ((status = 'pending') = (decided_at IS NULL))
) STRICT;
