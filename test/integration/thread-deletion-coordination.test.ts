import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ThreadCommandService,
  ThreadDeletionCoordinationService,
  type ActionIntent,
  type ApprovalRequest,
  type GrantRecord,
  type ScheduledJobWrite,
} from "@himawari-agent/application";
import {
  createAgentId,
  createDeploymentId,
  createIdempotencyKey,
  createOwnerId,
  createSessionId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  SqliteGovernedDeletionAdapter,
  SqliteProductStateRepository,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { ManualClock } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";

const ownerId = createOwnerId("owner-thread-delete-coordination");
const agentId = createAgentId("agent-thread-delete-coordination");
const deploymentId = createDeploymentId("deployment-thread-delete-coordination");
const sessionId = createSessionId("session-thread-delete-coordination");
const authority: ProductAuthorityFence = {
  deploymentId,
  authorityEpoch: 5,
  fencingToken: 9,
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-thread-delete-coordination-"));
  roots.push(stateRoot);
  await mkdir(path.join(stateRoot, "data"), { recursive: true, mode: 0o700 });
  const databasePath = path.join(stateRoot, "data", "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(ownerId);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(agentId, ownerId);
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES (?, ?, ?, 0, 'active', ?, ?)`,
    )
    .run(deploymentId, ownerId, agentId, authority.authorityEpoch, authority.fencingToken);
  const payloads = [
    "payload-create-source",
    "payload-create-target",
    "payload-owner-message",
    "payload-admit-result",
    "payload-archive-result",
    "payload-restore-result",
    "payload-task-pause",
    "payload-task-rebind",
    "payload-task-pause-result",
    "payload-task-rebind-result",
    "payload-trash-result",
    "payload-post-trash-restore-result",
    "payload-permanent-result",
  ];
  const insertPayload = database.prepare(
    `INSERT INTO payloads (
      ref, owner_id, agent_id, classification, storage_kind, ciphertext,
      content_digest, lifecycle_state, created_at
    ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'active', ?)`,
  );
  for (const ref of payloads) {
    insertPayload.run(ref, ownerId, agentId, `sha256:${ref}`, "2026-08-28T01:00:00.000Z");
  }
  database.close();
  const clock = new ManualClock("2026-08-28T01:00:00.000Z");
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => clock.now(),
  });
  return { stateRoot, databasePath, clock, repository };
}

function scheduledJob(
  id: string,
  threadId: ScheduledJobWrite["threadId"],
  payloadRef: string,
): ScheduledJobWrite {
  return {
    id,
    ownerId,
    agentId,
    threadId,
    payloadRef,
    sourceProofRef: `proof:${id}`,
    dataClassification: "private",
    authorizationRef: "grant-thread-delete",
    taskScopeRef: `task-scope:${id}`,
    capabilityRef: "capability:fixture",
    operation: "fixture.read",
    resourceRef: `resource:${id}`,
    sideEffect: "none",
    estimatedCostMicros: 0,
    intervalMs: 60_000,
    minimumIntervalMs: 60_000,
    expiresAt: "2026-09-28T01:00:00.000Z",
    revokedAt: null,
    nextRunAt: "2026-08-29T01:00:00.000Z",
    occurrence: 0,
    status: "active",
  };
}

describe("Thread deletion coordination", () => {
  it("requires explicit task resolution and preserves independent authorization state", async () => {
    const resource = await fixture();
    const { repository, clock } = resource;
    const threads = repository.threadRepository();
    const commands = new ThreadCommandService({
      repository: threads,
      clock,
      authority: () => authority,
    });
    const coordinator = new ThreadDeletionCoordinationService({
      repository: threads,
      clock,
      authority: () => authority,
    });

    const source = await commands.create({
      ownerId,
      agentId,
      idempotencyKey: "create-source-thread",
      resultRef: "payload-create-source",
    });
    const target = await commands.create({
      ownerId,
      agentId,
      idempotencyKey: "create-target-thread",
      resultRef: "payload-create-target",
    });
    const admitted = await commands.admitOwnerMessage({
      ownerId,
      agentId,
      threadId: source.thread.id,
      expectedThreadRevision: source.thread.revision,
      sessionId,
      idempotencyKey: "admit-source-message",
      contentRef: "payload-owner-message",
      sourceProofRef: "proof:owner-session",
      dataClassification: "private",
      resultRef: "payload-admit-result",
    });
    const runId = admitted.message.runId;
    if (!runId) throw new Error("Fixture message admission did not create a Run");

    const intent: ActionIntent = {
      id: "intent-thread-delete-archive-invariant",
      ownerId,
      agentId,
      runId,
      capabilityRef: "capability:fixture",
      operation: "fixture.read",
      resourceRef: "resource:fixture",
      dataClassification: "private",
      sideEffect: "none",
      estimatedCostMicros: 0,
      frequency: { count: 1, intervalMs: null },
      idempotencyKey: createIdempotencyKey("intent-thread-delete-archive-invariant"),
      reversible: true,
      requestedAt: clock.now(),
    };
    const approval: ApprovalRequest = {
      id: "approval-thread-delete-archive-invariant",
      revision: 1,
      ownerId,
      agentId,
      runId,
      intentId: intent.id,
      intentSnapshot: intent,
      semanticSnapshotHash: "snapshot:thread-delete-archive-invariant",
      status: "pending",
      deliveryState: "deliverable",
      requestedAt: clock.now(),
      expiresAt: "2026-08-29T01:00:00.000Z",
      decidedAt: null,
      grantId: null,
    };
    const grant: GrantRecord = {
      id: "grant-thread-delete-archive-invariant",
      revision: 1,
      ownerId,
      agentId,
      kind: "one_time",
      scope: {
        capabilityRef: intent.capabilityRef,
        operations: [intent.operation],
        exactResourceRef: intent.resourceRef,
        resourcePrefixes: [],
        maxDataClassification: "private",
        sideEffects: ["none"],
        maxCostMicrosPerUse: 0,
        maxFrequency: { count: 1, intervalMs: null },
      },
      intentFingerprint: approval.semanticSnapshotHash,
      sourceApprovalRequestId: approval.id,
      validFrom: clock.now(),
      expiresAt: approval.expiresAt,
      maxUses: 1,
      uses: 0,
      maxTotalCostMicros: 0,
      spentCostMicros: 0,
      revokedAt: null,
      revocationReasonCode: null,
    };
    const authorization = repository.authorizationStore();
    await authorization.createApproval(approval);
    await authorization.resolveApproval({
      approvalRequestId: approval.id,
      expectedRevision: approval.revision,
      semanticSnapshotHash: approval.semanticSnapshotHash,
      resolution: "approved",
      decidedAt: clock.now(),
      grant,
    });

    const scheduler = repository.scheduler();
    const pauseTask = await scheduler.upsert(
      scheduledJob("task-pause-before-delete", source.thread.id, "payload-task-pause"),
      null,
    );
    const rebindTask = await scheduler.upsert(
      scheduledJob("task-rebind-before-delete", source.thread.id, "payload-task-rebind"),
      null,
    );
    const approvalBeforeArchive = await authorization.getApproval(approval.id);
    const grantsBeforeArchive = await authorization.listGrants(ownerId, agentId);

    const archived = await commands.setLifecycle({
      ownerId,
      agentId,
      threadId: source.thread.id,
      expectedRevision: admitted.thread.revision,
      status: "archived",
      idempotencyKey: "archive-source-thread",
      resultRef: "payload-archive-result",
    });
    expect(await scheduler.read(pauseTask.id)).toEqual(pauseTask);
    expect(await authorization.getApproval(approval.id)).toEqual(approvalBeforeArchive);
    expect(await authorization.listGrants(ownerId, agentId)).toEqual(grantsBeforeArchive);

    const restored = await commands.setLifecycle({
      ownerId,
      agentId,
      threadId: source.thread.id,
      expectedRevision: archived.thread.revision,
      status: "active",
      idempotencyKey: "restore-source-thread",
      resultRef: "payload-restore-result",
    });
    await expect(
      coordinator.trash({
        ownerId,
        agentId,
        threadId: source.thread.id,
        expectedThreadRevision: restored.thread.revision,
        reasonCode: "owner_requested",
        idempotencyKey: "trash-source-before-task-resolution",
        resultRef: "payload-trash-result",
      }),
    ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    await expect(coordinator.inspect(ownerId, agentId, source.thread.id)).resolves.toMatchObject({
      activeTaskIds: [pauseTask.id, rebindTask.id],
    });

    const pauseResolution = {
      ownerId,
      agentId,
      threadId: source.thread.id,
      taskId: pauseTask.id,
      expectedTaskRevision: pauseTask.revision,
      resolution: { action: "pause" as const },
      reasonCode: "owner_selected_pause",
      idempotencyKey: "resolve-source-task-pause",
      resultRef: "payload-task-pause-result",
    };
    const paused = await coordinator.resolveTask(pauseResolution);
    await expect(coordinator.resolveTask(pauseResolution)).resolves.toEqual(paused);
    expect(paused.task).toMatchObject({ status: "paused", threadId: source.thread.id });

    const rebound = await coordinator.resolveTask({
      ownerId,
      agentId,
      threadId: source.thread.id,
      taskId: rebindTask.id,
      expectedTaskRevision: rebindTask.revision,
      resolution: { action: "rebind", targetThreadId: target.thread.id },
      reasonCode: "owner_selected_rebind",
      idempotencyKey: "resolve-source-task-rebind",
      resultRef: "payload-task-rebind-result",
    });
    expect(rebound.task).toMatchObject({ status: "active", threadId: target.thread.id });
    expect(rebound.impact.activeTaskIds).toEqual([]);

    const trashed = await coordinator.trash({
      ownerId,
      agentId,
      threadId: source.thread.id,
      expectedThreadRevision: restored.thread.revision,
      reasonCode: "owner_requested",
      idempotencyKey: "trash-source-after-task-resolution",
      resultRef: "payload-trash-result",
    });
    expect(trashed.thread.status).toBe("trashed");
    expect(await scheduler.read(pauseTask.id)).toMatchObject({ status: "paused" });
    expect(await authorization.getApproval(approval.id)).toEqual(approvalBeforeArchive);
    expect(await authorization.listGrants(ownerId, agentId)).toEqual(grantsBeforeArchive);

    const activeAgain = await commands.setLifecycle({
      ownerId,
      agentId,
      threadId: source.thread.id,
      expectedRevision: trashed.thread.revision,
      status: "active",
      idempotencyKey: "restore-source-after-trash",
      resultRef: "payload-post-trash-restore-result",
    });
    const staleCoordinator = new ThreadDeletionCoordinationService({
      repository: threads,
      clock,
      authority: () => ({ ...authority, fencingToken: authority.fencingToken - 1 }),
    });
    await expect(
      staleCoordinator.deletePermanently({
        ownerId,
        agentId,
        threadId: source.thread.id,
        expectedThreadRevision: activeAgain.thread.revision,
        reasonCode: "owner_requested_permanent_delete",
        authorizationRef: "approval:permanent-delete",
        recentAuthenticationRef: "recent-auth:owner",
        idempotencyKey: "permanent-delete-with-stale-fence",
        resultRef: "payload-permanent-result",
      }),
    ).rejects.toMatchObject({ code: "PORT_STALE_FENCE" });

    const permanentInput = {
      ownerId,
      agentId,
      threadId: source.thread.id,
      expectedThreadRevision: activeAgain.thread.revision,
      reasonCode: "owner_requested_permanent_delete",
      authorizationRef: "approval:permanent-delete",
      recentAuthenticationRef: "recent-auth:owner",
      idempotencyKey: "permanent-delete-source",
      resultRef: "payload-permanent-result",
    } as const;
    const pending = await coordinator.deletePermanently(permanentInput);
    expect(pending.thread.status).toBe("deletion_pending");
    await expect(coordinator.deletePermanently(permanentInput)).resolves.toEqual(pending);
    await repository.close();

    const deletion = new SqliteGovernedDeletionAdapter({
      stateRoot: resource.stateRoot,
      databasePath: resource.databasePath,
      ownerId,
      agentId,
      now: () => clock.now(),
    });
    await expect(
      deletion.deleteImmediately({ objectType: "thread", objectId: source.thread.id }),
    ).resolves.toMatchObject({ lifecycle: "deleted_verified" });

    const database = openQualifiedDatabase(resource.databasePath);
    expect(
      database.prepare("SELECT COUNT(*) FROM threads WHERE id = ?").pluck().get(source.thread.id),
    ).toBe(0);
    expect(
      database
        .prepare("SELECT thread_id FROM scheduled_jobs WHERE id = ?")
        .pluck()
        .get(pauseTask.id),
    ).toBeNull();
    expect(
      database
        .prepare("SELECT thread_id FROM scheduled_jobs WHERE id = ?")
        .pluck()
        .get(rebindTask.id),
    ).toBe(target.thread.id);
    expect(database.prepare("SELECT COUNT(*) FROM approval_requests").pluck().get()).toBe(0);
    expect(database.prepare("SELECT COUNT(*) FROM grants").pluck().get()).toBe(1);
    database.close();
  });
});
