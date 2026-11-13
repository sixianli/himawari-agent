CREATE TABLE memory_conversation_reviews (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL CHECK (length(episode_id) BETWEEN 1 AND 256),
  episode_created_at TEXT NOT NULL CHECK (episode_created_at GLOB '????-??-??T??:??:??.???Z'),
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'gave_up')),
  attempts INTEGER NOT NULL CHECK (attempts >= 1 AND attempts <= 100),
  output_ref TEXT CHECK (output_ref IS NULL OR length(output_ref) BETWEEN 1 AND 400),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  started_at TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??.???Z'),
  finished_at TEXT CHECK (finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
  undone_at TEXT CHECK (undone_at IS NULL OR undone_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (owner_id, agent_id, episode_id)
) STRICT;

CREATE INDEX memory_conversation_reviews_position_index
  ON memory_conversation_reviews(owner_id, agent_id, status, episode_created_at, episode_id);

CREATE INDEX memory_conversation_reviews_day_index
  ON memory_conversation_reviews(owner_id, agent_id, day);

CREATE INDEX memory_conversation_reviews_thread_index ON memory_conversation_reviews(thread_id);

CREATE TABLE memory_conversation_review_changes (
  review_id TEXT NOT NULL REFERENCES memory_conversation_reviews(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL CHECK (length(memory_id) BETWEEN 1 AND 256),
  action TEXT NOT NULL CHECK (action IN ('created', 'superseded', 'confirmed')),
  source_message_id TEXT NOT NULL CHECK (length(source_message_id) BETWEEN 1 AND 256),
  after_revision INTEGER CHECK (after_revision IS NULL OR after_revision >= 1),
  before_superseded_by TEXT,
  before_valid_to TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  undone_revision INTEGER CHECK (
    undone_revision IS NULL OR (after_revision IS NOT NULL AND undone_revision > after_revision)
  ),
  PRIMARY KEY (review_id, memory_id)
) STRICT;

CREATE INDEX memory_conversation_review_changes_memory_index
  ON memory_conversation_review_changes(memory_id);

CREATE TRIGGER memory_conversation_review_changes_memory_deleted
AFTER DELETE ON memory_records
BEGIN
  DELETE FROM memory_conversation_review_changes WHERE memory_id = OLD.id;
END;
