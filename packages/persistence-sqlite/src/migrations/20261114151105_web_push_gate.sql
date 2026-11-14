ALTER TABLE web_push_outbox ADD COLUMN defer_until TEXT
  CHECK (defer_until IS NULL OR length(defer_until) = 24);

ALTER TABLE web_push_outbox ADD COLUMN defer_rule_refs TEXT
  CHECK (defer_rule_refs IS NULL OR (json_valid(defer_rule_refs) AND json_type(defer_rule_refs) = 'array'));

CREATE INDEX web_push_outbox_defer_index ON web_push_outbox(owner_id, agent_id, defer_until);

CREATE TRIGGER rule_book_rules_release_push_insert AFTER INSERT ON rule_book_rules
BEGIN
  UPDATE web_push_outbox SET defer_until = NULL, defer_rule_refs = NULL
  WHERE owner_id = NEW.owner_id AND agent_id = NEW.agent_id AND defer_until IS NOT NULL;
END;

CREATE TRIGGER rule_book_rules_release_push_update AFTER UPDATE ON rule_book_rules
BEGIN
  UPDATE web_push_outbox SET defer_until = NULL, defer_rule_refs = NULL
  WHERE owner_id = NEW.owner_id AND agent_id = NEW.agent_id AND defer_until IS NOT NULL;
END;

CREATE TRIGGER rule_book_rules_release_push_delete AFTER DELETE ON rule_book_rules
BEGIN
  UPDATE web_push_outbox SET defer_until = NULL, defer_rule_refs = NULL
  WHERE owner_id = OLD.owner_id AND agent_id = OLD.agent_id AND defer_until IS NOT NULL;
END;

INSERT INTO decision_ledger_kinds (kind) VALUES ('web_push');
INSERT INTO decision_ledger_outcomes (kind, outcome) VALUES ('web_push', 'deferred');
