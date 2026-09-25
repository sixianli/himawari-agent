import path from "node:path";
import type { RunExecutionLeaseClaim } from "@himawari-agent/application";
import {
  type ExecutionBackendPort,
  type ExecutionEnvironmentStorePort,
  type SandboxWorkspaceClaim,
  TaskEnvironmentCoordinator,
} from "@himawari-agent/application";
import {
  type ExecutionEnvelope,
  type ExecutionEnvironmentLocator,
  type ExecutionEnvironmentStopProof,
  STOP_PROOF_COVERAGE,
  TASK_ENVIRONMENT_GUARANTEES,
} from "@himawari-agent/execution-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createIdempotencyKey } from "@himawari-agent/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_ID,
  invocation,
  OWNER_ID,
  openSandboxJournal,
  operationsForDatabase,
  RUN_ID,
  SERVICE_AUTHORITY,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const RUN_B = "run-environment-b";
const HOST = "environment-host";
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}
const later = (ms: number) => new Date(Date.parse(T1) + ms).toISOString();
const root = (canonicalRootId: string, inode: number, access: "read" | "write") =>
  ({
    ref: `lease:${canonicalRootId}:${access}`,
    hostId: HOST,
    canonicalRootId,
    access,
    lineage: [
      { device: "1", inode: "1" },
      { device: "1", inode: String(inode) },
    ],
  }) satisfies SandboxWorkspaceClaim;
const file = (lease: SandboxWorkspaceClaim, name: string, inode: number) =>
  ({
    ...lease,
    ref: `call:${lease.canonicalRootId}:${name}`,
    file: { name, identity: { device: "1", inode: String(inode) }, atomicPublish: false },
  }) satisfies SandboxWorkspaceClaim;
const source = {
  authorizationRef: "grant-environment",
  decidedBy: "user",
  delegationListRef: null,
  expiresAt: T2,
} as const;
const envelope = (...leases: SandboxWorkspaceClaim[]): ExecutionEnvelope => ({
  schemaVersion: "execution-envelope.v1",
  directories: leases.map((lease) => ({
    hostId: lease.hostId,
    grantRef: `grant-${lease.canonicalRootId}`,
    canonicalRootId: lease.canonicalRootId,
    access: lease.access,
    source,
  })),
  network: [],
  resources: {
    cpuMillicores: 1000,
    memoryBytes: 536870912,
    maxProcesses: 128,
    privateStorageBytes: 268435456,
  },
});
const digests = {
  policyDigest: "a".repeat(64),
  imageDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64),
};

class FakeBackend implements ExecutionBackendPort {
  readonly calls: string[] = [];
  readonly created = new Map<string, ExecutionEnvironmentLocator>();
  readonly stopped = new Set<string>();
  createMode: "created" | "response_lost" | "rejected" = "created";
  verifyMode: "proof" | "unconfirmed" = "proof";
  guarantees: readonly string[] = TASK_ENVIRONMENT_GUARANTEES;
  unavailable = false;
  inspectUnavailable = false;
  now = T1;
  async capabilities() {
    this.calls.push("capabilities");
    if (this.unavailable) throw new Error("daemon unavailable");
    return {
      protocolVersion: "execution-backend.v1" as const,
      backendRef: "fake-container",
      runtimeInstanceId: "fake-runtime",
      guarantees: this.guarantees as typeof TASK_ENVIRONMENT_GUARANTEES,
      checkedAt: this.now,
    };
  }
  async create(input: Parameters<ExecutionBackendPort["create"]>[0]) {
    this.calls.push(`create:${input.createIntentId}`);
    if (this.createMode === "rejected") throw new Error("image missing");
    const locator = {
      backendRef: "fake-container",
      runtimeInstanceId: "fake-runtime",
      runtimeEnvironmentId: `runtime-${input.identity.environmentId}`,
      createIntentId: input.createIntentId,
      effectivePolicyDigest: input.policyDigest,
    };
    this.created.set(input.createIntentId, locator);
    if (this.createMode === "response_lost") throw new Error("socket closed");
    return locator;
  }
  async execute(): Promise<never> {
    throw new Error("execute is not part of P1");
  }
  async inspect(input: Parameters<ExecutionBackendPort["inspect"]>[0]) {
    this.calls.push(`inspect:${input.createIntentId}`);
    if (this.inspectUnavailable) throw new Error("daemon connection lost");
    const locator = this.created.get(input.createIntentId) ?? null;
    return {
      state: !locator
        ? ("not_found" as const)
        : this.stopped.has(input.createIntentId)
          ? ("stopped" as const)
          : ("running" as const),
      locator,
      observedAt: this.now,
    };
  }
  async stop(input: Parameters<ExecutionBackendPort["stop"]>[0]) {
    this.calls.push(`stop:${input.createIntentId}`);
    this.stopped.add(input.createIntentId);
    return { accepted: true as const };
  }
  async verifyStopped(
    input: Parameters<ExecutionBackendPort["verifyStopped"]>[0],
  ): Promise<ExecutionEnvironmentStopProof> {
    this.calls.push(`verify:${input.createIntentId}`);
    if (this.verifyMode === "unconfirmed") throw new Error("inspect timed out");
    const locator = this.created.get(input.createIntentId);
    const common = {
      identity: input.identity,
      createIntentId: input.createIntentId,
      stopIntentId: input.stopIntentId,
      stopFence: input.stopFence,
      verifierRef: "fake-verifier",
      checkedAt: this.now,
      validUntil: new Date(Date.parse(this.now) + 300_000).toISOString(),
      evidence: [{ ref: `evidence-${input.stopIntentId}`, digest: "d".repeat(64) }],
    };
    if (!locator) return { basis: "never_created", ...common };
    if (!this.stopped.has(input.createIntentId)) throw new Error("still running");
    return { basis: "verified_stopped", ...common, locator, coverage: [...STOP_PROOF_COVERAGE] };
  }
  async destroy() {}
}

async function openFixture() {
  const journal = await openSandboxJournal(true);
  const database = journal.database;
  database
    .prepare(
      `INSERT INTO triggers (id, owner_id, agent_id, thread_id, idempotency_key, source_type,
        source_id, payload_ref, source_proof_ref, occurred_at)
       VALUES ('trigger-environment-b', ?, ?, 'thread-capability-invocation', 'trigger-environment-b',
        'user_message', 'fixture-source', 'payload-capability-invocation-trigger', 'fixture-proof', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T1);
  database
    .prepare(
      `INSERT INTO runs (id, owner_id, agent_id, thread_id, session_id, trigger_id, revision, status, created_at, updated_at)
       VALUES (?, ?, ?, 'thread-capability-invocation', 'session-environment-b', 'trigger-environment-b', 0, 'running', ?, ?)`,
    )
    .run(RUN_B, OWNER_ID, AGENT_ID, T1, T1);
  const second = invocation({
    receiptRef: "receipt-environment-second",
    invocationId: "invocation-environment-second",
    idempotencyKey: "idempotency-environment-second",
  });
  operationsForDatabase(database).execute("capabilityInvocation.consume", {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    input: second,
  });
  database.prepare("UPDATE runs SET revision=1 WHERE id=?").run(RUN_ID);
  database.close();
  let repository = await SqliteProductStateRepository.open({
    stateRoot: journal.resource.stateRoot,
    minimumFreeBytes: 0,
    now: () => T1,
  });
  const backend = new FakeBackend();
  let now = T1;
  let counter = 0;
  const coordinatorFor = (store: ExecutionEnvironmentStorePort) =>
    new TaskEnvironmentCoordinator({
      store,
      backend,
      ids: { next: (prefix) => `${prefix}-${++counter}` },
      clock: { now: () => now },
      authority: () => SERVICE_AUTHORITY,
    });
  let store = repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  let coordinator = coordinatorFor(store);
  let repositoryOpen = true;
  return {
    backend,
    receipts: [
      {
        invocationId: "invocation-capability-invocation",
        receiptRef: "receipt-capability-invocation",
      },
      { invocationId: "invocation-environment-second", receiptRef: "receipt-environment-second" },
    ] as const,
    get store() {
      return store;
    },
    completeRun: () =>
      repository.runLifecycle(OWNER_ID, AGENT_ID, SERVICE_AUTHORITY.product).completeRun({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        expectedRevision: 1,
        idempotencyKey: createIdempotencyKey("environment-run-completion"),
        commandFingerprint: "environment-run-completion",
        authority: SERVICE_AUTHORITY.lease,
        executionLease: journal.plan.executionLease as RunExecutionLeaseClaim,
        payloadRef: "payload-capability-invocation-trigger",
        output: { kind: "no-answer" },
        dataClassification: "private",
      }),
    get coordinator() {
      return coordinator;
    },
    setNow(value: string) {
      now = value;
      backend.now = value;
    },
    databasePath: path.join(journal.resource.stateRoot, "product.sqlite"),
    reopen: async () => {
      await repository.close();
      repository = await SqliteProductStateRepository.open({
        stateRoot: journal.resource.stateRoot,
        minimumFreeBytes: 0,
        now: () => now,
      });
      store = repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
      coordinator = coordinatorFor(store);
    },
    closeRepository: async () => {
      if (repositoryOpen) await repository.close();
      repositoryOpen = false;
    },
    close: async () => {
      if (repositoryOpen) await repository.close();
      repositoryOpen = false;
      await journal.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof openFixture>>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await openFixture();
  cleanups.push(f.close);
  return f;
}
const authorized = { authority: SERVICE_AUTHORITY, now: T1 };
const acquire = (f: Fixture, runId: string, ...leases: SandboxWorkspaceClaim[]) =>
  f.coordinator.acquire({
    runId,
    hostId: HOST,
    envelope: envelope(...leases),
    leases,
    ...digests,
    deadlineAt: T2,
  });
const reason = (code: string) =>
  expect.objectContaining({ details: expect.objectContaining({ reasonCode: code }) });
const failure = (code: string) => expect.objectContaining({ code });

describe("task execution environment protocol on real SQLite", () => {
  it("shares one environment across calls of one Run while each call keeps its own receipt", async () => {
    const f = await fixture();
    const lease = root("root-a", 10, "write");
    const first = await acquire(f, RUN_ID, lease);
    const again = await acquire(f, RUN_ID, lease);
    expect(again.identity).toEqual(first.identity);
    expect(first.identity).toMatchObject({
      runId: RUN_ID,
      environmentGeneration: 1,
      role: "primary",
    });
    expect(first.state).toBe("ready");
    expect(f.backend.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    for (const [index, receipt] of f.receipts.entries()) {
      const linked = await f.store.linkCall({
        ...authorized,
        environmentId: first.identity.environmentId,
        expectedStopFence: 0,
        ...receipt,
        claims: [file(lease, `file-${index}.txt`, 100 + index)],
      });
      expect(linked.applied).toBe(true);
    }
    const replay = await f.store.linkCall({
      ...authorized,
      environmentId: first.identity.environmentId,
      expectedStopFence: 0,
      ...f.receipts[0],
      claims: [file(lease, "file-0.txt", 100)],
    });
    expect(replay.applied).toBe(false);
    await expect(
      f.store.linkCall({
        ...authorized,
        environmentId: first.identity.environmentId,
        expectedStopFence: 0,
        invocationId: "invocation-reusing-receipt",
        receiptRef: f.receipts[0].receiptRef,
        claims: [],
      }),
    ).rejects.toEqual(reason("EXECUTION_BINDING_CHANGED"));
    await f.reopen();
    const run = await f.store.readRun(RUN_ID);
    expect(run?.environments).toHaveLength(1);
    expect(run?.environments[0]).toMatchObject({ state: "running", identity: first.identity });
    expect(run?.environments[0]?.calls.map((call) => call.receiptRef)).toEqual(
      f.receipts.map((receipt) => receipt.receiptRef),
    );
    expect(new Set(run?.environments[0]?.calls.map((call) => call.invocationId)).size).toBe(2);
  });

  it("never lets another Run use or overlap a task environment", async () => {
    const f = await fixture();
    const a = await acquire(f, RUN_ID, root("root-a", 10, "write"));
    await expect(acquire(f, RUN_B, root("root-a", 10, "read"))).rejects.toEqual(
      reason("WORKSPACE_OCCUPIED"),
    );
    expect((await f.store.readRun(RUN_B))?.environments ?? []).toEqual([]);
    const b = await acquire(f, RUN_B, root("root-b", 20, "write"));
    expect(b.identity.executionJobId).not.toBe(a.identity.executionJobId);
    expect(b.identity.environmentId).not.toBe(a.identity.environmentId);
    await expect(
      f.store.linkCall({
        ...authorized,
        environmentId: b.identity.environmentId,
        expectedStopFence: 0,
        ...f.receipts[0],
        claims: [],
      }),
    ).rejects.toEqual(reason("EXECUTION_BINDING_CHANGED"));
  });

  it("keeps the environment lease after a call ends and serializes overlapping calls inside it", async () => {
    const f = await fixture();
    const lease = root("root-a", 10, "write");
    const env = await acquire(f, RUN_ID, lease);
    const link = (index: number, claim: SandboxWorkspaceClaim) =>
      f.store.linkCall({
        ...authorized,
        environmentId: env.identity.environmentId,
        expectedStopFence: 0,
        ...present(f.receipts[index]),
        claims: [claim],
      });
    await link(0, file(lease, "shared.txt", 100));
    await expect(link(1, file(lease, "shared.txt", 100))).rejects.toEqual(
      reason("WORKSPACE_OCCUPIED"),
    );
    await expect(link(1, file(root("root-b", 20, "write"), "outside.txt", 200))).rejects.toEqual(
      reason("EXECUTION_ENVELOPE_EXCEEDED"),
    );
    await f.store.completeCall({
      ...authorized,
      environmentId: env.identity.environmentId,
      invocationId: f.receipts[0].invocationId,
    });
    expect((await link(1, file(lease, "shared.txt", 100))).applied).toBe(true);
    await expect(acquire(f, RUN_B, root("root-a", 10, "read"))).rejects.toEqual(
      reason("WORKSPACE_OCCUPIED"),
    );
    const current = await f.store.read(env.identity.environmentId);
    expect(current?.leases).toEqual([lease]);
  });

  it("keeps the lease and never recreates after a lost create response", async () => {
    const f = await fixture();
    f.backend.createMode = "response_lost";
    f.backend.inspectUnavailable = true;
    await expect(acquire(f, RUN_ID, root("root-a", 10, "write"))).rejects.toEqual(
      failure("EXECUTION_ENVIRONMENT_UNKNOWN"),
    );
    f.backend.createMode = "created";
    await expect(acquire(f, RUN_ID, root("root-a", 10, "write"))).rejects.toEqual(
      failure("EXECUTION_ENVIRONMENT_UNKNOWN"),
    );
    expect(f.backend.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    const unknown = present((await f.store.readRun(RUN_ID))?.environments[0]);
    expect(unknown).toMatchObject({ state: "unknown", locator: null, releaseReceipt: null });
    await expect(acquire(f, RUN_B, root("root-a", 10, "read"))).rejects.toEqual(
      reason("WORKSPACE_OCCUPIED"),
    );
    await f.reopen();
    f.backend.inspectUnavailable = false;
    const resolved = await f.coordinator.resolveUnknown(unknown.identity.environmentId);
    expect(resolved).toMatchObject({ state: "ready", identity: unknown.identity });
    expect(resolved.locator?.createIntentId).toBe(unknown.createIntentId);
    expect(f.backend.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
  });

  it("releases a create that never happened only after fencing late creation", async () => {
    const f = await fixture();
    f.backend.createMode = "rejected";
    await expect(acquire(f, RUN_ID, root("root-a", 10, "write"))).rejects.toEqual(
      failure("EXECUTION_ENVIRONMENT_CREATE_FAILED"),
    );
    const failed = present((await f.store.readRun(RUN_ID))?.environments[0]);
    expect(failed).toMatchObject({
      state: "released",
      stopFence: 1,
      stopIntent: { reason: "failure" },
      releaseReceipt: { basis: "never_created", stopFence: 1 },
    });
    await expect(
      f.store.recordCreated({
        ...authorized,
        environmentId: failed.identity.environmentId,
        locator: {
          backendRef: "fake-container",
          runtimeInstanceId: "fake-runtime",
          runtimeEnvironmentId: "late-runtime",
          createIntentId: failed.createIntentId,
          effectivePolicyDigest: digests.policyDigest,
        },
      }),
    ).rejects.toEqual(reason("EXECUTION_BINDING_CHANGED"));
    f.backend.createMode = "created";
    const next = await acquire(f, RUN_ID, root("root-a", 10, "write"));
    expect(next.identity).toMatchObject({
      environmentGeneration: 2,
      executionJobId: failed.identity.executionJobId,
    });
    expect(next.rotationReason).toBe("failure");
  });

  it("records a late create after stop without ever making it executable", async () => {
    const f = await fixture();
    const lease = root("root-a", 10, "write");
    const { record } = await f.store.reserve({
      ...authorized,
      runId: RUN_ID,
      hostId: HOST,
      role: "primary",
      rotationReason: "initial",
      backendRef: "fake-container",
      envelope: envelope(lease),
      ...digests,
      deadlineAt: T2,
      leases: [lease],
      ids: {
        executionJobId: "job-late",
        environmentId: "environment-late",
        createIntentId: "create-late",
      },
    });
    await f.store.beginCreate({ ...authorized, environmentId: record.identity.environmentId });
    await f.store.requestStop({
      ...authorized,
      environmentId: record.identity.environmentId,
      stopIntentId: "stop-late",
      reason: "run_cancelled",
      stoppedResourceRefs: [],
    });
    const locator = await f.backend.create({
      identity: record.identity,
      createIntentId: record.createIntentId,
      envelope: record.envelope,
      ...digests,
      deadlineAt: T2,
    });
    const late = await f.store.recordCreated({
      ...authorized,
      environmentId: record.identity.environmentId,
      locator,
    });
    expect(late).toMatchObject({ executable: false, record: { state: "stop_requested", locator } });
    await expect(
      f.store.linkCall({
        ...authorized,
        environmentId: record.identity.environmentId,
        expectedStopFence: 0,
        ...f.receipts[0],
        claims: [],
      }),
    ).rejects.toEqual(reason("EXECUTION_BINDING_CHANGED"));
    const released = await f.coordinator.stop({
      environmentId: record.identity.environmentId,
      reason: "run_cancelled",
      stoppedResourceRefs: [],
    });
    expect(f.backend.calls).toContain(`stop:${record.createIntentId}`);
    expect(released).toMatchObject({
      state: "released",
      releaseReceipt: { basis: "verified_stopped", stopFence: 1 },
    });
  });

  it("fences concurrent stop requests exactly once", async () => {
    const f = await fixture();
    const env = await acquire(f, RUN_ID, root("root-a", 10, "write"));
    const results = await Promise.all(
      ["stop-one", "stop-two"].map((stopIntentId) =>
        f.store.requestStop({
          ...authorized,
          environmentId: env.identity.environmentId,
          stopIntentId,
          reason: "run_finished",
          stoppedResourceRefs: ["resource-watcher"],
        }),
      ),
    );
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    const current = await f.store.read(env.identity.environmentId);
    expect(current).toMatchObject({ state: "stop_requested", stopFence: 1 });
    expect(current?.stopIntent?.stoppedResourceRefs).toEqual(["resource-watcher"]);
    await expect(
      f.store.linkCall({
        ...authorized,
        environmentId: env.identity.environmentId,
        expectedStopFence: 0,
        ...f.receipts[0],
        claims: [],
      }),
    ).rejects.toEqual(reason("EXECUTION_BINDING_CHANGED"));
    await expect(
      f.store.requestStop({
        ...authorized,
        authority: {
          ...SERVICE_AUTHORITY,
          product: { ...SERVICE_AUTHORITY.product, fencingToken: 2 },
        },
        environmentId: env.identity.environmentId,
        stopIntentId: "stop-stale-authority",
        reason: "run_finished",
        stoppedResourceRefs: [],
      }),
    ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  });

  it("hands over to the next environment only after the previous stop proof is accepted", async () => {
    const f = await fixture();
    const lease = root("root-a", 10, "write");
    const first = await acquire(f, RUN_ID, lease);
    const reserveNext = () =>
      f.store.reserve({
        ...authorized,
        runId: RUN_ID,
        hostId: HOST,
        role: "primary",
        rotationReason: "expansion",
        backendRef: "fake-container",
        envelope: envelope(lease),
        ...digests,
        deadlineAt: T2,
        leases: [lease],
        ids: {
          executionJobId: "unused-job",
          environmentId: "environment-next",
          createIntentId: "create-next",
        },
      });
    const blocked = await reserveNext();
    expect(blocked).toMatchObject({ applied: false, record: { identity: first.identity } });
    f.backend.verifyMode = "unconfirmed";
    await expect(
      f.coordinator.stop({
        environmentId: first.identity.environmentId,
        reason: "expansion",
        stoppedResourceRefs: ["resource-watcher"],
      }),
    ).rejects.toEqual(failure("EXECUTION_STOP_UNCONFIRMED"));
    expect(await reserveNext()).toMatchObject({
      applied: false,
      record: { identity: first.identity },
    });
    await expect(acquire(f, RUN_B, root("root-a", 10, "read"))).rejects.toEqual(
      reason("WORKSPACE_OCCUPIED"),
    );
    f.backend.verifyMode = "proof";
    await f.coordinator.stop({
      environmentId: first.identity.environmentId,
      reason: "expansion",
      stoppedResourceRefs: ["resource-watcher"],
    });
    const next = await reserveNext();
    expect(next).toMatchObject({
      applied: true,
      record: {
        state: "reserved",
        rotationReason: "expansion",
        identity: {
          environmentGeneration: 2,
          executionJobId: first.identity.executionJobId,
          environmentId: "environment-next",
        },
      },
    });
    expect(
      (await f.store.read(first.identity.environmentId))?.stopIntent?.stoppedResourceRefs,
    ).toEqual(["resource-watcher"]);
  });

  it("keeps an accepted release immutable across late acknowledgements and proof expiry", async () => {
    const f = await fixture();
    const env = await acquire(f, RUN_ID, root("root-a", 10, "write"));
    await f.store.requestStop({
      ...authorized,
      environmentId: env.identity.environmentId,
      stopIntentId: "stop-final",
      reason: "run_finished",
      stoppedResourceRefs: [],
    });
    await f.backend.stop({
      identity: env.identity,
      createIntentId: env.createIntentId,
      locator: env.locator,
      stopIntentId: "stop-final",
      stopFence: 1,
    });
    const request = {
      identity: env.identity,
      createIntentId: env.createIntentId,
      locator: env.locator,
      stopIntentId: "stop-final",
      stopFence: 1,
    };
    const proof = await f.backend.verifyStopped(request);
    for (const wrong of [
      { ...proof, stopFence: 2 },
      { ...proof, stopIntentId: "stop-other" },
      { ...proof, identity: { ...proof.identity, environmentGeneration: 2 } },
      proof.basis === "verified_stopped"
        ? { ...proof, locator: { ...proof.locator, runtimeEnvironmentId: "other-runtime" } }
        : proof,
    ])
      await expect(
        f.store.acceptRelease({
          ...authorized,
          environmentId: env.identity.environmentId,
          proof: wrong,
        }),
      ).rejects.toEqual(reason("EXECUTION_BINDING_CHANGED"));
    await expect(
      f.store.acceptRelease({
        ...authorized,
        now: proof.validUntil,
        environmentId: env.identity.environmentId,
        proof,
      }),
    ).rejects.toEqual(reason("EXECUTION_STOP_UNCONFIRMED"));
    const accepted = await f.store.acceptRelease({
      ...authorized,
      environmentId: env.identity.environmentId,
      proof,
    });
    expect(accepted).toMatchObject({ applied: true, record: { state: "released" } });
    expect(await acquire(f, RUN_B, root("root-a", 10, "write"))).toMatchObject({ state: "ready" });
    f.setNow(later(3_600_000));
    for (let attempt = 0; attempt < 2; attempt += 1)
      await f.store.acknowledgeStop({
        authority: SERVICE_AUTHORITY,
        now: later(3_600_000),
        environmentId: env.identity.environmentId,
        stopIntentId: "stop-final",
      });
    f.backend.now = later(3_600_000);
    const retry = await f.store.acceptRelease({
      authority: SERVICE_AUTHORITY,
      now: later(3_600_000),
      environmentId: env.identity.environmentId,
      proof: await f.backend.verifyStopped(request),
    });
    expect(retry.applied).toBe(false);
    const after = await f.store.read(env.identity.environmentId);
    expect(after).toMatchObject({
      state: "released",
      releaseReceipt: { basis: "verified_stopped", acceptedAt: T1, proof },
    });
    expect(after?.stopIntent?.acknowledgedAt).toBe(later(3_600_000));
  });

  it("rejects backends that are unavailable or lack a required guarantee before reserving anything", async () => {
    const f = await fixture();
    f.backend.unavailable = true;
    await expect(acquire(f, RUN_ID, root("root-a", 10, "write"))).rejects.toEqual(
      failure("EXECUTION_BACKEND_UNAVAILABLE"),
    );
    f.backend.unavailable = false;
    f.backend.guarantees = TASK_ENVIRONMENT_GUARANTEES.slice(1);
    await expect(acquire(f, RUN_ID, root("root-a", 10, "write"))).rejects.toEqual(
      failure("EXECUTION_POLICY_UNSUPPORTED"),
    );
    f.backend.guarantees = [...TASK_ENVIRONMENT_GUARANTEES, "future-guarantee.v1"];
    await expect(acquire(f, RUN_ID, root("root-a", 10, "write"))).rejects.toEqual(
      failure("EXECUTION_POLICY_UNSUPPORTED"),
    );
    expect(await f.store.readRun(RUN_ID)).toBeUndefined();
    expect(f.backend.calls.some((call) => call.startsWith("create:"))).toBe(false);
  });

  it("prevents writers that do not know the environment contract from releasing its lease", async () => {
    const f = await fixture();
    const env = await acquire(f, RUN_ID, root("root-a", 10, "write"));
    await f.closeRepository();
    const database = openQualifiedDatabase(f.databasePath);
    try {
      expect(() =>
        database
          .prepare("UPDATE execution_environment_leases SET released_at=? WHERE environment_id=?")
          .run(T1, env.identity.environmentId),
      ).toThrow(/release receipt/);
      expect(() =>
        database
          .prepare("UPDATE execution_environments SET locator_json=NULL WHERE environment_id=?")
          .run(env.identity.environmentId),
      ).toThrow(/immutable/);
      const migrations = await loadBundledMigrations();
      expect(() => applyMigrations(database, migrations.slice(0, -1))).toThrow(/unknown migration/);
    } finally {
      database.close();
    }
  });

  it("keeps the Run from completing until its primary and network helper environments are released", async () => {
    const f = await fixture();
    const primary = await acquire(f, RUN_ID, root("root-a", 10, "write"));
    const helper = await f.store.reserve({
      ...authorized,
      runId: RUN_ID,
      hostId: HOST,
      role: "network_helper",
      rotationReason: "initial",
      backendRef: "fake-container",
      envelope: envelope(),
      ...digests,
      deadlineAt: T2,
      leases: [],
      ids: {
        executionJobId: "unused-job",
        environmentId: "environment-helper",
        createIntentId: "create-helper",
      },
    });
    expect(helper.record.identity).toMatchObject({
      role: "network_helper",
      executionJobId: primary.identity.executionJobId,
    });
    const blocked = {
      code: "PORT_CONFLICT",
      message: "Run still owns unreleased sandbox resources",
    };
    await expect(f.completeRun()).rejects.toMatchObject(blocked);
    await f.coordinator.stop({
      environmentId: primary.identity.environmentId,
      reason: "run_finished",
      stoppedResourceRefs: [],
    });
    await expect(f.completeRun()).rejects.toMatchObject(blocked);
    await f.coordinator.stop({
      environmentId: helper.record.identity.environmentId,
      reason: "run_finished",
      stoppedResourceRefs: [],
    });
    await expect(f.completeRun()).rejects.toMatchObject({
      code: "PORT_INVALID_OPERATION",
      message: "Thread completion requires an assistant answer",
    });
  });
});
