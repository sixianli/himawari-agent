ALTER TABLE owner_proposals ADD COLUMN exec_status TEXT NOT NULL DEFAULT 'not_started'
  CHECK (length(exec_status) BETWEEN 1 AND 32);
ALTER TABLE owner_proposals ADD COLUMN lease_id TEXT
  CHECK (lease_id IS NULL OR length(lease_id) BETWEEN 1 AND 64);
ALTER TABLE owner_proposals ADD COLUMN lease_expires_at TEXT
  CHECK (lease_expires_at IS NULL OR lease_expires_at GLOB '????-??-??T??:??:??.???Z');
ALTER TABLE owner_proposals ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
  CHECK (attempts >= 0);
ALTER TABLE owner_proposals ADD COLUMN requires_full_read INTEGER NOT NULL DEFAULT 0
  CHECK (requires_full_read IN (0, 1));
ALTER TABLE owner_proposals ADD COLUMN requires_presence INTEGER NOT NULL DEFAULT 0
  CHECK (requires_presence IN (0, 1));
ALTER TABLE owner_proposals ADD COLUMN executed_at TEXT
  CHECK (executed_at IS NULL OR executed_at GLOB '????-??-??T??:??:??.???Z');
ALTER TABLE owner_proposals ADD COLUMN execution_ref TEXT
  CHECK (execution_ref IS NULL OR length(execution_ref) BETWEEN 1 AND 256);
