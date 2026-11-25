CREATE TABLE subthread_timers (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES subthreads(thread_id) ON DELETE CASCADE,
  schedule TEXT NOT NULL CHECK (json_valid(schedule) AND json_type(schedule) = 'object'),
  task_ref TEXT NOT NULL CHECK (length(task_ref) BETWEEN 1 AND 256),
  created_by TEXT NOT NULL CHECK (created_by IN ('owner', 'agreed', 'self')),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'cancelled', 'finished')),
  next_at TEXT CHECK (next_at IS NULL OR next_at GLOB '????-??-??T??:??:??.???Z'),
  last_scheduled_at TEXT
    CHECK (last_scheduled_at IS NULL OR last_scheduled_at GLOB '????-??-??T??:??:??.???Z'),
  run_count INTEGER NOT NULL CHECK (run_count >= 0),
  run_budget_micros INTEGER NOT NULL CHECK (run_budget_micros BETWEEN 1 AND 1000000000),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX subthread_timers_due ON subthread_timers(owner_id, agent_id, status, next_at);
CREATE INDEX subthread_timers_thread ON subthread_timers(thread_id);
