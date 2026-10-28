CREATE TABLE web_push_feedback (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 64),
  kind TEXT NOT NULL CHECK (kind IN ('reminder', 'approval', 'run')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 256),
  thread_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('web_push')),
  first_sent_at TEXT NOT NULL,
  devices INTEGER NOT NULL CHECK (devices BETWEEN 1 AND 100),
  opened_at TEXT,
  dismissed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, source_key)
) STRICT;

CREATE UNIQUE INDEX web_push_feedback_tag_index ON web_push_feedback(owner_id, agent_id, tag);

CREATE INDEX web_push_feedback_sent_index ON web_push_feedback(owner_id, agent_id, first_sent_at);
