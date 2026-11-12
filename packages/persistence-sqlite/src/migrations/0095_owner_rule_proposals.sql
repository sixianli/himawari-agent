CREATE TABLE owner_rule_proposals (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL CHECK (length(rule_type) BETWEEN 1 AND 64),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 400),
  origin TEXT NOT NULL CHECK (origin IN ('owner_said', 'inferred')),
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  evidence_ref TEXT CHECK (evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  proposed_at TEXT NOT NULL CHECK (proposed_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  decided_at TEXT CHECK (decided_at IS NULL OR decided_at GLOB '????-??-??T??:??:??.???Z'),
  proposed_count INTEGER NOT NULL CHECK (proposed_count >= 1),
  reject_count INTEGER NOT NULL CHECK (reject_count >= 0),
  last_rejected_at TEXT CHECK (
    last_rejected_at IS NULL OR last_rejected_at GLOB '????-??-??T??:??:??.???Z'
  ),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (reject_count = 0 OR last_rejected_at IS NOT NULL)
) STRICT;

CREATE INDEX owner_rule_proposals_pending_index
  ON owner_rule_proposals(owner_id, agent_id, status, proposed_at, id);
CREATE INDEX owner_rule_proposals_thread_index
  ON owner_rule_proposals(thread_id)
  WHERE thread_id IS NOT NULL;
