CREATE TABLE rule_book_rules (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 64),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  parameters TEXT NOT NULL CHECK (json_valid(parameters) AND json_type(parameters) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 256),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, rule_id)
) STRICT;

CREATE TABLE rule_book_history (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 64),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  parameters TEXT NOT NULL CHECK (json_valid(parameters) AND json_type(parameters) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 256),
  changed_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id, rule_id, revision)
) STRICT;

CREATE TRIGGER rule_book_history_no_update BEFORE UPDATE ON rule_book_history
BEGIN SELECT RAISE(ABORT, 'RULE_BOOK_HISTORY_IMMUTABLE'); END;

CREATE TRIGGER rule_book_history_no_delete BEFORE DELETE ON rule_book_history
WHEN EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)
  AND EXISTS (SELECT 1 FROM owners WHERE id = OLD.owner_id)
BEGIN SELECT RAISE(ABORT, 'RULE_BOOK_HISTORY_IMMUTABLE'); END;

INSERT INTO rule_book_rules (
  owner_id, agent_id, rule_id, revision, parameters, status, source, updated_at
)
SELECT owner_id, agent_id, 'quiet_hours', 1, json_object('periods', json(quiet_hours)), 'active',
  'migrated from proactive_settings', updated_at
FROM proactive_settings;

INSERT INTO rule_book_rules (
  owner_id, agent_id, rule_id, revision, parameters, status, source, updated_at
)
SELECT owner_id, agent_id, 'floor_important_sender', 1,
  json_object('senders', json(important_senders)), 'active',
  'migrated from proactive_settings', updated_at
FROM proactive_settings;

INSERT INTO rule_book_history (
  owner_id, agent_id, rule_id, revision, parameters, status, source, changed_at
)
SELECT owner_id, agent_id, rule_id, revision, parameters, status, source, updated_at
FROM rule_book_rules;

CREATE TABLE proactive_settings_next (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, agent_id)
) STRICT;

INSERT INTO proactive_settings_next (owner_id, agent_id, enabled, updated_at)
SELECT owner_id, agent_id, enabled, updated_at FROM proactive_settings;

DROP TABLE proactive_settings;

ALTER TABLE proactive_settings_next RENAME TO proactive_settings;
