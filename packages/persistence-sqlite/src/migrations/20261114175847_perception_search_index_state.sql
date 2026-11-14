CREATE TABLE perception_search_index_state (
  record_id TEXT PRIMARY KEY REFERENCES perception_records(id) ON DELETE CASCADE,
  version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 128)
) STRICT;

CREATE INDEX perception_search_index_state_version_index
  ON perception_search_index_state(version, record_id);
