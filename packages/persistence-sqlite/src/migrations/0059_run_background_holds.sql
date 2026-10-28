CREATE TABLE run_background_holds (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_ref TEXT NOT NULL CHECK (length(task_ref) BETWEEN 1 AND 128),
  thread_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  parked_at TEXT NOT NULL,
  released_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'stopped', 'timed_out', 'interrupted')),
  notice_run_id TEXT,
  command_ref TEXT CHECK (command_ref IS NULL OR length(command_ref) BETWEEN 1 AND 128),
  output_ref TEXT CHECK (output_ref IS NULL OR length(output_ref) BETWEEN 1 AND 128),
  PRIMARY KEY (owner_id, agent_id, run_id, task_ref),
  CHECK ((released_at IS NULL) = (outcome IS NULL))
) STRICT;

CREATE INDEX run_background_holds_open_index ON run_background_holds(owner_id, agent_id, released_at, run_id);
CREATE INDEX run_background_holds_thread_index ON run_background_holds(owner_id, agent_id, thread_id, run_id);
