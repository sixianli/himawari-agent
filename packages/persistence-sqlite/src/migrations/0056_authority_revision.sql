CREATE TABLE authority_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL CHECK (value >= 0)
) STRICT;

INSERT INTO authority_revision (id, value) VALUES (1, 0);

CREATE TRIGGER authority_revision_grants_insert AFTER INSERT ON grants
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_grants_update AFTER UPDATE ON grants
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_grants_delete AFTER DELETE ON grants
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_approval_requests_insert AFTER INSERT ON approval_requests
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_approval_requests_update AFTER UPDATE ON approval_requests
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_approval_requests_delete AFTER DELETE ON approval_requests
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_authorization_reservations_insert AFTER INSERT ON authorization_reservations
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_authorization_reservations_update AFTER UPDATE ON authorization_reservations
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_authorization_reservations_delete AFTER DELETE ON authorization_reservations
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_authorization_usage_insert AFTER INSERT ON authorization_usage
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_authorization_usage_update AFTER UPDATE ON authorization_usage
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_authorization_usage_delete AFTER DELETE ON authorization_usage
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_capability_declarations_insert AFTER INSERT ON capability_declarations
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_capability_declarations_update AFTER UPDATE ON capability_declarations
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_capability_declarations_delete AFTER DELETE ON capability_declarations
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_capability_handles_insert AFTER INSERT ON capability_handles
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_capability_handles_update AFTER UPDATE ON capability_handles
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_capability_handles_delete AFTER DELETE ON capability_handles
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_product_state_records_insert AFTER INSERT ON product_state_records
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_product_state_records_update AFTER UPDATE ON product_state_records
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;

CREATE TRIGGER authority_revision_product_state_records_delete AFTER DELETE ON product_state_records
BEGIN
  UPDATE authority_revision SET value = value + 1 WHERE id = 1;
END;
