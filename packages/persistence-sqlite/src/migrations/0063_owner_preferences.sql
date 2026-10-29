CREATE TABLE owner_preferences (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 40),
  locale TEXT CHECK (locale IS NULL OR locale IN ('zh-CN', 'en', 'ja')),
  accent TEXT CHECK (
    accent IS NULL OR accent IN ('violet', 'blue', 'teal', 'amber', 'rose', 'graphite')
  ),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id)
) STRICT;
