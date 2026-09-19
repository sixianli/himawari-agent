-- Record review identity before a model call. No Grant or file claim is allocated here.
-- Older writers cannot resolve decisions without the current delegation/lease checks.
CREATE TABLE automatic_action_reviews (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE INDEX automatic_action_reviews_run ON automatic_action_reviews(run_id, id);
