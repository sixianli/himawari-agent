ALTER TABLE subthreads ADD COLUMN stuck_at TEXT
  CHECK (stuck_at IS NULL OR stuck_at GLOB '????-??-??T??:??:??.???Z');

CREATE TABLE result_board_entries (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  writer_thread_id TEXT NOT NULL REFERENCES subthreads(thread_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  version INTEGER NOT NULL CHECK (version >= 1),
  summary_ref TEXT NOT NULL CHECK (length(summary_ref) BETWEEN 1 AND 256),
  body_ref TEXT NOT NULL CHECK (length(body_ref) BETWEEN 1 AND 256),
  classification TEXT NOT NULL CHECK (length(classification) BETWEEN 1 AND 32),
  external_content INTEGER NOT NULL CHECK (external_content IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (writer_thread_id, name, version)
) STRICT;

CREATE TABLE result_board_waits (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  waiter_thread_id TEXT NOT NULL REFERENCES subthreads(thread_id) ON DELETE CASCADE,
  writer_thread_id TEXT NOT NULL REFERENCES subthreads(thread_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (waiter_thread_id, writer_thread_id, name)
) STRICT;

CREATE INDEX result_board_waits_writer_index ON result_board_waits (writer_thread_id, name);

CREATE TABLE result_board_reads (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  reader_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  writer_thread_id TEXT NOT NULL REFERENCES subthreads(thread_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  version INTEGER NOT NULL CHECK (version >= 1),
  read_at TEXT NOT NULL CHECK (read_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (reader_thread_id, writer_thread_id, name)
) STRICT;

CREATE INDEX result_board_reads_writer_index ON result_board_reads (writer_thread_id, name);

CREATE TABLE result_board_notices (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  receiver_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
  writer_thread_id TEXT NOT NULL CHECK (length(writer_thread_id) BETWEEN 1 AND 256),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  version INTEGER CHECK (version IS NULL OR version >= 1),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 32),
  external_content INTEGER NOT NULL CHECK (external_content IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX result_board_notices_scope_index
  ON result_board_notices (owner_id, agent_id, created_at, id);
