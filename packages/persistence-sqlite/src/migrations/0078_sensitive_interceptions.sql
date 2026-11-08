CREATE TABLE sensitive_interceptions (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) = 64),
  thread_id TEXT,
  source TEXT NOT NULL CHECK (source IN (
    'chat', 'background', 'embedding', 'tool_result', 'mail', 'memory_capture'
  )),
  purpose TEXT CHECK (purpose IS NULL OR length(purpose) BETWEEN 1 AND 64),
  part TEXT NOT NULL CHECK (part IN (
    'system', 'owner_message', 'assistant_message', 'tool_call', 'tool_result',
    'embedding_input', 'file', 'command_output', 'web_page', 'mail',
    'memory_candidate', 'memory_source'
  )),
  category TEXT NOT NULL CHECK (category IN (
    'machine-secret', 'password', 'verification-code', 'bank-card', 'identity-number'
  )),
  rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 128),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) BETWEEN 16 AND 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('masked', 'withheld', 'not_saved')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  seen_count INTEGER NOT NULL CHECK (seen_count >= 1),
  PRIMARY KEY (owner_id, agent_id, dedupe_key),
  FOREIGN KEY (owner_id, agent_id, thread_id)
    REFERENCES threads(owner_id, agent_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX sensitive_interceptions_recent
  ON sensitive_interceptions(owner_id, agent_id, first_seen_at DESC, dedupe_key);
