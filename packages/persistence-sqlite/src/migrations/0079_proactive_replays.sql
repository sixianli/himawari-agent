CREATE TABLE proactive_replay_runs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('gmail')),
  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL,
  mail_limit INTEGER NOT NULL CHECK (mail_limit BETWEEN 1 AND 2000),
  budget_micros INTEGER NOT NULL CHECK (budget_micros BETWEEN 1 AND 5000000),
  status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'failed', 'interrupted')),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  listed INTEGER NOT NULL DEFAULT 0 CHECK (listed >= 0),
  judged INTEGER NOT NULL DEFAULT 0 CHECK (judged >= 0),
  cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK (range_from < range_to),
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK ((status = 'running') = (reason_code IS NULL))
) STRICT;

CREATE UNIQUE INDEX proactive_replay_runs_one_running
  ON proactive_replay_runs(owner_id, agent_id) WHERE status = 'running';

CREATE INDEX proactive_replay_runs_recent
  ON proactive_replay_runs(owner_id, agent_id, started_at DESC);

CREATE TABLE proactive_replay_results (
  run_id TEXT NOT NULL REFERENCES proactive_replay_runs(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 256),
  received_at TEXT NOT NULL,
  sent_by_owner INTEGER NOT NULL CHECK (sent_by_owner IN (0, 1)),
  outcome TEXT NOT NULL CHECK (outcome IN ('act', 'know', 'check', 'ignore', 'skipped', 'failed')),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  floor_hit INTEGER NOT NULL CHECK (floor_hit IN (0, 1)),
  floor_raised INTEGER NOT NULL CHECK (floor_raised IN (0, 1)),
  push INTEGER NOT NULL CHECK (push IN (0, 1)),
  priority TEXT CHECK (priority IS NULL OR priority IN ('high', 'medium', 'low')),
  due_at TEXT,
  content_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0),
  judged_at TEXT NOT NULL,
  PRIMARY KEY (run_id, message_id),
  CHECK ((outcome IN ('skipped', 'failed')) = (reason_code IS NOT NULL)),
  CHECK (outcome NOT IN ('skipped', 'failed') OR content_ref IS NULL)
) STRICT;
