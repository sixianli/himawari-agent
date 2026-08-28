import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitHubWebhookReceiptRecord } from "@himawari-agent/application";
import {
  createAgentId,
  createJobId,
  createOccurrenceId,
  createOwnerId,
  type BackgroundOccurrence,
} from "@himawari-agent/domain";
import {
  SqliteProductStateRepository,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-github-sqlite");
const AGENT_ID = createAgentId("agent-github-sqlite");
const MONITOR_ID = createJobId("monitor-github-sqlite");
const INSTALLATION_REF = "installation-github-sqlite";
const REPOSITORY_REF = "98765";
const T0 = "2026-08-27T00:00:00.000Z";
const T1 = "2026-08-27T00:00:01.000Z";
const AUTHORITY = {
  deploymentId: "deployment:github-sqlite" as never,
  authorityEpoch: 1,
  fencingToken: 1,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openFixture() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-github-state-"));
  roots.push(stateRoot);
  const databasePath = path.join(stateRoot, "product.sqlite");
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
    .run(AUTHORITY.deploymentId, OWNER_ID, AGENT_ID);
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at,
        content_type
      ) VALUES ('payload:github-events', ?, ?, 'private', 'sqlite_blob', X'00',
        'sha256:github-events', 'fixture', 'fixture-key', 'active', ?, 'application/json')`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext_path,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at,
        content_type
      ) VALUES ('payload:github-delivery', ?, ?, 'private', 'ciphertext_file',
        'sha256/aa/delivery.bin', 'sha256:github-delivery', 'fixture', 'fixture-key',
        'active', ?, 'application/json')`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database.close();
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => T0,
  });
  const state = repository.githubIntegrationState();
  await state.saveInstallation({
    id: INSTALLATION_REF,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    providerInstallationId: "12345",
    secretRef: "secret:github:webhook",
    status: "active",
    createdAt: T0,
  });
  await state.saveMonitor(
    {
      id: MONITOR_ID,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      revision: 1,
      installationRef: INSTALLATION_REF,
      repositoryRef: REPOSITORY_REF,
      enabledEventRefs: ["payload:github-events"],
      authorizationRef: "authorization:github-read",
      status: "active",
    },
    null,
  );
  await repository.scheduler().upsert(
    {
      id: MONITOR_ID,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: null,
      payloadRef: "payload:github-events",
      sourceProofRef: "proof:github-monitor",
      dataClassification: "private",
      authorizationRef: "authorization:github-read",
      taskScopeRef: "github:monitor",
      capabilityRef: "github.read_only",
      operation: "repository.monitor",
      resourceRef: REPOSITORY_REF,
      sideEffect: "none",
      estimatedCostMicros: 100,
      intervalMs: 60_000,
      minimumIntervalMs: 60_000,
      expiresAt: "2999-12-31T23:59:59.999Z",
      revokedAt: null,
      nextRunAt: T1,
      occurrence: 0,
      status: "active",
    },
    null,
  );
  return { repository, state, stateRoot };
}

function occurrence(deliveryId: string): BackgroundOccurrence {
  return {
    id: createOccurrenceId(`occurrence:${deliveryId}`),
    jobId: MONITOR_ID,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    revision: 1,
    stableKey: `github:${INSTALLATION_REF}:${deliveryId}`,
    status: "queued",
    authority: AUTHORITY,
    category: "github",
    dataClassification: "private",
    foreground: false,
    parallelSafe: true,
    estimatedCostMicros: 100,
    reservedCostMicros: 0,
    spentCostMicros: 0,
    attemptCount: 0,
    nextRetryAt: null,
    deadlineAt: "2999-12-31T23:59:59.999Z",
    runId: null,
    workLease: null,
    lastErrorCode: null,
  };
}

function receipt(
  deliveryId: string,
  occurrenceId: BackgroundOccurrence["id"] | null = null,
  payloadRef = "payload:github-events",
): GitHubWebhookReceiptRecord {
  return {
    id: `github-receipt:${deliveryId}` as GitHubWebhookReceiptRecord["id"],
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    providerDeliveryId: deliveryId,
    installationRef: INSTALLATION_REF,
    repositoryRef: REPOSITORY_REF,
    eventName: "push",
    action: null,
    payloadRef,
    status: occurrenceId ? "normalized" : "received",
    occurrenceId,
    receivedAt: T0,
  };
}

describe("SQLite GitHub integration state", () => {
  it("persists installation/monitor metadata and atomically deduplicates delivery admission", async () => {
    const fixture = await openFixture();
    const firstOccurrence = occurrence("delivery-sqlite-001");
    const first = await fixture.state.admitWebhook({
      receipt: receipt("delivery-sqlite-001"),
      occurrence: firstOccurrence,
    });
    const replay = await fixture.state.admitWebhook({
      receipt: receipt("delivery-sqlite-001"),
      occurrence: occurrence("delivery-sqlite-001"),
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.occurrenceId).toBe(firstOccurrence.id);
    expect(replay.occurrence.id).toBe(firstOccurrence.id);
    expect(await fixture.state.findReceipt("delivery-sqlite-001")).toMatchObject({
      status: "normalized",
      occurrenceId: firstOccurrence.id,
    });
    expect(await fixture.state.readInstallation(INSTALLATION_REF)).toMatchObject({
      providerInstallationId: "12345",
      secretRef: "secret:github:webhook",
    });
    expect(await fixture.state.readMonitor(MONITOR_ID)).toMatchObject({
      repositoryRef: REPOSITORY_REF,
      enabledEventRefs: ["payload:github-events"],
    });
    await fixture.state.saveInstallation({
      id: INSTALLATION_REF,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      providerInstallationId: "12345",
      secretRef: "secret:github:webhook",
      status: "revoked",
      createdAt: T0,
    });
    await expect(
      fixture.state.saveMonitor(
        {
          id: MONITOR_ID,
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          revision: 2,
          installationRef: INSTALLATION_REF,
          repositoryRef: REPOSITORY_REF,
          enabledEventRefs: ["payload:github-events"],
          authorizationRef: "authorization:github-read",
          status: "revoked",
        },
        1,
      ),
    ).resolves.toMatchObject({ status: "revoked", revision: 2 });
    await fixture.repository.close();
  });

  it("keeps coverage gaps as visible open/closed state", async () => {
    const fixture = await openFixture();
    const gap = await fixture.state.saveCoverageGap({
      id: "github-gap-sqlite-001" as never,
      monitorId: MONITOR_ID,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      status: "open",
      reasonCode: "worker_unavailable",
      startedAt: T0,
      endedAt: null,
    });
    await fixture.state.saveCoverageGap({ ...gap, status: "closed", endedAt: T1 });
    expect(await fixture.state.listCoverageGaps(MONITOR_ID)).toMatchObject([
      { status: "closed", reasonCode: "worker_unavailable", endedAt: T1 },
    ]);
    await fixture.repository.close();
  });

  it("durably retries delete policy and exposes completed readback", async () => {
    const fixture = await openFixture();
    const admitted = occurrence("delivery-history-delete");
    await fixture.state.admitWebhook({
      receipt: receipt("delivery-history-delete", null, "payload:github-delivery"),
      occurrence: admitted,
    });
    await fixture.state.saveCoverageGap({
      id: "github-gap-history-delete" as never,
      monitorId: MONITOR_ID,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      status: "closed",
      reasonCode: "offline",
      startedAt: T0,
      endedAt: T1,
    });
    const current = await fixture.state.readMonitor(MONITOR_ID);
    if (!current) throw new Error("monitor fixture disappeared");
    const revoked = await fixture.state.saveMonitor(
      {
        ...current,
        revision: 2,
        status: "revoked",
      },
      1,
    );
    const payloadTarget = path.join(
      fixture.stateRoot,
      "data",
      "payload-ciphertext",
      "sha256",
      "aa",
      "delivery.bin",
    );
    await mkdir(payloadTarget, { recursive: true });
    const history = fixture.repository.githubMonitorHistoryPolicy();
    await expect(
      history.apply({
        monitor: revoked,
        policy: "delete",
        requestedBy: "owner-subject",
        occurredAt: T1,
      }),
    ).rejects.toMatchObject({ code: "PORT_PROVIDER_FAILURE" });
    await expect(history.inspect(MONITOR_ID)).resolves.toMatchObject({
      status: "retry_wait",
      policy: "delete",
      attemptCount: 1,
      lastErrorCode: "payload_file_delete_failed",
    });
    await expect(history.listRetryable(10)).resolves.toHaveLength(1);

    await rm(payloadTarget, { recursive: true, force: true });
    await history.retry(MONITOR_ID, "2026-08-27T00:00:02.000Z");
    await expect(history.inspect(MONITOR_ID)).resolves.toMatchObject({
      status: "completed",
      attemptCount: 2,
      completedAt: "2026-08-27T00:00:02.000Z",
      lastErrorCode: null,
    });
    await expect(fixture.repository.scheduler().read(MONITOR_ID)).resolves.toBeUndefined();
    await expect(fixture.state.findReceipt("delivery-history-delete")).resolves.toBeUndefined();
    await expect(fixture.state.listCoverageGaps(MONITOR_ID)).resolves.toEqual([]);
    await fixture.repository.close();
  });

  it("completes retain policy without deleting monitor history", async () => {
    const fixture = await openFixture();
    const admitted = occurrence("delivery-history-retain");
    await fixture.state.admitWebhook({
      receipt: receipt("delivery-history-retain"),
      occurrence: admitted,
    });
    const current = await fixture.state.readMonitor(MONITOR_ID);
    if (!current) throw new Error("monitor fixture disappeared");
    const revoked = await fixture.state.saveMonitor(
      {
        ...current,
        revision: 2,
        status: "revoked",
      },
      1,
    );
    const history = fixture.repository.githubMonitorHistoryPolicy();
    await history.apply({
      monitor: revoked,
      policy: "retain",
      requestedBy: "owner-subject",
      occurredAt: T1,
    });
    await expect(history.inspect(MONITOR_ID)).resolves.toMatchObject({
      status: "completed",
      policy: "retain",
      attemptCount: 1,
    });
    await expect(fixture.repository.scheduler().read(MONITOR_ID)).resolves.toBeDefined();
    await expect(fixture.state.findReceipt("delivery-history-retain")).resolves.toBeDefined();
    await fixture.repository.close();
  });
});
