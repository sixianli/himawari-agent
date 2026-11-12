CREATE TABLE owner_proposals (
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 200),
  effect TEXT NOT NULL CHECK (length(effect) BETWEEN 1 AND 200),
  origin TEXT NOT NULL CHECK (length(origin) BETWEEN 1 AND 32),
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  source_ref TEXT CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 256),
  source_version TEXT CHECK (source_version IS NULL OR length(source_version) BETWEEN 1 AND 128),
  version INTEGER NOT NULL CHECK (version >= 1),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  evidence_ref TEXT CHECK (evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 32),
  proposed_at TEXT NOT NULL CHECK (proposed_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  decided_at TEXT CHECK (decided_at IS NULL OR decided_at GLOB '????-??-??T??:??:??.???Z'),
  proposed_count INTEGER NOT NULL CHECK (proposed_count >= 1),
  reject_count INTEGER NOT NULL CHECK (reject_count >= 0),
  last_rejected_at TEXT CHECK (
    last_rejected_at IS NULL OR last_rejected_at GLOB '????-??-??T??:??:??.???Z'
  ),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (reject_count = 0 OR last_rejected_at IS NOT NULL),
  CHECK (source_version IS NULL OR source_ref IS NOT NULL),
  PRIMARY KEY (owner_id, agent_id, id)
) STRICT;

CREATE INDEX owner_proposals_pending_index
  ON owner_proposals(owner_id, agent_id, status, proposed_at, id);
CREATE INDEX owner_proposals_thread_index
  ON owner_proposals(thread_id)
  WHERE thread_id IS NOT NULL;
