CREATE TABLE background_work_activities (
  id TEXT PRIMARY KEY CHECK (length(id) = 26 AND substr(id, 1, 4) = 'bwa_'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
  subthread_id TEXT NOT NULL CHECK (length(subthread_id) <= 128),
  token TEXT CHECK (token IS NULL OR (length(token) BETWEEN 2 AND 512 AND token NOT GLOB '*[^0-9a-f]*')),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 255),
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'en', 'ja')),
  started_at TEXT CHECK (started_at IS NULL OR started_at GLOB '????-??-??T??:??:??.???Z'),
  state_digest TEXT CHECK (state_digest IS NULL OR length(state_digest) = 64),
  pushed_at TEXT CHECK (pushed_at IS NULL OR pushed_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK (subthread_id <> '' OR token IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX background_work_activities_target_index
  ON background_work_activities(device_id, subthread_id);

CREATE INDEX background_work_activities_scope_index
  ON background_work_activities(owner_id, agent_id);
