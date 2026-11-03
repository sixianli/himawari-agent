CREATE TABLE ledger_observation_start (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  start_day TEXT NOT NULL CHECK (
    length(start_day) = 10 AND start_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  set_at TEXT NOT NULL CHECK (length(set_at) BETWEEN 20 AND 32),
  service_revision TEXT NOT NULL CHECK (length(service_revision) BETWEEN 1 AND 64),
  first_boot_at TEXT NOT NULL CHECK (length(first_boot_at) BETWEEN 20 AND 32),
  PRIMARY KEY (owner_id, agent_id)
) STRICT;

CREATE TRIGGER ledger_observation_start_no_update BEFORE UPDATE ON ledger_observation_start
BEGIN SELECT RAISE(ABORT, 'LEDGER_OBSERVATION_START_IMMUTABLE'); END;

CREATE TRIGGER ledger_observation_start_no_delete BEFORE DELETE ON ledger_observation_start
WHEN EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)
  AND EXISTS (SELECT 1 FROM owners WHERE id = OLD.owner_id)
BEGIN SELECT RAISE(ABORT, 'LEDGER_OBSERVATION_START_IMMUTABLE'); END;

CREATE TABLE service_heartbeats (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  hour_start TEXT NOT NULL CHECK (length(hour_start) = 24 AND substr(hour_start, 14) = ':00:00.000Z'),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  service_revision TEXT NOT NULL CHECK (length(service_revision) BETWEEN 1 AND 64),
  PRIMARY KEY (owner_id, agent_id, hour_start)
) STRICT;

CREATE TABLE ledger_observation_checks (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (
    length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  checked_at TEXT NOT NULL,
  service_revision TEXT NOT NULL CHECK (length(service_revision) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'blocked', 'pending')),
  checks TEXT NOT NULL CHECK (json_valid(checks) AND json_type(checks) = 'array'),
  counts TEXT NOT NULL CHECK (json_valid(counts) AND json_type(counts) = 'object')
) STRICT;

CREATE INDEX ledger_observation_checks_day
  ON ledger_observation_checks (owner_id, agent_id, day, checked_at);

CREATE TRIGGER ledger_observation_checks_no_update BEFORE UPDATE ON ledger_observation_checks
BEGIN SELECT RAISE(ABORT, 'LEDGER_OBSERVATION_CHECK_IMMUTABLE'); END;

CREATE TRIGGER ledger_observation_checks_no_delete BEFORE DELETE ON ledger_observation_checks
WHEN EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)
  AND EXISTS (SELECT 1 FROM owners WHERE id = OLD.owner_id)
BEGIN SELECT RAISE(ABORT, 'LEDGER_OBSERVATION_CHECK_IMMUTABLE'); END;

CREATE TABLE observation_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'state_snapshot', 'proactive_enabled', 'proactive_disabled', 'source_connected',
      'source_needs_reconnect', 'source_disconnected', 'memory_capture_paused',
      'memory_capture_resumed', 'proactive_records_cleared', 'consolidation_failed'
    )
  ),
  occurred_at TEXT NOT NULL,
  sequence INTEGER NOT NULL UNIQUE CHECK (sequence >= 1),
  detail TEXT NOT NULL CHECK (json_valid(detail) AND json_type(detail) = 'object')
) STRICT;

CREATE INDEX observation_events_time
  ON observation_events (owner_id, agent_id, occurred_at, sequence);

CREATE TRIGGER observation_events_no_update BEFORE UPDATE ON observation_events
BEGIN SELECT RAISE(ABORT, 'OBSERVATION_EVENT_IMMUTABLE'); END;

CREATE TRIGGER observation_events_no_delete BEFORE DELETE ON observation_events
WHEN EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)
  AND EXISTS (SELECT 1 FROM owners WHERE id = OLD.owner_id)
BEGIN SELECT RAISE(ABORT, 'OBSERVATION_EVENT_IMMUTABLE'); END;
