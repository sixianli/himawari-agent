CREATE TABLE subthreads (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  parent_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  matter TEXT NOT NULL CHECK (length(matter) BETWEEN 1 AND 128),
  open_key TEXT NOT NULL UNIQUE CHECK (length(open_key) BETWEEN 1 AND 128),
  opened_by_run_id TEXT NOT NULL CHECK (length(opened_by_run_id) BETWEEN 1 AND 256),
  brief_ref TEXT NOT NULL CHECK (length(brief_ref) BETWEEN 1 AND 256),
  result_ref TEXT CHECK (result_ref IS NULL OR length(result_ref) BETWEEN 1 AND 256),
  classification TEXT NOT NULL CHECK (length(classification) BETWEEN 1 AND 32),
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 32),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX subthreads_parent_index
  ON subthreads (owner_id, agent_id, parent_thread_id, created_at, thread_id);

CREATE TABLE thread_tasks (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  task_number INTEGER NOT NULL CHECK (task_number >= 1),
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 32),
  blocked_by TEXT NOT NULL CHECK (json_valid(blocked_by) AND json_type(blocked_by) = 'array'),
  assignee_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  content_ref TEXT NOT NULL CHECK (length(content_ref) BETWEEN 1 AND 256),
  classification TEXT NOT NULL CHECK (length(classification) BETWEEN 1 AND 32),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (thread_id, task_number)
) STRICT;

CREATE INDEX thread_tasks_scope_index ON thread_tasks (owner_id, agent_id, thread_id);

CREATE TABLE thread_task_changes (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  task_number INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 256),
  content_ref TEXT NOT NULL CHECK (length(content_ref) BETWEEN 1 AND 256),
  classification TEXT NOT NULL CHECK (length(classification) BETWEEN 1 AND 32),
  changed_at TEXT NOT NULL CHECK (changed_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (thread_id, task_number, revision),
  FOREIGN KEY (thread_id, task_number)
    REFERENCES thread_tasks (thread_id, task_number) ON DELETE CASCADE
) STRICT;
