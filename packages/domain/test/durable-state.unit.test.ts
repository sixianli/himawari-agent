import { describe, expect, it } from "vitest";

import {
  DOMAIN_ERROR_CODES,
  DomainError,
  activateDeployment,
  assertAuthorityFence,
  closeCoverageGap,
  createAgentId,
  createBackupId,
  createCheckpointJobId,
  createCoverageGapId,
  createDeploymentId,
  createDeviceId,
  createGitHubReceiptId,
  createHealthSnapshotId,
  createJobId,
  createMemoryGenerationId,
  createMemoryId,
  createMessageId,
  createProductThreadMessage,
  createOccurrenceId,
  createOwnerId,
  createSessionId,
  createThreadCheckpointJob,
  createThreadId,
  createTransferId,
  evaluateDeploymentHealth,
  revokeBrowserSession,
  retireDeployment,
  transitionBackgroundJob,
  transitionCheckpointJob,
  transitionGitHubReceipt,
  transitionMemoryGeneration,
  transitionMemoryLifecycle,
  transitionOccurrence,
  transitionRecoveryPoint,
  transitionTransfer,
  type BackgroundJobState,
  type BackgroundOccurrence,
  type BrowserSessionState,
  type DeploymentAuthorityState,
  type GitHubCoverageGap,
  type GitHubWebhookReceipt,
  type MemoryGenerationState,
  type ProductMemoryLifecycle,
  type RecoveryPointState,
  type TransferState,
} from "../src/index.ts";

const ownerId = createOwnerId("owner-01");
const agentId = createAgentId("agent-01");
const deploymentId = createDeploymentId("deployment-mac-01");

describe("stable product identifiers", () => {
  it("creates product IDs independently from provider and storage identifiers", () => {
    expect(createMessageId("message-01")).toBe("message-01");
    expect(createSessionId("session-01")).toBe("session-01");
    expect(createDeviceId("device-01")).toBe("device-01");
    expect(createJobId("job-01")).toBe("job-01");
    expect(createOccurrenceId("occurrence-01")).toBe("occurrence-01");
    expect(createMemoryId("memory-01")).toBe("memory-01");
    expect(createGitHubReceiptId("github-receipt-01")).toBe("github-receipt-01");
    expect(createCoverageGapId("coverage-gap-01")).toBe("coverage-gap-01");
    expect(createBackupId("backup-01")).toBe("backup-01");
    expect(createTransferId("transfer-01")).toBe("transfer-01");
  });
});

describe("deployment authority and fencing", () => {
  const inactive: DeploymentAuthorityState = {
    id: deploymentId,
    ownerId,
    agentId,
    revision: 0,
    status: "inactive_ready",
    authorityEpoch: 7,
    fencingToken: 0,
    transferId: createTransferId("transfer-in-01"),
  };

  it("activates only with a higher epoch and positive fence", () => {
    const active = activateDeployment(inactive, { authorityEpoch: 8, fencingToken: 1 });

    expect(active).toMatchObject({ status: "active", authorityEpoch: 8, fencingToken: 1 });
    expect(() =>
      assertAuthorityFence(active, {
        deploymentId,
        authorityEpoch: 7,
        fencingToken: 1,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: DOMAIN_ERROR_CODES.STALE_AUTHORITY_FENCE,
      }),
    );
  });

  it("keeps retired deployments permanently non-authoritative", () => {
    const active = activateDeployment(inactive, { authorityEpoch: 8, fencingToken: 1 });
    const retired = retireDeployment(
      retireDeployment(active, "retired_pending_transfer"),
      "retired",
    );

    expect(retired.status).toBe("retired");
    expect(() => activateDeployment(retired, { authorityEpoch: 9, fencingToken: 2 })).toThrow(
      DomainError,
    );
  });
});

describe("Thread checkpoint generation", () => {
  it("keeps committed message content behind a Payload reference", () => {
    expect(
      createProductThreadMessage({
        id: createMessageId("message-01"),
        ownerId,
        agentId,
        threadId: createThreadId("thread-01"),
        sequence: 1,
        role: "owner",
        contentRef: "payload-message-01",
        dataClassification: "private",
        committedAt: "2026-08-26T00:00:00.000Z",
      }),
    ).toMatchObject({ id: "message-01", contentRef: "payload-message-01", sequence: 1 });
  });

  it("reuses job and generation identity across retry", () => {
    const job = createThreadCheckpointJob({
      id: createCheckpointJobId("checkpoint-01"),
      generationId: createMemoryGenerationId("generation-01"),
      ownerId,
      agentId,
      threadId: createThreadId("thread-01"),
      sourceWatermark: 42,
      policyVersion: "policy-v1",
      requestedAt: "2026-08-26T00:00:00.000Z",
    });
    const retry = transitionCheckpointJob(transitionCheckpointJob(job, "running"), "retry_wait");

    expect(transitionCheckpointJob(retry, "running")).toMatchObject({
      id: job.id,
      generationId: job.generationId,
      sourceWatermark: 42,
      status: "running",
    });
  });

  it("makes a completed generation terminal", () => {
    const generation: MemoryGenerationState = {
      id: createMemoryGenerationId("generation-01"),
      checkpointJobId: createCheckpointJobId("checkpoint-01"),
      ownerId,
      agentId,
      threadId: createThreadId("thread-01"),
      status: "pending",
      modelDescriptorRef: "model-primary-v1",
      policyVersion: "policy-v1",
      outputRef: null,
    };
    const completed = transitionMemoryGeneration(
      transitionMemoryGeneration(generation, "running"),
      "completed",
      "payload-generation-01",
    );

    expect(completed.outputRef).toBe("payload-generation-01");
    expect(() => transitionMemoryGeneration(completed, "running")).toThrow(DomainError);
  });
});

describe("browser session and device state", () => {
  it("revokes a product session without treating the authentication reference as its ID", () => {
    const session: BrowserSessionState = {
      id: createSessionId("session-01"),
      ownerId,
      deviceId: createDeviceId("device-01"),
      status: "active",
      authenticationRef: "authentication-ref-01",
      firstAuthenticatedAt: "2026-08-26T00:00:00.000Z",
      lastActiveAt: "2026-08-26T00:01:00.000Z",
      recentAuthenticatedAt: "2026-08-26T00:00:30.000Z",
      revokedAt: null,
    };

    expect(revokeBrowserSession(session, "2026-08-26T00:02:00.000Z")).toMatchObject({
      id: "session-01",
      status: "revoked",
      revokedAt: "2026-08-26T00:02:00.000Z",
    });
  });
});

describe("background occurrence and Memory lifecycle", () => {
  it("pauses and revokes a background job without allowing revoked recovery", () => {
    const job: BackgroundJobState = {
      id: createJobId("job-01"),
      ownerId,
      agentId,
      threadId: null,
      revision: 0,
      status: "active",
      authorizationRef: "authorization-job-01",
      nextOccurrenceAt: "2026-08-27T00:00:00.000Z",
    };
    const revoked = transitionBackgroundJob(
      transitionBackgroundJob(transitionBackgroundJob(job, "paused"), "active"),
      "revoked",
    );

    expect(revoked.status).toBe("revoked");
    expect(() => transitionBackgroundJob(revoked, "active")).toThrow(DomainError);
  });

  it("never reopens a terminal occurrence", () => {
    const occurrence: BackgroundOccurrence = {
      id: createOccurrenceId("occurrence-01"),
      jobId: createJobId("job-01"),
      ownerId,
      agentId,
      stableKey: "job-01:provider-occurrence-01",
      status: "queued",
      authority: { deploymentId, authorityEpoch: 8, fencingToken: 1 },
      attemptCount: 0,
      nextRetryAt: null,
      deadlineAt: "2026-08-26T00:05:00.000Z",
      runId: null,
    };
    const completed = transitionOccurrence(
      transitionOccurrence(transitionOccurrence(occurrence, "admitted"), "running"),
      "completed",
    );

    expect(() => transitionOccurrence(completed, "queued")).toThrow(DomainError);
  });

  it("makes deleted Memory permanently inactive while retaining its product ID", () => {
    const memory: ProductMemoryLifecycle = {
      id: createMemoryId("memory-01"),
      ownerId,
      agentId,
      revision: 1,
      status: "active",
      providerRecordId: "mem0-provider-record-876",
    };
    const deleted = transitionMemoryLifecycle(
      transitionMemoryLifecycle(memory, "deletion_pending"),
      "deleted_verified",
    );

    expect(deleted).toMatchObject({ id: createMemoryId("memory-01"), status: "deleted_verified" });
    expect(() => transitionMemoryLifecycle(deleted, "active")).toThrow(DomainError);
  });
});

describe("GitHub receipt and coverage gap state", () => {
  it("deduplicates with a product receipt ID while retaining provider delivery identity separately", () => {
    const receipt: GitHubWebhookReceipt = {
      id: createGitHubReceiptId("github-receipt-01"),
      ownerId,
      agentId,
      providerDeliveryId: "provider-delivery-9f2c",
      installationRef: "github-installation-01",
      repositoryRef: "github-repository-01",
      payloadRef: "payload-webhook-01",
      status: "received",
      occurrenceId: null,
    };

    expect(
      transitionGitHubReceipt(receipt, "normalized", createOccurrenceId("occurrence-01")),
    ).toMatchObject({
      id: "github-receipt-01",
      providerDeliveryId: "provider-delivery-9f2c",
      occurrenceId: "occurrence-01",
    });
  });

  it("closes a coverage gap without inventing replayed events", () => {
    const gap: GitHubCoverageGap = {
      id: createCoverageGapId("coverage-gap-01"),
      ownerId,
      agentId,
      monitorId: createJobId("job-01"),
      startedAt: "2026-08-26T00:00:00.000Z",
      endedAt: null,
      status: "open",
    };

    expect(closeCoverageGap(gap, "2026-08-26T01:00:00.000Z")).toMatchObject({
      status: "closed",
      endedAt: "2026-08-26T01:00:00.000Z",
    });
  });
});

describe("backup, transfer and health state", () => {
  it("makes a verified same-host recovery point terminal", () => {
    const recoveryPoint: RecoveryPointState = {
      id: createBackupId("backup-01"),
      ownerId,
      agentId,
      status: "creating",
      manifestRef: null,
    };
    const verified = transitionRecoveryPoint(recoveryPoint, "verified", "backup-manifest-01");

    expect(verified.manifestRef).toBe("backup-manifest-01");
    expect(() => transitionRecoveryPoint(verified, "failed", null)).toThrow(DomainError);
  });

  it("requires every transfer phase instead of skipping directly to activation", () => {
    const proposed: TransferState = {
      id: createTransferId("transfer-01"),
      ownerId,
      agentId,
      sourceDeploymentId: deploymentId,
      targetDeploymentId: createDeploymentId("deployment-hermes-01"),
      status: "proposed",
      authorityEpoch: 8,
      packageRef: null,
    };

    expect(() => transitionTransfer(proposed, "activated")).toThrow(DomainError);
    expect(
      transitionTransfer(
        transitionTransfer(
          transitionTransfer(transitionTransfer(proposed, "exporting"), "exported_verified"),
          "importing",
        ),
        "inactive_ready",
      ).status,
    ).toBe("inactive_ready");
  });

  it("keeps readiness false for a failed critical dependency and only degrades optional reachability", () => {
    expect(
      evaluateDeploymentHealth({
        live: true,
        authorityActive: true,
        snapshotId: createHealthSnapshotId("health-snapshot-01"),
        dependencies: [
          { name: "sqlite", required: true, status: "unavailable", reasonCode: "SQLITE_DOWN" },
        ],
      }).ready,
    ).toBe(false);
    expect(
      evaluateDeploymentHealth({
        live: true,
        authorityActive: true,
        snapshotId: createHealthSnapshotId("health-snapshot-02"),
        dependencies: [
          { name: "model-provider", required: false, status: "unavailable", reasonCode: "TIMEOUT" },
        ],
      }),
    ).toMatchObject({ ready: true, status: "degraded" });
  });
});
