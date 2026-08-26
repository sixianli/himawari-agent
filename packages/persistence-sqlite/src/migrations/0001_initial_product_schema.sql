CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  UNIQUE (owner_id, id)
) STRICT;

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('inactive_ready', 'active', 'retired_pending_transfer', 'retired')),
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  transfer_id TEXT,
  UNIQUE (owner_id, agent_id, id),
  UNIQUE (agent_id, authority_epoch)
) STRICT;

CREATE UNIQUE INDEX deployments_one_active_agent
  ON deployments(agent_id)
  WHERE status = 'active';

CREATE TABLE authority_leases (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
  holder_id TEXT NOT NULL,
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  UNIQUE (deployment_id, authority_epoch, fencing_token)
) STRICT;

CREATE TABLE authority_transfers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source_deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
  target_deployment_id TEXT NOT NULL,
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'exporting', 'exported_verified', 'importing', 'inactive_ready', 'activated', 'abandoned')),
  package_ref TEXT,
  consumed_at TEXT,
  UNIQUE (source_deployment_id, target_deployment_id, authority_epoch)
) STRICT;

CREATE TABLE payloads (
  ref TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('sqlite_blob', 'ciphertext_file')),
  ciphertext BLOB,
  ciphertext_path TEXT,
  content_digest TEXT NOT NULL,
  encryption_algorithm TEXT,
  key_ref TEXT,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'trashed', 'deletion_pending', 'deleted_verified')),
  created_at TEXT NOT NULL,
  CHECK (
    (storage_kind = 'sqlite_blob' AND ciphertext IS NOT NULL AND ciphertext_path IS NULL) OR
    (storage_kind = 'ciphertext_file' AND ciphertext IS NULL AND ciphertext_path IS NOT NULL)
  )
) STRICT;

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'trashed', 'deletion_pending', 'deleted_verified')),
  metadata_ref TEXT REFERENCES payloads(ref) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, id)
) STRICT;

CREATE TABLE thread_messages (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  role TEXT NOT NULL CHECK (role IN ('owner', 'agent', 'system')),
  content_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  committed_at TEXT NOT NULL,
  UNIQUE (thread_id, sequence)
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (owner_id, id)
) STRICT;

CREATE TABLE product_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  authentication_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  first_authenticated_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  recent_authenticated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (owner_id, device_id, id)
) STRICT;

CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('user_message', 'schedule', 'external_event')),
  source_id TEXT NOT NULL,
  payload_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  source_proof_ref TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, idempotency_key)
) STRICT;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  session_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL UNIQUE REFERENCES triggers(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'building_context', 'running', 'awaiting_approval', 'reconciling_external_result', 'completed', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, id)
) STRICT;

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
  committed_at TEXT,
  UNIQUE (run_id, turn_index)
) STRICT;

CREATE TABLE run_checkpoints (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  phase TEXT NOT NULL,
  checkpoint_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, revision)
) STRICT;

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  intent_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  semantic_snapshot_hash TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT
) STRICT;

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired', 'consumed')),
  scope_ref TEXT NOT NULL,
  authorization_ref TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE TABLE authorization_usage (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  operation TEXT NOT NULL,
  cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0),
  used_at TEXT NOT NULL,
  UNIQUE (grant_id, id)
) STRICT;

CREATE TABLE capability_declarations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  version TEXT NOT NULL,
  integrity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('discovered', 'installation_proposed', 'installation_approved', 'active', 'disabled', 'uninstalled')),
  declaration_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  UNIQUE (owner_id, agent_id, id, version)
) STRICT;

CREATE TABLE capability_handles (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capability_declarations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  authorization_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired', 'consumed')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE TABLE command_results (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  command_type TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  result_ref TEXT NOT NULL,
  state_key TEXT NOT NULL,
  state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
  committed_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, idempotency_key)
) STRICT;

CREATE TABLE reliable_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  publication_state TEXT NOT NULL CHECK (publication_state IN ('pending', 'claimed', 'published')),
  claim_id TEXT,
  claim_expires_at TEXT,
  occurred_at TEXT NOT NULL,
  published_at TEXT,
  acknowledgement_ref TEXT,
  UNIQUE (owner_id, agent_id, idempotency_key)
) STRICT;

CREATE TABLE trace_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  payload_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (run_id, sequence)
) STRICT;

CREATE TABLE audit_records (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'completed', 'failed')),
  detail_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TABLE deletion_tombstones (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'incomplete', 'verified')),
  requested_at TEXT NOT NULL,
  purge_deadline_at TEXT NOT NULL,
  verified_at TEXT,
  UNIQUE (object_type, object_id)
) STRICT;

CREATE TABLE scheduled_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked')),
  authorization_ref TEXT NOT NULL,
  definition_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  next_occurrence_at TEXT,
  UNIQUE (owner_id, agent_id, id)
) STRICT;

CREATE TABLE job_occurrences (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'admitted', 'running', 'retry_wait', 'blocked_credentials', 'blocked_approval', 'budget_blocked', 'capacity_blocked', 'completed', 'failed_terminal', 'missed')),
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  next_retry_at TEXT,
  deadline_at TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  UNIQUE (job_id, stable_key)
) STRICT;

CREATE TABLE attention_decisions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('SILENT', 'INBOX', 'DIGEST', 'NOTIFY', 'INTERRUPT')),
  reason_code TEXT NOT NULL,
  decision_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  decided_at TEXT NOT NULL
) STRICT;

CREATE TABLE inbox_deliveries (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  result_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE thread_checkpoint_jobs (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  source_watermark INTEGER NOT NULL CHECK (source_watermark >= 1),
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'retry_wait', 'failed_terminal')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  summary_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
  requested_at TEXT NOT NULL,
  error_code TEXT,
  UNIQUE (thread_id, source_watermark, policy_version)
) STRICT;

CREATE TABLE memory_generations (
  id TEXT PRIMARY KEY,
  checkpoint_job_id TEXT NOT NULL UNIQUE REFERENCES thread_checkpoint_jobs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed_terminal')),
  model_descriptor_ref TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  output_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT
) STRICT;

CREATE TABLE memory_records (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'trashed', 'deletion_pending', 'deleted_verified')),
  content_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification IN ('public', 'private', 'sensitive', 'restricted')),
  source_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  inference INTEGER NOT NULL CHECK (inference IN (0, 1)),
  confidence_permille INTEGER NOT NULL CHECK (confidence_permille BETWEEN 0 AND 1000),
  policy_version TEXT NOT NULL,
  provider_record_id TEXT UNIQUE,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, agent_id, id)
) STRICT;

CREATE TABLE memory_provenance (
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_deleted INTEGER NOT NULL CHECK (source_deleted IN (0, 1)),
  PRIMARY KEY (memory_id, source_type, source_id)
) STRICT;

CREATE TABLE memory_projection_jobs (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  memory_revision INTEGER NOT NULL CHECK (memory_revision >= 0),
  generation_id TEXT NOT NULL REFERENCES memory_generations(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'retry_wait', 'failed_terminal')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  next_retry_at TEXT,
  provider_record_id TEXT,
  error_code TEXT,
  UNIQUE (memory_id, memory_revision, operation)
) STRICT;

CREATE TABLE github_installations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider_installation_id TEXT NOT NULL UNIQUE,
  secret_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE github_repository_monitors (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  provider_repository_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked')),
  authorization_ref TEXT NOT NULL,
  enabled_events_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  UNIQUE (installation_id, provider_repository_id)
) STRICT;

CREATE TABLE github_webhook_receipts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  repository_monitor_id TEXT NOT NULL REFERENCES github_repository_monitors(id) ON DELETE CASCADE,
  provider_delivery_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  action TEXT,
  payload_ref TEXT NOT NULL REFERENCES payloads(ref) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('received', 'normalized', 'rejected')),
  occurrence_id TEXT REFERENCES job_occurrences(id) ON DELETE SET NULL,
  received_at TEXT NOT NULL,
  UNIQUE (installation_id, provider_delivery_id)
) STRICT;

CREATE TABLE github_coverage_gaps (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES github_repository_monitors(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  reason_code TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK ((status = 'open' AND ended_at IS NULL) OR (status = 'closed' AND ended_at IS NOT NULL))
) STRICT;

CREATE TABLE recovery_points (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('creating', 'verified', 'failed')),
  manifest_ref TEXT,
  digest TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT
) STRICT;

CREATE TABLE backup_restore_markers (
  id TEXT PRIMARY KEY,
  backup_id TEXT NOT NULL REFERENCES recovery_points(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'verify', 'restore')),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  result_ref TEXT,
  occurred_at TEXT NOT NULL
) STRICT;
