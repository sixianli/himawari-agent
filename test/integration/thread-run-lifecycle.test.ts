import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ContextFormationService,
  RunCoordinator,
  RunStateCommitCoordinator,
  SessionTraceRecorder,
  ThreadCommandService,
  type TransitionRunStateInput,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createIdempotencyKey,
  createOwnerId,
  createRunId,
  createSessionId,
  type ProductAuthorityFence,
  type RunId,
} from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  ManualClock,
  createReferenceAdapterSet,
  ScriptedAgentRuntime,
  ScriptedWorkerRunPort,
} from "@himawari-agent/testing";
import { afterEach, expect, it } from "vitest";

const ownerId = createOwnerId("owner-run-lifecycle");
const agentId = createAgentId("agent-run-lifecycle");
const deploymentId = createDeploymentId("deployment-run-lifecycle");
const authority: ProductAuthorityFence = { deploymentId, authorityEpoch: 1, fencingToken: 1 };
const lease = { leaseId: createAuthorityLeaseId("lease-run-lifecycle"), fencingToken: 1 };
const roots: string[] = [];
const repositories: SqliteProductStateRepository[] = [];
const clock = new ManualClock("2026-09-04T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-thread-run-"));
  roots.push(stateRoot);
  const databasePath = path.join(stateRoot, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(ownerId);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(agentId, ownerId);
  database
    .prepare(`INSERT INTO deployments
    (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
    VALUES (?, ?, ?, 0, 'active', 1, 1)`)
    .run(deploymentId, ownerId, agentId);
  database
    .prepare(`INSERT INTO payloads
    (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
      content_digest, lifecycle_state, created_at)
    VALUES ('payload-run-lifecycle', ?, ?, 'private', 'sqlite_blob', X'00',
      'sha256:fixture', 'active', ?)`)
    .run(ownerId, agentId, clock.now());
  database
    .prepare(`INSERT INTO authority_leases
    (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch, fencing_token, acquired_at, expires_at)
    VALUES (?, ?, ?, ?, 'holder-run-lifecycle', 1, 1, ?, '2026-09-05T00:00:00.000Z')`)
    .run(lease.leaseId, ownerId, agentId, deploymentId, clock.now());
  database.close();
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => clock.now(),
  });
  repositories.push(repository);
  const commands = new ThreadCommandService({
    repository: repository.threadRepository(),
    clock,
    authority: () => authority,
  });
  const created = await commands.create({
    ownerId,
    agentId,
    idempotencyKey: "thread-create",
    resultRef: "payload-run-lifecycle",
  });
  const admitted = await commands.admitOwnerMessage({
    ownerId,
    agentId,
    threadId: created.thread.id,
    expectedThreadRevision: created.thread.revision,
    sessionId: createSessionId("session-run-lifecycle"),
    idempotencyKey: "thread-submit",
    contentRef: "payload-run-lifecycle",
    sourceProofRef: "proof:owner",
    dataClassification: "private",
    resultRef: "payload-run-lifecycle",
  });
  const runId = admitted.message.runId;
  if (!runId) throw new Error("Thread admission did not create a Run");
  return { repository, commands, admitted, runId, stateRoot, databasePath };
}

it("makes an admitted Thread Run visible to the production Run lifecycle", async () => {
  const { repository, runId } = await fixture();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  await expect(runs.readRun(runId)).resolves.toMatchObject({
    revision: 1,
    run: { id: runId, ownerId, agentId, status: "accepted" },
  });
  await expect(
    new RunStateCommitCoordinator(repository, clock).readRun(runId),
  ).resolves.toBeUndefined();
});

function transition(
  runId: RunId,
  nextStatus: TransitionRunStateInput["nextStatus"],
  expectedRevision: number,
  key = nextStatus,
): TransitionRunStateInput {
  return {
    ownerId,
    agentId,
    runId,
    nextStatus,
    expectedRevision,
    idempotencyKey: createIdempotencyKey(`transition-${key}`),
    commandFingerprint: `transition:${key}`,
    authority: lease,
    payloadRef: "payload-run-lifecycle",
  };
}

it("transitions the relational Run with durable receipts/events and idempotent replay after reopen", async () => {
  const { repository, runId, databasePath, stateRoot } = await fixture();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  const input = transition(runId, "building_context", 1);
  const result = await runs.transitionRun(input);
  expect(result).toMatchObject({ replayed: false, commandResult: { stateRevision: 2 } });
  await expect(runs.transitionRun(input)).resolves.toEqual({ ...result, replayed: true });
  await runs.transitionRun(transition(runId, "running", 2));
  await repository.close();
  const reopened = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => clock.now(),
  });
  repositories.push(reopened);
  const recovered = reopened.runLifecycle(ownerId, agentId, authority);
  await expect(recovered.readRun(runId)).resolves.toMatchObject({
    revision: 3,
    run: { status: "running" },
  });
  await expect(recovered.transitionRun(input)).resolves.toEqual({ ...result, replayed: true });
  expect(
    (await reopened.listPending(100)).filter((event) => event.topic.startsWith("run.")),
  ).toHaveLength(2);
  await expect(reopened.read(`run:${runId}`)).resolves.toBeUndefined();
});

it("rejects stale CAS, illegal transitions and mutated replay semantics without additional events", async () => {
  const { repository, runId } = await fixture();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  const input = transition(runId, "building_context", 1);
  await expect(runs.transitionRun(transition(runId, "running", 1))).rejects.toMatchObject({
    code: "PORT_INVALID_OPERATION",
  });
  await runs.transitionRun(input);
  await expect(runs.transitionRun(transition(runId, "running", 1))).rejects.toMatchObject({
    code: "PORT_CONFLICT",
  });
  await expect(runs.transitionRun({ ...input, nextStatus: "running" })).rejects.toMatchObject({
    code: "PORT_CONFLICT",
  });
  await expect(
    runs.transitionRun({ ...input, payloadRef: "different-payload" }),
  ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
  expect(
    (await repository.listPending(100)).filter((event) => event.topic.startsWith("run.")),
  ).toHaveLength(1);
});

it("fails closed on cross-scope reads, commands and deployment or lease fences", async () => {
  const { repository, runId } = await fixture();
  const otherOwner = createOwnerId("owner-other");
  await expect(
    repository.runLifecycle(otherOwner, agentId, authority).readRun(runId),
  ).resolves.toBeUndefined();
  await expect(
    repository.runLifecycle(ownerId, createAgentId("agent-other"), authority).readRun(runId),
  ).resolves.toBeUndefined();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  const input = transition(runId, "building_context", 1);
  await expect(runs.transitionRun({ ...input, ownerId: otherOwner })).rejects.toMatchObject({
    code: "PORT_NOT_AUTHORITATIVE",
  });
  await expect(
    runs.transitionRun({ ...input, authority: { ...lease, fencingToken: 2 } }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  await expect(
    repository
      .runLifecycle(ownerId, agentId, { ...authority, authorityEpoch: 2 })
      .transitionRun(input),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  await repository.authorityLeasePort(clock).release(lease.leaseId);
  await expect(runs.transitionRun(input)).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  await expect(runs.readRun(runId)).resolves.toMatchObject({ revision: 1 });
});

it("replays a committed receipt after authority release without allowing a new transition", async () => {
  const { repository, runId } = await fixture();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  const input = transition(runId, "building_context", 1);
  const result = await runs.transitionRun(input);
  await repository.authorityLeasePort(clock).release(lease.leaseId);
  await expect(runs.transitionRun(input)).resolves.toEqual({ ...result, replayed: true });
  await expect(runs.transitionRun(transition(runId, "running", 2))).rejects.toMatchObject({
    code: "PORT_NOT_AUTHORITATIVE",
  });
});

it("reserves Thread completion for atomic assistant/Turn/Run commit", async () => {
  const { repository, runId, commands, admitted } = await fixture();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  await runs.transitionRun(transition(runId, "building_context", 1));
  await runs.transitionRun(transition(runId, "running", 2));
  await expect(runs.transitionRun(transition(runId, "completed", 3))).rejects.toThrow(
    "atomic assistant commit",
  );
  await expect(runs.readRun(runId)).resolves.toMatchObject({
    revision: 3,
    run: { status: "running" },
  });
  const turnId = admitted.message.turnId;
  if (!turnId) throw new Error("Missing admitted Turn");
  const input = {
    ownerId,
    agentId,
    threadId: admitted.thread.id,
    expectedThreadRevision: admitted.thread.revision,
    turnId,
    runId,
    idempotencyKey: "assistant-commit",
    contentRef: "payload-run-lifecycle",
    dataClassification: "private",
    resultRef: "payload-run-lifecycle",
  } as const;
  await commands.commitAssistantMessage(input);
  await commands.commitAssistantMessage(input);
  await expect(runs.readRun(runId)).resolves.toMatchObject({
    revision: 4,
    run: { status: "completed" },
  });
  const messages = await repository
    .threadRepository()
    .listMessages(ownerId, agentId, admitted.thread.id, 0, 10);
  expect(messages.filter((message) => message.role === "agent")).toHaveLength(1);
  await expect(runs.transitionRun(transition(runId, "failed", 4))).rejects.toMatchObject({
    code: "PORT_INVALID_OPERATION",
  });
});

it.each(["failed", "cancelled"] as const)(
  "persists %s without fabricating an assistant",
  async (nextStatus) => {
    const { repository, runId, admitted } = await fixture();
    const runs = repository.runLifecycle(ownerId, agentId, authority);
    await runs.transitionRun(transition(runId, nextStatus, 1));
    await expect(runs.readRun(runId)).resolves.toMatchObject({
      revision: 2,
      run: { status: nextStatus },
    });
    const messages = await repository
      .threadRepository()
      .listMessages(ownerId, agentId, admitted.thread.id, 0, 10);
    expect(messages.map((message) => message.role)).toEqual(["owner"]);
  },
);

it("rolls back Run and receipt when the reliable event insert fails", async () => {
  const { repository, runId, databasePath } = await fixture();
  const input = transition(runId, "building_context", 1);
  const identity = createHash("sha256")
    .update(JSON.stringify([ownerId, agentId, input.idempotencyKey]))
    .digest("hex");
  const database = openQualifiedDatabase(databasePath);
  database
    .prepare(`INSERT INTO reliable_events
    (id, owner_id, agent_id, idempotency_key, topic, payload_ref, publication_state, occurred_at)
    VALUES (?, ?, ?, 'conflicting-event', 'fixture', 'payload-run-lifecycle', 'pending', ?)`)
    .run(`run-event:${identity}`, ownerId, agentId, clock.now());
  database.close();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  await expect(runs.transitionRun(input)).rejects.toThrow();
  await expect(runs.readRun(runId)).resolves.toMatchObject({
    revision: 1,
    run: { status: "accepted" },
  });
  await expect(repository.findCommandResult(input)).resolves.toBeUndefined();
});

it.each(["session_id", "trigger_id"])(
  "does not expose a Run whose %s breaks relational admission scope",
  async (column) => {
    const { repository, runId, databasePath } = await fixture();
    const database = openQualifiedDatabase(databasePath);
    if (column === "session_id")
      database.prepare("UPDATE runs SET session_id = 'session-other' WHERE id = ?").run(runId);
    else {
      database
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('agent-other', ?, 0)")
        .run(ownerId);
      database
        .prepare(
          "UPDATE triggers SET agent_id = 'agent-other' WHERE id = (SELECT trigger_id FROM runs WHERE id = ?)",
        )
        .run(runId);
    }
    database.close();
    await expect(
      repository.runLifecycle(ownerId, agentId, authority).readRun(runId),
    ).resolves.toBeUndefined();
  },
);

it("accepts a Thread-bound Run from a trigger without a Thread before any Turn exists", async () => {
  const { repository, runId, databasePath } = await fixture();
  const database = openQualifiedDatabase(databasePath);
  database
    .prepare(
      "UPDATE triggers SET thread_id = NULL WHERE id = (SELECT trigger_id FROM runs WHERE id = ?)",
    )
    .run(runId);
  database.prepare("DELETE FROM thread_messages WHERE run_id = ?").run(runId);
  database.prepare("DELETE FROM turns WHERE run_id = ?").run(runId);
  database.close();
  await expect(
    repository.runLifecycle(ownerId, agentId, authority).readRun(runId),
  ).resolves.toMatchObject({ revision: 1 });
});

it("replays durable transition receipts independently of outbox retention", async () => {
  const { repository, runId, databasePath } = await fixture();
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  const input = transition(runId, "building_context", 1);
  const result = await runs.transitionRun(input);
  const database = openQualifiedDatabase(databasePath);
  database.prepare("DELETE FROM reliable_events WHERE topic = 'run.building_context'").run();
  database.close();
  await expect(runs.transitionRun(input)).resolves.toEqual({ ...result, replayed: true });
});

it("prevents creating a second product-state truth for an admitted relational Run", async () => {
  const { repository, runId } = await fixture();
  const stored = await repository.runLifecycle(ownerId, agentId, authority).readRun(runId);
  if (!stored) throw new Error("Missing relational Run");
  const legacy = new RunStateCommitCoordinator(repository, clock);
  await expect(
    legacy.admitRun({
      run: stored.run,
      authority: lease,
      idempotencyKey: createIdempotencyKey("legacy-duplicate"),
      commandFingerprint: "legacy-duplicate",
      payloadRef: "payload-run-lifecycle",
    }),
  ).rejects.toThrow("cannot also be stored");
  await expect(legacy.readRun(runId)).resolves.toBeUndefined();
});

it("rejects Thread admission when the requested Run already belongs to product state", async () => {
  const { repository, runId, commands, admitted } = await fixture();
  const stored = await repository.runLifecycle(ownerId, agentId, authority).readRun(runId);
  if (!stored) throw new Error("Missing relational Run");
  const duplicateId = createRunId("run-existing-reference");
  await new RunStateCommitCoordinator(repository, clock).admitRun({
    run: { ...stored.run, id: duplicateId },
    authority: lease,
    idempotencyKey: createIdempotencyKey("existing-reference"),
    commandFingerprint: "existing-reference",
    payloadRef: "payload-run-lifecycle",
  });
  await expect(
    commands.admitOwnerMessage({
      ownerId,
      agentId,
      runId: duplicateId,
      threadId: admitted.thread.id,
      expectedThreadRevision: admitted.thread.revision,
      sessionId: stored.run.sessionId,
      idempotencyKey: "duplicate-thread-submit",
      contentRef: "payload-run-lifecycle",
      sourceProofRef: "proof:owner",
      dataClassification: "private",
      resultRef: "payload-run-lifecycle",
    }),
  ).rejects.toThrow("cannot duplicate a product-state Run");
  await expect(
    repository.runLifecycle(ownerId, agentId, authority).readRun(duplicateId),
  ).resolves.toBeUndefined();
});

it("lets the existing RunCoordinator cancel the admitted relational Run with a durable checkpoint", async () => {
  const { repository, runId } = await fixture();
  const adapters = createReferenceAdapterSet({ clock });
  const trace = new SessionTraceRecorder({
    trace: adapters.trace,
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    audit: adapters.audit,
    clock,
    ids: adapters.ids,
  });
  const runs = repository.runLifecycle(ownerId, agentId, authority);
  const checkpoints = repository.authoritativeRunCheckpointStore(ownerId, agentId, authority);
  const coordinator = new RunCoordinator({
    runs,
    checkpoints,
    context: new ContextFormationService({ memory: adapters.memory, trace }),
    runtime: new ScriptedAgentRuntime(() => clock.now(), []),
    workers: new ScriptedWorkerRunPort(),
    trace,
  });
  const command = transition(runId, "cancelled", 1);
  await expect(
    coordinator.cancel({
      ownerId,
      agentId,
      runId,
      authority: lease,
      command,
      reasonCode: "OWNER_CANCELLED",
    }),
  ).resolves.toMatchObject({ run: { status: "cancelled" }, revision: 2 });
  await expect(checkpoints.read(`run-checkpoint:${runId}`)).resolves.toMatchObject({
    value: { phase: "cancelled", terminalStatus: "cancelled" },
  });
  await expect(repository.read(`run:${runId}`)).resolves.toBeUndefined();
});
