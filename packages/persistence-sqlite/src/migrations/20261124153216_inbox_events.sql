CREATE TABLE inbox_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 64),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 256),
  source_version TEXT NOT NULL CHECK (length(source_version) <= 256),
  external_content INTEGER NOT NULL CHECK (external_content IN (0, 1)),
  from_owner INTEGER NOT NULL CHECK (from_owner IN (0, 1)),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 9),
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  summary_ref TEXT REFERENCES payloads(ref) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 32),
  outcome TEXT CHECK (outcome IS NULL OR length(outcome) BETWEEN 1 AND 32),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 256),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (owner_id, agent_id, source_kind, source_ref, source_version)
) STRICT;

INSERT INTO inbox_events (
  id, owner_id, agent_id, source_kind, source_ref, source_version, external_content, from_owner,
  priority, thread_id, summary_ref, status, outcome, reason_code, run_id, attempts, created_at,
  updated_at
)
SELECT
  id, owner_id, agent_id, source_kind, source_ref, source_version, external_content, 0, 5, NULL,
  summary_ref,
  CASE status WHEN 'queued' THEN 'queued' WHEN 'thinking' THEN 'queued' WHEN 'failed' THEN 'failed'
    ELSE 'done' END,
  CASE status WHEN 'proposed' THEN 'proposed' WHEN 'skipped' THEN 'silent'
    WHEN 'expired' THEN 'silent' ELSE NULL END,
  reason_code, NULL, attempts, created_at, updated_at
FROM think_inbox;

DROP TABLE think_inbox_declined;
DROP TABLE think_inbox;

CREATE INDEX inbox_events_queue
  ON inbox_events (owner_id, agent_id, status, priority, created_at, id);
CREATE INDEX inbox_events_thread ON inbox_events (owner_id, agent_id, thread_id, status);

ALTER TABLE think_settings RENAME TO inbox_settings;

UPDATE inbox_settings SET overrides = json_remove(
  overrides, '$.yesAtLeastPermille', '$.noAtMostPermille', '$.queueLimit', '$.dailyLimit',
  '$.expiresAfterHours', '$.threadRetentionDays'
);
