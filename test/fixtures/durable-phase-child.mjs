import { copyFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PHASES = [
  "context_formation",
  "model_stream",
  "approval_wait",
  "worker_result",
  "outbox",
  "thread_checkpoint",
  "memory_projection",
  "delivery",
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing child environment value: ${name}`);
  return value;
}

const runtimeRoot = required("HIMAWARI_TEST_RUNTIME_ROOT");
const stateRoot = required("HIMAWARI_PHASE_STATE_ROOT");
const phase = required("HIMAWARI_PHASE_NAME");
const mode = required("HIMAWARI_PHASE_MODE");
const templatePath = required("HIMAWARI_PHASE_TEMPLATE");
if (
  !path.isAbsolute(stateRoot) ||
  !PHASES.includes(phase) ||
  (mode !== "seed" && mode !== "inspect")
) {
  throw new Error("DURABLE_PHASE_FIXTURE_INVALID");
}

function loadPackage(name) {
  return import(
    pathToFileURL(path.join(runtimeRoot, "node_modules", ...name.split("/"), "dist", "index.js"))
      .href
  );
}

try {
  const [domain, persistence] = await Promise.all([
    loadPackage("@himawari-agent/domain"),
    loadPackage("@himawari-agent/persistence-sqlite"),
  ]);
  const { createAgentId, createAuthorityLeaseId, createDeploymentId, createOwnerId } = domain;
  const { openQualifiedDatabase, SqliteProductStateRepository } = persistence;

  const OWNER_ID = createOwnerId("owner-phase-process");
  const AGENT_ID = createAgentId("agent-phase-process");
  const DEPLOYMENT_ID = createDeploymentId("deployment-phase-process");
  const AUTHORITY_LEASE_ID = createAuthorityLeaseId("lease-phase-process");
  const THREAD_ID = "thread-phase-process";
  const RUN_ID = "run-phase-process";
  const PAYLOAD_REF = "payload-phase-process";
  const T0 = "2026-08-27T00:00:00.000Z";
  const T1 = "2026-08-27T00:01:00.000Z";
  const RECOVERY_SCOPE = {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    authority: {
      deploymentId: DEPLOYMENT_ID,
      authorityEpoch: 1,
      fencingToken: 1,
    },
    authorityLease: {
      leaseId: AUTHORITY_LEASE_ID,
      fencingToken: 1,
    },
  };

  async function initialize(databasePath) {
    await copyFile(templatePath, databasePath);
    const database = openQualifiedDatabase(databasePath);
    database
      .transaction(() => {
        database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
        database
          .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
          .run(AGENT_ID, OWNER_ID);
        database
          .prepare(
            `INSERT INTO deployments (
            id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
          ) VALUES (?, ?, ?, 0, 'active', 1, 1)`,
          )
          .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);
        database
          .prepare(
            `INSERT INTO authority_leases (
            id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
            fencing_token, acquired_at, expires_at
          ) VALUES (?, ?, ?, ?, 'phase-process', 1, 1, ?, '2999-12-31T23:59:59.999Z')`,
          )
          .run(AUTHORITY_LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, T0);
        database
          .prepare(
            `INSERT INTO payloads (
            ref, owner_id, agent_id, classification, storage_kind, ciphertext,
            content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at
          ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:phase',
            'fixture', 'fixture-key', 'active', ?)`,
          )
          .run(PAYLOAD_REF, OWNER_ID, AGENT_ID, T0);
        database
          .prepare(
            `INSERT INTO threads (
            id, owner_id, agent_id, revision, status, created_at, updated_at
          ) VALUES (?, ?, ?, 0, 'open', ?, ?)`,
          )
          .run(THREAD_ID, OWNER_ID, AGENT_ID, T0, T0);
        database
          .prepare(
            `INSERT INTO triggers (
            id, owner_id, agent_id, thread_id, idempotency_key, source_type,
            source_id, payload_ref, source_proof_ref, occurred_at
          ) VALUES ('trigger-phase-process', ?, ?, ?, 'trigger-phase-process',
            'user_message', 'fixture', ?, 'fixture-proof', ?)`,
          )
          .run(OWNER_ID, AGENT_ID, THREAD_ID, PAYLOAD_REF, T0);
        database
          .prepare(
            `INSERT INTO runs (
            id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'session-phase-process', 'trigger-phase-process', 1,
            'running', ?, ?)`,
          )
          .run(RUN_ID, OWNER_ID, AGENT_ID, THREAD_ID, T0, T0);
      })
      .immediate();
    database.close();
  }

  function seedPhase(databasePath, targetPhase) {
    const identity = `${targetPhase}:stable-identity`;
    const database = openQualifiedDatabase(databasePath);
    database
      .transaction(() => {
        database
          .prepare(
            `INSERT INTO product_state_records (
            key, owner_id, agent_id, revision, value_json, updated_at
          ) VALUES (?, ?, ?, 1, ?, ?)`,
          )
          .run(
            `phase:${targetPhase}`,
            OWNER_ID,
            AGENT_ID,
            JSON.stringify({ phase: targetPhase, identity, status: "running" }),
            T0,
          );
        if (targetPhase === "approval_wait") {
          database
            .prepare(
              `INSERT INTO approval_requests (
              id, owner_id, agent_id, run_id, revision, status, risk, intent_ref,
              semantic_snapshot_hash, requested_at
            ) VALUES (?, ?, ?, ?, 1, 'pending', 'high', ?, 'phase-snapshot', ?)`,
            )
            .run(identity, OWNER_ID, AGENT_ID, RUN_ID, PAYLOAD_REF, T0);
        } else if (targetPhase === "worker_result") {
          database
            .prepare(
              `INSERT INTO scheduled_jobs (
              id, owner_id, agent_id, revision, status, authorization_ref, definition_ref
            ) VALUES ('job-phase-process', ?, ?, 1, 'active', 'fixture-auth', ?)`,
            )
            .run(OWNER_ID, AGENT_ID, PAYLOAD_REF);
          database
            .prepare(
              `INSERT INTO job_occurrences (
              id, job_id, owner_id, agent_id, stable_key, status, deployment_id,
              authority_epoch, fencing_token, attempt_count, next_retry_at, deadline_at,
              run_id, last_error_code
            ) VALUES (?, 'job-phase-process', ?, ?, 'phase-worker-result', 'retry_wait', ?,
              1, 1, 1, NULL, ?, ?, 'EXTERNAL_RESULT_UNKNOWN')`,
            )
            .run(identity, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, T1, RUN_ID);
        } else if (targetPhase === "outbox") {
          database
            .prepare(
              `INSERT INTO reliable_events (
              id, owner_id, agent_id, idempotency_key, topic, payload_ref,
              publication_state, occurred_at
            ) VALUES (?, ?, ?, 'phase-outbox', 'run.changed', ?, 'pending', ?)`,
            )
            .run(identity, OWNER_ID, AGENT_ID, PAYLOAD_REF, T0);
        } else if (targetPhase === "thread_checkpoint") {
          database
            .prepare(
              `INSERT INTO run_coordination_checkpoints (
              run_id, owner_id, agent_id, revision, phase, context_ref,
              runtime_event_count, last_trace_event_id, terminal_status,
              output_kind, final_answer_ref, diagnostic_code, updated_at
            ) VALUES (?, ?, ?, 1, 'runtime_running', ?, 0, NULL, NULL,
              NULL, NULL, NULL, ?)`,
            )
            .run(RUN_ID, OWNER_ID, AGENT_ID, PAYLOAD_REF, T0);
          database
            .prepare(
              `INSERT INTO thread_checkpoint_jobs (
              id, generation_id, owner_id, agent_id, thread_id, revision,
              source_watermark, policy_version, status, attempt_count, requested_at,
              claimed_by, claimed_at, claim_expires_at
            ) VALUES (?, ?, ?, ?, ?, 1, 1, 'phase-policy', 'running', 1, ?,
              'phase-worker-before-kill', ?, ?)`,
            )
            .run(identity, `generation:${identity}`, OWNER_ID, AGENT_ID, THREAD_ID, T0, T0, T0);
          database
            .prepare(
              `INSERT INTO memory_generations (
              id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
              model_descriptor_ref, policy_version
            ) VALUES (?, ?, ?, ?, ?, 'running', 'model-phase', 'phase-policy')`,
            )
            .run(`generation:${identity}`, identity, OWNER_ID, AGENT_ID, THREAD_ID);
        } else if (targetPhase === "memory_projection") {
          database
            .prepare(
              `INSERT INTO thread_checkpoint_jobs (
              id, generation_id, owner_id, agent_id, thread_id, revision,
              source_watermark, policy_version, status, attempt_count, requested_at
            ) VALUES ('checkpoint-memory-phase', 'generation-memory-phase', ?, ?, ?, 1,
              1, 'phase-policy', 'completed', 1, ?)`,
            )
            .run(OWNER_ID, AGENT_ID, THREAD_ID, T0);
          database
            .prepare(
              `INSERT INTO memory_generations (
              id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
              model_descriptor_ref, policy_version
            ) VALUES ('generation-memory-phase', 'checkpoint-memory-phase', ?, ?, ?,
              'completed', 'model-phase', 'phase-policy')`,
            )
            .run(OWNER_ID, AGENT_ID, THREAD_ID);
          database
            .prepare(
              `INSERT INTO memory_records (
              id, owner_id, agent_id, revision, status, content_ref, classification,
              source_thread_id, inference, confidence_permille, policy_version, updated_at
            ) VALUES ('memory-phase-process', ?, ?, 1, 'active', ?, 'private', ?, 0,
              1000, 'phase-policy', ?)`,
            )
            .run(OWNER_ID, AGENT_ID, PAYLOAD_REF, THREAD_ID, T0);
          database
            .prepare(
              `INSERT INTO memory_projection_jobs (
              id, memory_id, memory_revision, generation_id, operation, status,
              attempt_count
            ) VALUES (?, 'memory-phase-process', 1, 'generation-memory-phase',
              'upsert', 'pending', 0)`,
            )
            .run(identity);
        } else if (targetPhase === "delivery") {
          const record = {
            id: identity,
            revision: 2,
            candidateId: "candidate-phase-process",
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            runId: RUN_ID,
            resultRef: PAYLOAD_REF,
            dataClassification: "private",
            level: "INBOX",
            status: "delivering",
            assignedClientId: "client-before-kill",
            attempts: 1,
            acknowledgementRef: null,
            lastErrorCode: null,
            createdAt: T0,
            updatedAt: T0,
          };
          database
            .prepare(
              `INSERT INTO inbox_deliveries (
              id, owner_id, agent_id, run_id, revision, result_ref, status,
              created_at, updated_at, record_json
            ) VALUES (?, ?, ?, ?, 2, ?, 'delivering', ?, ?, ?)`,
            )
            .run(identity, OWNER_ID, AGENT_ID, RUN_ID, PAYLOAD_REF, T0, T0, JSON.stringify(record));
        }
      })
      .immediate();
    database.close();
    return identity;
  }

  const databasePath = path.join(stateRoot, "product.sqlite");
  if (mode === "seed") await initialize(databasePath);
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => T1,
  });
  if (mode === "seed") {
    const identity = seedPhase(databasePath, phase);
    process.stdout.write(`HIMAWARI_PHASE ${JSON.stringify({ ready: true, phase, identity })}\n`);
    await new Promise(() => undefined);
  }

  const identity = `${phase}:stable-identity`;
  const marker = await repository.read(`phase:${phase}`);
  const recovery = await repository.startupRecovery(RECOVERY_SCOPE);
  const operational = await repository.operationalStatus();
  const evidence = {
    context_formation: recovery.unfinishedRunKeys.includes(`phase:${phase}`),
    model_stream: recovery.unfinishedRunKeys.includes(`phase:${phase}`),
    approval_wait: recovery.pendingApprovalRequestIds.includes(identity),
    worker_result: recovery.unknownExternalResultOccurrenceIds.includes(identity),
    outbox: recovery.pendingEventIds.includes(identity),
    thread_checkpoint: recovery.unfinishedRunKeys.includes(RUN_ID),
    memory_projection: operational.memoryProjectionPending === 1,
    delivery:
      recovery.recoveredDeliveryRequestIds.includes(identity) &&
      recovery.pendingDeliveryRequestIds.includes(identity),
  };
  process.stdout.write(
    `HIMAWARI_PHASE ${JSON.stringify({
      ready: true,
      phase,
      identity,
      recovered: evidence[phase],
      markerIdentity: marker?.value["identity"],
    })}\n`,
  );
  await repository.close();
  if (evidence[phase] !== true) throw new Error(`DURABLE_PHASE_EVIDENCE_MISSING:${phase}`);
  if (marker?.value["identity"] !== identity)
    throw new Error(`DURABLE_PHASE_MARKER_MISSING:${phase}`);
} catch (error) {
  process.stderr.write(
    `HIMAWARI_PHASE_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}
