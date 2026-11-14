CREATE TABLE external_memory_proposals (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  subject_ref TEXT NOT NULL CHECK (length(subject_ref) BETWEEN 1 AND 128),
  client TEXT NOT NULL CHECK (length(client) BETWEEN 1 AND 64),
  source_key TEXT CHECK (source_key IS NULL OR length(source_key) BETWEEN 1 AND 200),
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
  normalization TEXT NOT NULL CHECK (length(normalization) BETWEEN 1 AND 64),
  content_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (
    category IN (
      'identity', 'preference', 'relationship', 'goal', 'project', 'health', 'finance',
      'event', 'other'
    )
  ),
  classification TEXT NOT NULL CHECK (classification IN ('private', 'sensitive')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'rejected', 'superseded')),
  received_at TEXT NOT NULL CHECK (received_at GLOB '????-??-??T??:??:??.???Z'),
  decided_at TEXT CHECK (decided_at IS NULL OR decided_at GLOB '????-??-??T??:??:??.???Z'),
  batch_id TEXT CHECK (batch_id IS NULL OR length(batch_id) BETWEEN 1 AND 128),
  memory_id TEXT REFERENCES memory_records(id) ON DELETE SET NULL,
  superseded_by TEXT REFERENCES external_memory_proposals(id) ON DELETE SET NULL,
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (memory_id IS NULL OR status = 'committed'),
  CHECK (content_ref IS NOT NULL OR status IN ('rejected', 'superseded')),
  CHECK (superseded_by IS NULL OR status = 'superseded'),
  CHECK (batch_id IS NULL OR status IN ('committed', 'rejected'))
) STRICT;

CREATE UNIQUE INDEX external_memory_proposals_text_index
  ON external_memory_proposals(owner_id, agent_id, text_sha256)
  WHERE status <> 'superseded';
CREATE INDEX external_memory_proposals_status_index
  ON external_memory_proposals(owner_id, agent_id, status, received_at);
CREATE INDEX external_memory_proposals_key_index
  ON external_memory_proposals(owner_id, agent_id, client, source_key)
  WHERE source_key IS NOT NULL;
CREATE INDEX external_memory_proposals_batch_index
  ON external_memory_proposals(owner_id, agent_id, batch_id)
  WHERE batch_id IS NOT NULL;
CREATE INDEX external_memory_proposals_content_index
  ON external_memory_proposals(content_ref)
  WHERE content_ref IS NOT NULL;
CREATE INDEX external_memory_proposals_memory_index
  ON external_memory_proposals(memory_id)
  WHERE memory_id IS NOT NULL;
CREATE INDEX external_memory_proposals_superseded_index
  ON external_memory_proposals(superseded_by)
  WHERE superseded_by IS NOT NULL;

CREATE TABLE external_memory_proposal_keys (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  client TEXT NOT NULL CHECK (length(client) BETWEEN 1 AND 64),
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 200),
  proposal_id TEXT NOT NULL REFERENCES external_memory_proposals(id) ON DELETE CASCADE,
  PRIMARY KEY (owner_id, agent_id, client, source_key)
) STRICT;

CREATE INDEX external_memory_proposal_keys_proposal_index
  ON external_memory_proposal_keys(proposal_id);

CREATE TABLE external_memory_proposal_unkeyed (
  proposal_id TEXT NOT NULL REFERENCES external_memory_proposals(id) ON DELETE CASCADE,
  client TEXT NOT NULL CHECK (length(client) BETWEEN 1 AND 64),
  PRIMARY KEY (proposal_id, client)
) STRICT;
