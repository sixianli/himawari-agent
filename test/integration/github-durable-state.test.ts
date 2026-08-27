import { mkdtemp, rm } from "node:fs/promises";
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
  return { repository, state };
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
    payloadRef: "payload:github-events",
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
});
