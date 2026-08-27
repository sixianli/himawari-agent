import path from "node:path";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { describe, expect, it } from "vitest";

const PHASES = [
  "context_formation",
  "model_stream",
  "approval_wait",
  "worker_result",
  "outbox",
  "thread_checkpoint",
  "memory_projection",
  "delivery",
] as const;
type Phase = (typeof PHASES)[number];

const OWNER_ID = "owner-phase-process";
const AGENT_ID = "agent-phase-process";
const DEPLOYMENT_ID = "deployment-phase-process";
const THREAD_ID = "thread-phase-process";
const RUN_ID = "run-phase-process";
const PAYLOAD_REF = "payload-phase-process";
const T0 = "2026-08-27T00:00:00.000Z";
const T1 = "2026-08-27T00:01:00.000Z";

function environment() {
  // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv is an index signature under strict TS.
  const stateRoot = process.env["HIMAWARI_PHASE_STATE_ROOT"];
  // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv is an index signature under strict TS.
  const phase = process.env["HIMAWARI_PHASE_NAME"];
  // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv is an index signature under strict TS.
  const mode = process.env["HIMAWARI_PHASE_MODE"];
  if (
    !stateRoot ||
    !path.isAbsolute(stateRoot) ||
    !PHASES.includes(phase as Phase) ||
    (mode !== "seed" && mode !== "inspect")
  ) {
    throw new Error("DURABLE_PHASE_FIXTURE_INVALID");
  }
  return { stateRoot, phase: phase as Phase, mode };
}

async function initialize(databasePath: string): Promise<void> {
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
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
  database.close();
}

function seedPhase(databasePath: string, phase: Phase): string {
  const identity = `${phase}:stable-identity`;
  const database = openQualifiedDatabase(databasePath);
  database
    .prepare(
      `INSERT INTO product_state_records (
        key, owner_id, agent_id, revision, value_json, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(
      `phase:${phase}`,
      OWNER_ID,
      AGENT_ID,
      JSON.stringify({ phase, identity, status: "running" }),
      T0,
    );
  if (phase === "approval_wait") {
    database
      .prepare(
        `INSERT INTO approval_requests (
          id, owner_id, agent_id, run_id, revision, status, risk, intent_ref,
          semantic_snapshot_hash, requested_at
        ) VALUES (?, ?, ?, ?, 1, 'pending', 'high', ?, 'phase-snapshot', ?)`,
      )
      .run(identity, OWNER_ID, AGENT_ID, RUN_ID, PAYLOAD_REF, T0);
  } else if (phase === "worker_result") {
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
  } else if (phase === "outbox") {
    database
      .prepare(
        `INSERT INTO reliable_events (
          id, owner_id, agent_id, idempotency_key, topic, payload_ref,
          publication_state, occurred_at
        ) VALUES (?, ?, ?, 'phase-outbox', 'run.changed', ?, 'pending', ?)`,
      )
      .run(identity, OWNER_ID, AGENT_ID, PAYLOAD_REF, T0);
  } else if (phase === "thread_checkpoint") {
    database
      .prepare(
        `INSERT INTO product_state_records (
          key, owner_id, agent_id, revision, value_json, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(
        `run-checkpoint:${identity}`,
        OWNER_ID,
        AGENT_ID,
        JSON.stringify({ phase, identity, terminalStatus: null }),
        T0,
      );
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
  } else if (phase === "memory_projection") {
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
  } else if (phase === "delivery") {
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
  database.close();
  return identity;
}

describe("durable phase crash fixture", () => {
  it("seeds or inspects one phase around an external SIGKILL", async () => {
    const { stateRoot, phase, mode } = environment();
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
      return;
    }

    const identity = `${phase}:stable-identity`;
    const marker = await repository.read(`phase:${phase}`);
    const recovery = await repository.startupRecovery();
    const operational = await repository.operationalStatus();
    const evidence = {
      context_formation: recovery.unfinishedRunKeys.includes(`phase:${phase}`),
      model_stream: recovery.unfinishedRunKeys.includes(`phase:${phase}`),
      approval_wait: recovery.pendingApprovalRequestIds.includes(identity),
      worker_result: recovery.unknownExternalResultOccurrenceIds.includes(identity),
      outbox: recovery.pendingEventIds.includes(identity),
      thread_checkpoint: recovery.unfinishedRunKeys.includes(`run-checkpoint:${identity}`),
      memory_projection: operational.memoryProjectionPending === 1,
      delivery:
        recovery.recoveredDeliveryRequestIds.includes(identity) &&
        recovery.pendingDeliveryRequestIds.includes(identity),
    } satisfies Record<Phase, boolean>;
    process.stdout.write(
      `HIMAWARI_PHASE ${JSON.stringify({
        ready: true,
        phase,
        identity,
        recovered: evidence[phase],
        // biome-ignore lint/complexity/useLiteralKeys: JsonObject is an index signature.
        markerIdentity: marker?.value["identity"],
      })}\n`,
    );
    await repository.close();
    expect(evidence[phase]).toBe(true);
    // biome-ignore lint/complexity/useLiteralKeys: JsonObject is an index signature.
    expect(marker?.value["identity"]).toBe(identity);
  });
});
