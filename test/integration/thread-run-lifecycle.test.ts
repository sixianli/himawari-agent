import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
  type AgentRuntimePort,
  type ExecuteCoordinatedRunInput,
  type RunCompletionInput,
  type RunLifecyclePort,
} from "@himawari-agent/application";
import {
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
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
  SqliteGovernedDeletionAdapter,
} from "@himawari-agent/persistence-sqlite";
import {
  ManualClock,
  createReferenceAdapterSet,
  ScriptedAgentRuntime,
  ScriptedWorkerRunPort,
} from "@himawari-agent/testing";
import { afterEach, expect, it, vi } from "vitest";

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
  await mkdir(path.join(stateRoot, "data"));
  const databasePath = path.join(stateRoot, "data", "product.sqlite");
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

async function executionFixture() {
  const setup = await fixture();
  const adapters = createReferenceAdapterSet({ clock });
  const protector = new EnvelopePayloadProtector({
    keys: new InMemoryDevelopmentSecretSource({ "completion-key@v1": new Uint8Array(32).fill(17) }),
    activeKey: { keyRef: "completion-key", kekVersion: "v1", dekVersion: "v1" },
  });
  const payloads = setup.repository.payloadStore(ownerId, agentId);
  await payloads.put(
    await protector.protect({
      ownerId,
      agentId,
      ref: "payload-final-answer",
      dataClassification: "private",
      contentType: "text/plain",
      createdAt: clock.now(),
      plaintext: new TextEncoder().encode("这是最终回答。\n无需 JSON 引号。"),
    }),
  );
  const trace = new SessionTraceRecorder({
    trace: setup.repository.traceStore(),
    payloads,
    protector,
    audit: setup.repository.auditLedger(),
    clock,
    ids: adapters.ids,
  });
  const runs = setup.repository.runLifecycle(ownerId, agentId, authority);
  const checkpoints = setup.repository.runCheckpointStore(ownerId, agentId, authority);
  const stored = await runs.readRun(setup.runId);
  if (!stored) throw new Error("Missing admitted Run");
  const input: ExecuteCoordinatedRunInput = {
    ownerId,
    agentId,
    runId: setup.runId,
    authority: lease,
    context: {
      ownerId,
      agentId,
      runId: setup.runId,
      sessionId: stored.run.sessionId,
      threadId: setup.admitted.thread.id,
      trigger: {
        id: stored.run.triggerId,
        sourceType: "user_message",
        payloadRef: "payload-run-lifecycle",
      },
      threadMessages: [],
      policies: [],
      memoryQueryRef: "payload-run-lifecycle",
      memoryQueryTerms: [],
      memoryLimit: 1,
      maxSelectedMemories: 0,
      maxMemoryClassification: "private",
      capabilities: [],
      correlationId: "completion-correlation",
      causationId: "completion-cause",
      parentEventId: null,
      actorId: "completion-test",
      dataClassification: "private",
    },
    runtime: {
      ownerId,
      agentId,
      runId: setup.runId,
      sessionId: stored.run.sessionId,
      threadId: setup.admitted.thread.id,
      modelRef: "deterministic-completion",
      systemInstructionRef: "payload-run-lifecycle",
      capabilityHandleRefs: [],
      budget: {},
      correlationId: "completion-correlation",
      dataClassification: "private",
    },
    workers: [],
    delegableCapabilityHandleRefs: [],
    delegableContextRefs: [],
    commands: {
      buildingContext: transition(setup.runId, "building_context", 1),
      running: transition(setup.runId, "running", 2),
      reconcilingExternalResult: transition(setup.runId, "reconciling_external_result", 3),
      completed: transition(setup.runId, "completed", 3),
      failed: transition(setup.runId, "failed", 3),
      cancelled: transition(setup.runId, "cancelled", 3),
    },
  };
  let attempts = 0;
  const runtime: AgentRuntimePort = {
    async *run() {
      attempts += 1;
      yield {
        type: "runtime.completed" as const,
        runId: setup.runId,
        occurredAt: clock.now(),
        output: { kind: "assistant-answer" as const, contentRef: "payload-final-answer" },
      };
    },
    async cancel() {},
  };
  const context = new ContextFormationService({ memory: adapters.memory, trace });
  const coordinator = new RunCoordinator({
    runs,
    checkpoints,
    context,
    runtime,
    workers: new ScriptedWorkerRunPort(),
    trace,
  });
  return {
    ...setup,
    runs,
    checkpoints,
    input,
    runtime,
    context,
    trace,
    coordinator,
    protector,
    attempts: () => attempts,
  };
}

it("commits one protected final assistant through the coordinator and reads it after reopen", async () => {
  const setup = await executionFixture();
  await expect(setup.coordinator.execute(setup.input)).resolves.toMatchObject({
    run: { run: { status: "completed" } },
  });
  await setup.coordinator.execute(setup.input);
  expect(setup.attempts()).toBe(1);
  await setup.repository.close();
  const reopened = await SqliteProductStateRepository.open({
    stateRoot: setup.stateRoot,
    databasePath: setup.databasePath,
    minimumFreeBytes: 0,
    now: () => clock.now(),
  });
  repositories.push(reopened);
  const messages = await reopened
    .threadRepository()
    .listMessages(ownerId, agentId, setup.admitted.thread.id, 0, 10);
  expect(messages.filter((message) => message.role === "agent")).toHaveLength(1);
  const answer = messages.find((message) => message.role === "agent");
  if (!answer) throw new Error("Missing assistant answer");
  const payload = await reopened.payloadStore(ownerId, agentId).get(answer.contentRef);
  if (!payload) throw new Error("Missing protected answer");
  expect(payload.contentType).toBe("text/plain");
  expect(
    new TextDecoder().decode(await setup.protector.unprotect({ ownerId, agentId, payload })),
  ).toBe("这是最终回答。\n无需 JSON 引号。");
  expect(answer.turnId).toBe(setup.admitted.message.turnId);
});

function completionInput(setup: Awaited<ReturnType<typeof executionFixture>>): RunCompletionInput {
  return {
    ...setup.input.commands.completed,
    ownerId,
    agentId,
    runId: setup.runId,
    authority: lease,
    expectedRevision: 3,
    dataClassification: "private",
    output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
  };
}

it.each([
  { objectType: "thread", shared: false },
  { objectType: "run", shared: false },
  { objectType: "thread", shared: true },
  { objectType: "run", shared: true },
] as const)(
  "removes settled completion projections on $objectType deletion while shared=$shared",
  async ({ objectType, shared }) => {
    const setup = await executionFixture();
    const crashing = new RunCoordinator({
      runs: {
        ...setup.runs,
        completeRun: async () => {
          throw new Error("crash-before-completion");
        },
      },
      checkpoints: setup.checkpoints,
      context: setup.context,
      runtime: setup.runtime,
      workers: new ScriptedWorkerRunPort(),
      trace: setup.trace,
    });
    await expect(crashing.execute(setup.input)).rejects.toThrow("crash-before-completion");
    expect((await setup.checkpoints.read(setup.runId))?.checkpoint).toMatchObject({
      phase: "runtime_settled",
      output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
    });
    if (shared) {
      const created = await setup.commands.create({
        ownerId,
        agentId,
        idempotencyKey: "retained-thread",
        resultRef: "payload-run-lifecycle",
      });
      await setup.commands.admitOwnerMessage({
        ownerId,
        agentId,
        threadId: created.thread.id,
        expectedThreadRevision: created.thread.revision,
        sessionId: createSessionId("retained-session"),
        idempotencyKey: "retained-answer",
        contentRef: "payload-final-answer",
        sourceProofRef: "proof:owner",
        dataClassification: "private",
        resultRef: "payload-run-lifecycle",
      });
    }
    const deletion = new SqliteGovernedDeletionAdapter({
      stateRoot: setup.stateRoot,
      databasePath: setup.databasePath,
      ownerId,
      agentId,
      now: () => clock.now(),
    });
    await setup.repository.close();
    const result = await deletion.deleteImmediately({
      objectType,
      objectId: objectType === "thread" ? setup.admitted.thread.id : setup.runId,
    });
    expect(result.lifecycle).toBe("deleted_verified");
    const database = openQualifiedDatabase(setup.databasePath);
    expect
      .soft(
        database
          .prepare("SELECT run_id FROM run_coordination_checkpoints WHERE run_id = ?")
          .get(setup.runId),
      )
      .toBeUndefined();
    const answer = database
      .prepare("SELECT ref FROM payloads WHERE ref = 'payload-final-answer'")
      .get();
    if (shared) expect.soft(answer).toBeDefined();
    else expect.soft(answer).toBeUndefined();
    database.close();
  },
);

async function runningFixture() {
  const setup = await executionFixture();
  await setup.runs.transitionRun(transition(setup.runId, "building_context", 1));
  await setup.runs.transitionRun(transition(setup.runId, "running", 2));
  return setup;
}

it("retains a Payload referenced only by a surviving completion checkpoint", async () => {
  const setup = await executionFixture();
  await setup.checkpoints.compareAndSet({
    runId: setup.runId,
    expectedRevision: null,
    checkpoint: {
      phase: "runtime_settled",
      contextRef: null,
      workerResults: {},
      runtimeEventCount: 1,
      lastTraceEventId: null,
      terminalStatus: "completed",
      output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
      diagnosticCode: null,
    },
  });
  await setup.repository.close();
  const deletion = new SqliteGovernedDeletionAdapter({
    stateRoot: setup.stateRoot,
    databasePath: setup.databasePath,
    ownerId,
    agentId,
    now: () => clock.now(),
  });
  await expect(
    deletion.deleteImmediately({ objectType: "payload", objectId: "payload-final-answer" }),
  ).rejects.toThrow("referenced Payload");
});

it.each(["before", "after"] as const)(
  "recovers a crash %s the assistant transaction without another model attempt",
  async (boundary) => {
    const setup = await executionFixture();
    const runs: RunLifecyclePort = {
      ...setup.runs,
      completeRun: async (input) => {
        if (boundary === "after") await setup.runs.completeRun(input);
        throw new Error(`crash-${boundary}-completion`);
      },
    };
    const crashing = new RunCoordinator({
      runs,
      checkpoints: setup.checkpoints,
      context: setup.context,
      runtime: setup.runtime,
      workers: new ScriptedWorkerRunPort(),
      trace: setup.trace,
    });
    await expect(crashing.execute(setup.input)).rejects.toThrow(`crash-${boundary}-completion`);
    expect((await setup.checkpoints.read(setup.runId))?.checkpoint).toMatchObject({
      phase: "runtime_settled",
      output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
    });
    await setup.repository.close();
    const reopened = await SqliteProductStateRepository.open({
      stateRoot: setup.stateRoot,
      databasePath: setup.databasePath,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    repositories.push(reopened);
    const resumed = new RunCoordinator({
      runs: reopened.runLifecycle(ownerId, agentId, authority),
      checkpoints: reopened.runCheckpointStore(ownerId, agentId, authority),
      context: setup.context,
      runtime: setup.runtime,
      workers: new ScriptedWorkerRunPort(),
      trace: setup.trace,
    });
    expect((await resumed.execute(setup.input)).run.run.status).toBe("completed");
    expect(setup.attempts()).toBe(1);
    expect(
      (
        await reopened
          .threadRepository()
          .listMessages(ownerId, agentId, setup.admitted.thread.id, 0, 10)
      ).filter((message) => message.role === "agent"),
    ).toHaveLength(1);
  },
);

it("replays completion receipts after outbox cleanup and rejects changed completion semantics", async () => {
  const setup = await runningFixture();
  const input = completionInput(setup);
  const receipt = await setup.runs.completeRun(input);
  const database = openQualifiedDatabase(setup.databasePath);
  database.prepare("DELETE FROM reliable_events WHERE topic = 'run.completed'").run();
  database.close();
  expect(await setup.runs.completeRun(input)).toEqual({ ...receipt, replayed: true });
  await expect(
    setup.runs.completeRun({ ...input, output: { kind: "no-answer" } }),
  ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
});

it("keeps completion atomic when its last reliable event insert fails", async () => {
  const setup = await runningFixture();
  const input = completionInput(setup);
  const identity = createHash("sha256")
    .update(JSON.stringify([ownerId, agentId, input.idempotencyKey]))
    .digest("hex");
  const database = openQualifiedDatabase(setup.databasePath);
  database
    .prepare(`INSERT INTO reliable_events (id, owner_id, agent_id, idempotency_key, topic,
    payload_ref, publication_state, occurred_at) VALUES (?, ?, ?, 'collision', 'collision',
    'payload-run-lifecycle', 'pending', ?)`)
    .run(`run-event:${identity}`, ownerId, agentId, clock.now());
  const beforeThread = database
    .prepare("SELECT revision FROM threads WHERE id = ?")
    .get(setup.admitted.thread.id);
  await expect(setup.runs.completeRun(input)).rejects.toThrow();
  expect(await setup.runs.readRun(setup.runId)).toMatchObject({
    revision: 3,
    run: { status: "running" },
  });
  expect(
    database.prepare("SELECT revision FROM threads WHERE id = ?").get(setup.admitted.thread.id),
  ).toEqual(beforeThread);
  expect(
    database.prepare("SELECT committed_at FROM turns WHERE run_id = ?").get(setup.runId),
  ).toEqual({ committed_at: null });
  expect(
    database
      .prepare("SELECT id FROM thread_messages WHERE run_id = ? AND role = 'agent'")
      .all(setup.runId),
  ).toEqual([]);
  expect(
    database.prepare("SELECT id FROM command_results WHERE idempotency_key IN (?, ?)").all(
      input.idempotencyKey,
      `runtime-assistant:${createHash("sha256")
        .update(
          JSON.stringify([
            "runtime-assistant",
            ownerId,
            agentId,
            setup.runId,
            input.idempotencyKey,
          ]),
        )
        .digest("hex")}`,
    ),
  ).toEqual([]);
  database.close();
});

it("allows a concurrent rename but refuses completion after Trash", async () => {
  const setup = await runningFixture();
  await setup.commands.rename({
    ownerId,
    agentId,
    threadId: setup.admitted.thread.id,
    expectedRevision: setup.admitted.thread.revision,
    titleRef: "payload-run-lifecycle",
    source: "owner",
    idempotencyKey: "completion-rename",
    resultRef: "payload-run-lifecycle",
  });
  await expect(setup.runs.completeRun(completionInput(setup))).resolves.toMatchObject({
    replayed: false,
  });
  const trashed = await runningFixture();
  const database = openQualifiedDatabase(trashed.databasePath);
  database
    .prepare("UPDATE threads SET status = 'trashed' WHERE id = ?")
    .run(trashed.admitted.thread.id);
  database.close();
  await expect(trashed.runs.completeRun(completionInput(trashed))).rejects.toThrow();
  expect((await trashed.runs.readRun(trashed.runId))?.run.status).toBe("running");
});

it("does not overwrite a completed checkpoint when cancellation arrives later", async () => {
  const setup = await executionFixture();
  await setup.coordinator.execute(setup.input);
  const checkpoint = await setup.checkpoints.read(setup.runId);
  expect(
    (
      await setup.coordinator.cancel({
        ownerId,
        agentId,
        runId: setup.runId,
        authority: lease,
        command: setup.input.commands.cancelled,
        reasonCode: "LATE_CANCEL",
      })
    ).run.status,
  ).toBe("completed");
  expect(await setup.checkpoints.read(setup.runId)).toEqual(checkpoint);
});

it("reconciles an old successful checkpoint without output without calling the model", async () => {
  const setup = await runningFixture();
  await setup.checkpoints.compareAndSet({
    runId: setup.runId,
    expectedRevision: null,
    checkpoint: {
      phase: "runtime_settled",
      contextRef: "payload-run-lifecycle",
      workerResults: {},
      runtimeEventCount: 1,
      lastTraceEventId: null,
      terminalStatus: "completed",
      output: null,
      diagnosticCode: null,
    },
  });
  const result = await setup.coordinator.execute(setup.input);
  expect(result.run.run.status).toBe("reconciling_external_result");
  expect(result.checkpoint.diagnosticCode).toBe("RUNTIME_COMPLETION_OUTPUT_MISSING");
  expect(setup.attempts()).toBe(0);
});

it.each(["no-answer", "empty-ref"] as const)(
  "fails a Thread runtime with invalid successful output: %s",
  async (kind) => {
    const setup = await executionFixture();
    const runtime = new ScriptedAgentRuntime(
      () => clock.now(),
      [
        {
          type: "runtime.completed",
          runId: setup.runId,
          occurredAt: clock.now(),
          output:
            kind === "no-answer"
              ? { kind: "no-answer" }
              : { kind: "assistant-answer", contentRef: "" },
        },
      ],
    );
    const coordinator = new RunCoordinator({
      runs: setup.runs,
      checkpoints: setup.checkpoints,
      context: setup.context,
      runtime,
      workers: new ScriptedWorkerRunPort(),
      trace: setup.trace,
    });
    const result = await coordinator.execute(setup.input);
    expect(result.run.run.status).toBe("failed");
    expect(result.checkpoint.diagnosticCode).toBe("RUNTIME_FINAL_ANSWER_INVALID");
  },
);

it("rejects completion scope, stale fences, stale CAS, and insufficient final Payload classification", async () => {
  const setup = await runningFixture();
  const input = completionInput(setup);
  await expect(
    setup.runs.completeRun({ ...input, ownerId: createOwnerId("other-owner") }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  await expect(
    setup.runs.completeRun({ ...input, authority: { ...lease, fencingToken: 2 } }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  await expect(setup.runs.completeRun({ ...input, expectedRevision: 2 })).rejects.toMatchObject({
    code: "PORT_CONFLICT",
  });
  await expect(
    setup.runs.completeRun({ ...input, dataClassification: "sensitive" }),
  ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
  await expect(
    setup.runs.completeRun({
      ...input,
      output: { kind: "assistant-answer", contentRef: "missing-answer" },
    }),
  ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
  const database = openQualifiedDatabase(setup.databasePath);
  database
    .prepare("UPDATE payloads SET classification = 'public' WHERE ref = 'payload-final-answer'")
    .run();
  database.close();
  await expect(setup.runs.completeRun(input)).rejects.toMatchObject({
    code: "PORT_INVALID_OPERATION",
  });
  await setup.repository.authorityLeasePort(clock).release(lease.leaseId);
  await expect(setup.runs.completeRun(input)).rejects.toMatchObject({
    code: "PORT_NOT_AUTHORITATIVE",
  });
  expect((await setup.runs.readRun(setup.runId))?.run.status).toBe("running");
});

it("enforces typed checkpoint CAS, active Payload scope, Trace scope, and deployment fencing", async () => {
  const setup = await runningFixture();
  const checkpoint = {
    phase: "runtime_running" as const,
    contextRef: "payload-run-lifecycle",
    workerResults: Object.fromEntries([["__proto__", "payload-run-lifecycle"]]),
    runtimeEventCount: 0,
    lastTraceEventId: null,
    terminalStatus: null,
    output: null,
    diagnosticCode: null,
  };
  const saved = await setup.checkpoints.compareAndSet({
    runId: setup.runId,
    expectedRevision: null,
    checkpoint,
  });
  expect(saved.revision).toBe(1);
  expect(Object.hasOwn(saved.checkpoint.workerResults, "__proto__")).toBe(true);
  expect(saved.checkpoint.workerResults["__proto__"]).toBe("payload-run-lifecycle");
  await expect(
    setup.checkpoints.compareAndSet({
      runId: setup.runId,
      expectedRevision: null,
      checkpoint,
    }),
  ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
  await expect(
    setup.repository
      .runCheckpointStore(createOwnerId("owner-other"), agentId, authority)
      .read(setup.runId),
  ).resolves.toBeUndefined();
  await expect(
    setup.checkpoints.compareAndSet({
      runId: setup.runId,
      expectedRevision: 1,
      checkpoint: { ...checkpoint, lastTraceEventId: "trace-outside-run" },
    }),
  ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
  const database = openQualifiedDatabase(setup.databasePath);
  database
    .prepare("UPDATE payloads SET lifecycle_state = 'trashed' WHERE ref = ?")
    .run("payload-run-lifecycle");
  database.close();
  await expect(
    setup.checkpoints.compareAndSet({
      runId: setup.runId,
      expectedRevision: 1,
      checkpoint: { ...checkpoint, runtimeEventCount: 1 },
    }),
  ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
  const restoredDatabase = openQualifiedDatabase(setup.databasePath);
  restoredDatabase
    .prepare("UPDATE payloads SET lifecycle_state = 'active' WHERE ref = ?")
    .run("payload-run-lifecycle");
  restoredDatabase
    .prepare("UPDATE deployments SET fencing_token = 2 WHERE id = ?")
    .run(deploymentId);
  restoredDatabase.close();
  await expect(
    setup.checkpoints.compareAndSet({
      runId: setup.runId,
      expectedRevision: 1,
      checkpoint: { ...checkpoint, runtimeEventCount: 1 },
    }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
});

it("preserves completion and its receipt for an authorized replay after lease release", async () => {
  const setup = await runningFixture();
  const input = completionInput(setup);
  const receipt = await setup.runs.completeRun(input);
  await setup.repository.authorityLeasePort(clock).release(lease.leaseId);
  await expect(setup.runs.completeRun(input)).resolves.toEqual({ ...receipt, replayed: true });
});

it("rejects cross-scope cancellation before touching the runtime", async () => {
  const setup = await executionFixture();
  const cancel = vi.spyOn(setup.runtime, "cancel");
  await expect(
    setup.coordinator.cancel({
      ownerId: createOwnerId("other-owner"),
      agentId,
      runId: setup.runId,
      authority: lease,
      command: setup.input.commands.cancelled,
      reasonCode: "WRONG_SCOPE",
    }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  expect(cancel).not.toHaveBeenCalled();
  await expect(
    setup.coordinator.cancel({
      ownerId,
      agentId,
      runId: setup.runId,
      authority: { ...lease, fencingToken: 2 },
      command: setup.input.commands.cancelled,
      reasonCode: "STALE_AUTHORITY",
    }),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  expect(cancel).not.toHaveBeenCalled();
  expect((await setup.runs.readRun(setup.runId))?.run.status).toBe("accepted");
});

it("keeps cancellation authoritative when successful runtime output races with it", async () => {
  const setup = await executionFixture();
  const runtime: AgentRuntimePort = {
    async *run() {
      await setup.runs.transitionRun(transition(setup.runId, "cancelled", 3));
      yield {
        type: "runtime.completed",
        runId: setup.runId,
        occurredAt: clock.now(),
        output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
      };
    },
    async cancel() {},
  };
  const coordinator = new RunCoordinator({
    runs: setup.runs,
    checkpoints: setup.checkpoints,
    context: setup.context,
    runtime,
    workers: new ScriptedWorkerRunPort(),
    trace: setup.trace,
  });
  const result = await coordinator.execute(setup.input);
  expect(result.run.run.status).toBe("cancelled");
  expect(result.checkpoint).toMatchObject({
    phase: "cancelled",
    terminalStatus: "cancelled",
    output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
  });
  expect(
    (
      await setup.repository
        .threadRepository()
        .listMessages(ownerId, agentId, setup.admitted.thread.id, 0, 10)
    ).filter((message) => message.role === "agent"),
  ).toHaveLength(0);
});

it("retains observed output through cancellation until governed Run deletion", async () => {
  const setup = await executionFixture();
  const crashing = new RunCoordinator({
    runs: {
      ...setup.runs,
      completeRun: async () => {
        throw new Error("crash-before-completion");
      },
    },
    checkpoints: setup.checkpoints,
    context: setup.context,
    runtime: setup.runtime,
    workers: new ScriptedWorkerRunPort(),
    trace: setup.trace,
  });
  await expect(crashing.execute(setup.input)).rejects.toThrow("crash-before-completion");

  const workerPayload = await setup.protector.protect({
    ownerId,
    agentId,
    ref: "payload-cancelled-worker-only",
    dataClassification: "private",
    contentType: "text/plain",
    createdAt: clock.now(),
    plaintext: new TextEncoder().encode("worker result"),
  });
  await setup.repository.payloadStore(ownerId, agentId).put(workerPayload);

  const cancelled = await setup.coordinator.cancel({
    ownerId,
    agentId,
    runId: setup.runId,
    authority: lease,
    command: setup.input.commands.cancelled,
    reasonCode: "OWNER_CANCELLED",
  });
  expect(cancelled.run.status).toBe("cancelled");
  const cancelledCheckpoint = await setup.checkpoints.read(setup.runId);
  expect(cancelledCheckpoint?.checkpoint).toMatchObject({
    phase: "cancelled",
    terminalStatus: "cancelled",
    output: { kind: "assistant-answer", contentRef: "payload-final-answer" },
  });
  if (!cancelledCheckpoint) throw new Error("Missing cancelled checkpoint");

  await setup.checkpoints.compareAndSet({
    runId: setup.runId,
    expectedRevision: cancelledCheckpoint.revision,
    checkpoint: {
      ...cancelledCheckpoint.checkpoint,
      workerResults: Object.fromEntries([["__proto__", "payload-cancelled-worker-only"]]),
    },
  });
  expect(
    (
      await setup.repository
        .threadRepository()
        .listMessages(ownerId, agentId, setup.admitted.thread.id, 0, 10)
    ).filter((message) => message.role === "agent"),
  ).toHaveLength(0);

  const deletion = new SqliteGovernedDeletionAdapter({
    stateRoot: setup.stateRoot,
    databasePath: setup.databasePath,
    ownerId,
    agentId,
    now: () => clock.now(),
  });
  await setup.repository.close();
  const result = await deletion.deleteImmediately({ objectType: "run", objectId: setup.runId });
  expect(result.lifecycle).toBe("deleted_verified");
  const database = openQualifiedDatabase(setup.databasePath);
  expect(
    database
      .prepare("SELECT run_id FROM run_coordination_checkpoints WHERE run_id = ?")
      .get(setup.runId),
  ).toBeUndefined();
  expect(
    database
      .prepare("SELECT ref FROM payloads WHERE ref IN (?, ?)")
      .all("payload-final-answer", "payload-cancelled-worker-only"),
  ).toEqual([]);
  database.close();
});

it.each(["no-answer", "assistant-answer"] as const)(
  "completes a non-Thread Run with explicit %s output",
  async (kind) => {
    const setup = await executionFixture();
    const runId = createRunId(`background-${kind}`);
    const database = openQualifiedDatabase(setup.databasePath);
    database
      .prepare(`INSERT INTO triggers (id, owner_id, agent_id, idempotency_key, source_type,
    source_id, payload_ref, source_proof_ref, occurred_at) VALUES (?, ?, ?, ?, 'schedule',
    'schedule-test', 'payload-run-lifecycle', 'proof:schedule', ?)`)
      .run(`trigger-${kind}`, ownerId, agentId, `trigger-${kind}`, clock.now());
    database
      .prepare(`INSERT INTO runs (id, owner_id, agent_id, session_id, trigger_id, revision,
    status, created_at, updated_at) VALUES (?, ?, ?, 'background-session', ?, 3, 'running', ?, ?)`)
      .run(runId, ownerId, agentId, `trigger-${kind}`, clock.now(), clock.now());
    database.close();
    await expect(
      setup.runs.completeRun({
        ...completionInput(setup),
        runId,
        output:
          kind === "no-answer"
            ? { kind: "no-answer" }
            : { kind: "assistant-answer", contentRef: "payload-final-answer" },
      }),
    ).resolves.toMatchObject({ replayed: false });
    expect((await setup.runs.readRun(runId))?.run.status).toBe("completed");
    expect(
      (
        await setup.repository
          .threadRepository()
          .listMessages(ownerId, agentId, setup.admitted.thread.id, 0, 10)
      ).filter((message) => message.role === "agent"),
    ).toHaveLength(0);
  },
);

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
  const checkpoints = repository.runCheckpointStore(ownerId, agentId, authority);
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
  await expect(checkpoints.read(runId)).resolves.toMatchObject({
    checkpoint: { phase: "cancelled", terminalStatus: "cancelled" },
  });
  await expect(repository.read(`run:${runId}`)).resolves.toBeUndefined();
});
