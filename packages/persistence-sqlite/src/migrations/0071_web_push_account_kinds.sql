CREATE TABLE web_push_account_kinds (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  notify_reminder INTEGER NOT NULL CHECK (notify_reminder IN (0, 1)),
  notify_approval INTEGER NOT NULL CHECK (notify_approval IN (0, 1)),
  notify_run INTEGER NOT NULL CHECK (notify_run IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id)
) STRICT;

INSERT INTO web_push_account_kinds (
  owner_id, agent_id, notify_reminder, notify_approval, notify_run, updated_at
)
SELECT owner_id, agent_id, min(notify_reminder), min(notify_approval), min(notify_run),
  max(updated_at)
FROM web_push_subscriptions
GROUP BY owner_id, agent_id;
