-- Existing usage remains committed history; no quota is refunded by migration.
CREATE TABLE authorization_reservations (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('reserved', 'committed', 'released')),
  cost_micros INTEGER NOT NULL CHECK(cost_micros >= 0),
  expires_at TEXT NOT NULL,
  handle_ref TEXT UNIQUE REFERENCES capability_handles(id) ON DELETE SET NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE INDEX authorization_reservations_capacity ON authorization_reservations(grant_id, status);

ALTER TABLE authorization_usage ADD COLUMN intent_id TEXT;
