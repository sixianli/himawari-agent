-- A stopped reservation can be released without inventing a runtime binding.
CREATE TABLE sandbox_reservation_release_receipts (
  job_id TEXT PRIMARY KEY REFERENCES sandbox_execution_records(job_id) ON DELETE CASCADE,
  accepted_at TEXT NOT NULL,
  verification_json TEXT NOT NULL CHECK(json_valid(verification_json)),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json))
) STRICT;
CREATE TRIGGER sandbox_reservation_release_requires_stop BEFORE INSERT ON sandbox_reservation_release_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM sandbox_execution_records r WHERE r.job_id=NEW.job_id
  AND r.preparation_state='reserved' AND r.reservation_stopped_at IS NOT NULL
  AND r.reservation_stopped_at=json_extract(NEW.verification_json,'$.stopRequestedAt')
)
BEGIN SELECT RAISE(ABORT, 'Reservation release requires an immutable stop'); END;
CREATE TRIGGER sandbox_reservation_release_immutable BEFORE UPDATE ON sandbox_reservation_release_receipts
BEGIN SELECT RAISE(ABORT, 'Accepted reservation release is immutable'); END;
