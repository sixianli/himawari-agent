CREATE TABLE mcp_projects (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (
    length(id) BETWEEN 1 AND 128 AND id GLOB '[A-Za-z0-9]*' AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
  merge_group TEXT NOT NULL CHECK (length(merge_group) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (owner_id, agent_id, id)
) STRICT;

CREATE INDEX mcp_projects_group_index ON mcp_projects(owner_id, agent_id, merge_group);

CREATE TABLE mcp_project_names (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, name),
  FOREIGN KEY (owner_id, agent_id, project_id)
    REFERENCES mcp_projects(owner_id, agent_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX mcp_project_names_project_index ON mcp_project_names(owner_id, agent_id, project_id);

CREATE TABLE mcp_sync_entries (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL CHECK (
    length(project_id) BETWEEN 1 AND 128 AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  stable_id TEXT NOT NULL CHECK (length(stable_id) BETWEEN 1 AND 1024),
  entry_id TEXT NOT NULL UNIQUE CHECK (
    length(entry_id) BETWEEN 1 AND 128 AND entry_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'project_note')),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 32),
  classification TEXT NOT NULL CHECK (classification IN ('private', 'sensitive')),
  version INTEGER NOT NULL CHECK (version >= 1),
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
  content_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (length(state) BETWEEN 1 AND 32),
  proposal_id TEXT REFERENCES external_memory_proposals(id) ON DELETE SET NULL,
  replaces_memory_id TEXT REFERENCES memory_records(id) ON DELETE SET NULL,
  source_deleted_at TEXT CHECK (
    source_deleted_at IS NULL OR source_deleted_at GLOB '????-??-??T??:??:??.???Z'
  ),
  first_synced_at TEXT NOT NULL CHECK (first_synced_at GLOB '????-??-??T??:??:??.???Z'),
  last_synced_at TEXT NOT NULL CHECK (last_synced_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (owner_id, agent_id, connection_id, project_id, stable_id)
) STRICT;

CREATE INDEX mcp_sync_entries_state_index
  ON mcp_sync_entries(owner_id, agent_id, connection_id, project_id, state);
CREATE INDEX mcp_sync_entries_proposal_index
  ON mcp_sync_entries(proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX mcp_sync_entries_content_index ON mcp_sync_entries(content_ref);

CREATE TABLE mcp_sync_versions (
  entry_id TEXT NOT NULL REFERENCES mcp_sync_entries(entry_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
  content_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  proposal_id TEXT REFERENCES external_memory_proposals(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (entry_id, version)
) STRICT;

CREATE INDEX mcp_sync_versions_content_index ON mcp_sync_versions(content_ref);

CREATE TABLE mcp_project_approvals (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL CHECK (
    length(project_id) BETWEEN 1 AND 128 AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 16),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  decided_at TEXT CHECK (decided_at IS NULL OR decided_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (owner_id, agent_id, connection_id, project_id)
) STRICT;

CREATE TABLE mcp_sync_deletion_days (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL CHECK (
    length(project_id) BETWEEN 1 AND 128 AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  baseline INTEGER NOT NULL CHECK (baseline >= 0),
  auto_deleted INTEGER NOT NULL CHECK (auto_deleted >= 0),
  PRIMARY KEY (owner_id, agent_id, connection_id, project_id, day)
) STRICT;

CREATE TABLE mcp_sync_attention (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL CHECK (
    length(project_id) BETWEEN 1 AND 128 AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 16),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  resolved_at TEXT CHECK (resolved_at IS NULL OR resolved_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE INDEX mcp_sync_attention_open_index
  ON mcp_sync_attention(owner_id, agent_id, connection_id, project_id, status);

CREATE TABLE mcp_sync_attention_entries (
  attention_id TEXT NOT NULL REFERENCES mcp_sync_attention(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES mcp_sync_entries(entry_id) ON DELETE CASCADE,
  PRIMARY KEY (attention_id, entry_id)
) STRICT;

CREATE TABLE mcp_sync_limits (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  value INTEGER NOT NULL CHECK (value >= 0),
  PRIMARY KEY (owner_id, agent_id, name)
) STRICT;
