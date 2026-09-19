-- Fence launch independently from later cleanup progress; manufacture no release proof.
ALTER TABLE sandbox_execution_records ADD COLUMN reservation_stopped_at TEXT
  CHECK(reservation_stopped_at IS NULL OR preparation_state='reserved');
CREATE TRIGGER sandbox_reservation_stopped_bind BEFORE UPDATE OF preparation_state ON sandbox_execution_records
WHEN OLD.preparation_state='reserved' AND OLD.reservation_stopped_at IS NOT NULL AND NEW.preparation_state!='reserved'
BEGIN SELECT RAISE(ABORT, 'Stopped sandbox reservation cannot bind'); END;
CREATE TRIGGER sandbox_reservation_stop_immutable BEFORE UPDATE OF reservation_stopped_at ON sandbox_execution_records
WHEN OLD.reservation_stopped_at IS NOT NULL AND NEW.reservation_stopped_at IS NOT OLD.reservation_stopped_at
BEGIN SELECT RAISE(ABORT, 'Sandbox reservation stop cannot be revoked'); END;
