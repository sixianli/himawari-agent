INSERT INTO decision_ledger_kinds (kind) VALUES
  ('device_action');

INSERT INTO decision_ledger_outcomes (kind, outcome) VALUES
  ('device_action', 'waiting_owner'),
  ('device_action', 'queued'),
  ('device_action', 'delivered'),
  ('device_action', 'succeeded'),
  ('device_action', 'failed'),
  ('device_action', 'result_unknown'),
  ('device_action', 'expired'),
  ('device_action', 'rejected'),
  ('device_action', 'policy_changed');

CREATE TABLE device_actions (
  id TEXT PRIMARY KEY CHECK (length(id) = 37 AND substr(id, 1, 5) = 'dact_'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  device_id TEXT NOT NULL REFERENCES paired_devices(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 3 AND 64),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  arguments_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  action_kind TEXT NOT NULL CHECK (
    action_kind IN (
      'READ', 'CREATE_OR_UPDATE', 'DELETE', 'COMMUNICATE', 'PURCHASE_OR_FUNDS',
      'CREDENTIAL_OR_ACCESS', 'PRODUCTION_OR_RECOVERY', 'PUBLICATION', 'LEGAL_COMMITMENT',
      'PHYSICAL_SAFETY', 'INSTALL_OR_EXECUTE_CODE'
    )
  ),
  risk TEXT NOT NULL CHECK (risk IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  owner_presence INTEGER NOT NULL CHECK (owner_presence IN (0, 1)),
  approval_id TEXT CHECK (approval_id IS NULL OR length(approval_id) BETWEEN 1 AND 128),
  data_classification TEXT NOT NULL CHECK (
    data_classification IN ('public', 'private', 'sensitive', 'restricted')
  ),
  state TEXT NOT NULL CHECK (
    state IN (
      'waiting_owner', 'queued', 'delivered', 'succeeded', 'failed', 'result_unknown', 'expired',
      'rejected'
    )
  ),
  reason_code TEXT CHECK (
    reason_code IS NULL OR
    reason_code IN (
      'approval_not_connected', 'authorization_denied', 'owner_denied', 'owner_presence_unproven',
      'device_policy', 'device_revoked', 'device_unsupported', 'device_reported', 'report_missing',
      'device_lost_record', 'not_delivered_in_time'
    )
  ),
  result_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128),
  tool_call_id TEXT NOT NULL CHECK (length(tool_call_id) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.???Z'),
  delivered_at TEXT CHECK (delivered_at IS NULL OR delivered_at GLOB '????-??-??T??:??:??.???Z'),
  finished_at TEXT CHECK (finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (owner_id, agent_id, run_id, tool_call_id),
  CHECK (expires_at > created_at),
  CHECK ((state IN ('succeeded', 'failed', 'expired', 'rejected')) = (finished_at IS NOT NULL)),
  CHECK (state NOT IN ('delivered', 'succeeded', 'failed', 'result_unknown') OR delivered_at IS NOT NULL),
  CHECK (state NOT IN ('expired', 'rejected', 'result_unknown') OR reason_code IS NOT NULL),
  CHECK (state <> 'waiting_owner' OR approval_id IS NOT NULL)
) STRICT;

CREATE INDEX device_actions_device_state_index
  ON device_actions(owner_id, agent_id, device_id, state, created_at);

CREATE INDEX device_actions_fingerprint_index
  ON device_actions(owner_id, agent_id, fingerprint, state);

CREATE INDEX device_actions_due_index ON device_actions(state, expires_at);

CREATE TABLE device_policies (
  device_id TEXT PRIMARY KEY REFERENCES paired_devices(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  blocked_actions TEXT NOT NULL CHECK (json_valid(blocked_actions) AND json_type(blocked_actions) = 'array'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
) STRICT;

CREATE TRIGGER device_actions_revoked_device
AFTER UPDATE OF status ON paired_devices
WHEN NEW.status = 'revoked' AND OLD.status <> 'revoked'
BEGIN
  UPDATE device_actions
     SET state = 'rejected', reason_code = 'device_revoked', finished_at = NEW.revoked_at,
         updated_at = NEW.revoked_at, revision = revision + 1
   WHERE device_id = NEW.id AND state IN ('waiting_owner', 'queued');
  UPDATE device_actions
     SET state = 'result_unknown', reason_code = 'device_revoked', updated_at = NEW.revoked_at,
         revision = revision + 1
   WHERE device_id = NEW.id AND state = 'delivered';
END;
