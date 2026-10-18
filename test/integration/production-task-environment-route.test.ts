import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ExecutionEnvironmentLifecyclePort,
  RemoteExecutionBackend,
  TaskEnvironmentCoordinator,
  taskEnvironmentCallEvidence,
  ThreadCommandService,
} from "@himawari-agent/application";
import {
  createAuthorityLeaseId,
  createDeploymentId,
  createIdempotencyKey,
  createRunExecutionLeaseId,
  createRunId,
  createSessionId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  type ExecutionEnvironmentLocator,
  type ExecutionEnvironmentStopProof,
  PI_FIXED_FILE_CONTRACT,
  PI_PREPARED_FILE_CONTRACT,
  PI_RUNNER_CONTRACT,
  PI_WRITE_VERIFIER,
  type SandboxOperationBinding,
  STOP_PROOF_COVERAGE,
  TASK_ENVIRONMENT_GUARANTEES,
} from "@himawari-agent/execution-contracts";
import { containerRunnerDigest } from "@himawari-agent/runtime-sandbox";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import type { SandboxContainerRoute } from "../../apps/execution-worker/src/production-sandbox-execution-v2.ts";
import { SqliteExecutionContext } from "../../packages/persistence-sqlite/src/sqlite-execution-context.ts";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import { queuedLiveWorker } from "../fixtures/queued-live-worker.ts";
import {
  AGENT_ID,
  OWNER_ID,
  RUN_ID,
  SERVICE_AUTHORITY,
  serviceRequest,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const BACKEND = "container-test";
const IMAGE_DIGEST = "b".repeat(64);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const read: SandboxOperationBinding = {
  operation: "read",
  mode: "foreground",
  contract: { kind: "fixed_read", ...PI_RUNNER_CONTRACT },
  backendRef: BACKEND,
  scopeSource: "grant_targets",
  directoryOperations: ["read"],
  network: "disabled",
};

const preparedWrite: SandboxOperationBinding = {
  operation: "write",
  mode: "foreground",
  contract: {
    ...PI_PREPARED_FILE_CONTRACT,
    kind: "verified_effect",
    verifierRef: PI_WRITE_VERIFIER.ref,
    verifierVersion: PI_WRITE_VERIFIER.version,
    targetRef: PI_WRITE_VERIFIER.targetRef,
  },
  backendRef: BACKEND,
  scopeSource: "grant_targets",
  directoryOperations: ["read", "create", "update"],
  network: "disabled",
};
const writeOptions = {
  realFileIdentity: true,
  piParameters: { path: "file.txt", content: "candidate" },
  directoryOperations: ["read", "create", "update"] as const,
  resourceCeiling: {
    maxWallTimeMs: 10000,
    maxCpuTimeMs: 10000,
    maxMemoryBytes: 268435456,
    maxOutputBytes: 65536,
    maxProgressEvents: 10,
  },
};

class Lifecycle implements ExecutionEnvironmentLifecyclePort {
  readonly calls: string[] = [];
  readonly created = new Map<string, ExecutionEnvironmentLocator>();
  readonly stopped = new Set<string>();
  readonly requests: Parameters<ExecutionEnvironmentLifecyclePort["create"]>[0][] = [];
  async capabilities() {
    this.calls.push("capabilities");
    return {
      protocolVersion: "execution-backend.v1" as const,
      backendRef: BACKEND,
      runtimeInstanceId: "daemon-test",
      guarantees: TASK_ENVIRONMENT_GUARANTEES,
      checkedAt: T1,
    };
  }
  async create(input: Parameters<ExecutionEnvironmentLifecyclePort["create"]>[0]) {
    this.calls.push("create");
    this.requests.push(input);
    const locator = {
      backendRef: BACKEND,
      runtimeInstanceId: "daemon-test",
      runtimeEnvironmentId: hash(input.identity.environmentId),
      createIntentId: input.createIntentId,
      effectivePolicyDigest: input.policyDigest,
    };
    this.created.set(input.createIntentId, locator);
    return locator;
  }
  async inspect(input: Parameters<ExecutionEnvironmentLifecyclePort["inspect"]>[0]) {
    this.calls.push("inspect");
    const locator = this.created.get(input.createIntentId) ?? null;
    return {
      state: !locator
        ? ("not_found" as const)
        : this.stopped.has(input.createIntentId)
          ? ("stopped" as const)
          : ("running" as const),
      locator,
      observedAt: T1,
    };
  }
  unreachableStops = 0;
  async stop(input: Parameters<ExecutionEnvironmentLifecyclePort["stop"]>[0]) {
    this.calls.push("stop");
    if (this.unreachableStops > 0) {
      this.unreachableStops -= 1;
      throw new Error("worker unreachable");
    }
    this.stopped.add(input.createIntentId);
    return { accepted: true as const };
  }
  async verifyStopped(
    input: Parameters<ExecutionEnvironmentLifecyclePort["verifyStopped"]>[0],
  ): Promise<ExecutionEnvironmentStopProof> {
    this.calls.push("verifyStopped");
    const locator = this.created.get(input.createIntentId);
    if (!locator || !this.stopped.has(input.createIntentId)) throw new Error("still running");
    const checkedAt = T1;
    return {
      basis: "verified_stopped",
      identity: input.identity,
      createIntentId: input.createIntentId,
      stopIntentId: input.stopIntentId,
      stopFence: input.stopFence,
      verifierRef: "lifecycle-test",
      checkedAt,
      validUntil: new Date(Date.parse(checkedAt) + 300_000).toISOString(),
      evidence: [{ ref: `stopped-${input.stopIntentId}`, digest: "d".repeat(64) }],
      locator,
      coverage: [...STOP_PROOF_COVERAGE],
    };
  }
  async destroy() {}
}

async function setup(
  outcome: "returned" | "lost" | "closed" = "returned",
  binding: SandboxOperationBinding = read,
  options: Omit<Parameters<typeof productionSandboxScope>[2] & object, "taskEnvironments"> = {
    piParameters: { path: "notes.txt" },
    directoryOperations: ["read"],
  },
  beforePrepare: (workspace: string) => Promise<void> = async () => {},
  beforeCommit: (workspace: string) => Promise<void> = async () => {},
) {
  const lifecycle = new Lifecycle();
  const remote = {
    worker: undefined as undefined | Awaited<ReturnType<typeof queuedLiveWorker>>["worker"],
  };
  let sequence = 0;
  const environments = new RemoteExecutionBackend({
    backendRef: BACKEND,
    transport: {
      request: (message) => {
        if (!remote.worker) throw new Error("worker not connected");
        return remote.worker.request(message);
      },
      events: (cursor) => {
        if (!remote.worker) throw new Error("worker not connected");
        return remote.worker.events(cursor);
      },
    },
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    authority: () => SERVICE_AUTHORITY.product,
    nextId: (scope) => `${scope}-${++sequence}`,
    now: () => T1,
    requestTimeoutMs: 60_000,
    resultTimeoutMs: 5_000,
    pollIntervalMs: 5,
  });
  const f = await productionSandboxScope(binding, undefined, {
    ...options,
    profileRef: "authorized-project.v1",
    taskEnvironments: {
      backendRef: BACKEND,
      imageDigest: IMAGE_DIGEST,
      lifecycle: environments,
    },
  });
  cleanups.push(f.close);
  await beforePrepare(f.host.workspace);
  const executed: Parameters<SandboxContainerRoute["execute"]>[0][] = [];
  const published: Omit<Parameters<SandboxContainerRoute["publish"]>[0], "commit">[] = [];
  const containers: SandboxContainerRoute = {
    backendRef: BACKEND,
    execute: async (input) => {
      executed.push(input);
      if (outcome === "lost") throw new Error("exec response lost");
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode('{"schemaVersion":"pi-result.v1","content":"notes"}'),
        truncated: false,
      };
    },
    publish: async ({ commit, ...input }) => {
      published.push(input);
      if (outcome === "closed") throw new Error("CONTAINER_EXECUTION_CLOSED");
      await beforeCommit(f.host.workspace);
      const committed = await commit();
      if (outcome === "lost") throw new Error("publication response lost");
      return committed;
    },
  };
  const live = await queuedLiveWorker(f, SERVICE_AUTHORITY, undefined, {
    containers,
    backendRef: BACKEND,
    environments: lifecycle,
    clock: { now: () => T1 },
  });
  cleanups.push(live.close);
  remote.worker = live.worker;
  const dispatch = async (plan: Awaited<ReturnType<typeof prepare>>["plan"]) => {
    const base = serviceRequest();
    return live.sandbox.execute({
      ...base,
      messageId: plan.identity.invocationId,
      authorizationRef: plan.authorizationRef,
      scope: f.input.requestScope,
      payload: {
        ...base.payload,
        capabilityId: plan.capabilityRef,
        capabilityVersion: plan.capabilityVersion,
        capabilityHandleRef: plan.handleRef,
        inputRef: plan.inputRef,
        operation: plan.operation,
        requestedAt: f.input.requestedAt,
        deadlineAt: plan.effectiveDeadlineAt,
        resourceCeiling: plan.resourceCeiling,
        delegatedContextRefs: f.input.delegatedContextRefs,
        secretRefs: f.input.secretRefs,
        sandboxExecution: {
          schemaVersion: "sandbox-execution.v2",
          mode: plan.mode,
          environmentId: plan.environmentId,
          identity: plan.identity,
        },
      },
    });
  };
  const prepare = async () => {
    const prepared = await f.services.runtime.prepare(f.input, f.call);
    if (!("reservation" in prepared)) throw new Error("expected a sandbox-execution.v2 admission");
    return prepared;
  };
  return { f, lifecycle, executed, published, live, prepare, dispatch };
}

it("runs a container tool call inside the Run's task environment and releases it when the Run finishes", async () => {
  const { f, lifecycle, executed, prepare, dispatch } = await setup();
  const prepared = await prepare();
  const store = f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const run = await store.readRun(RUN_ID);
  const [environment] = run?.environments ?? [];
  const snapshot = JSON.parse(await readFile(f.capabilityDeployment.snapshotPath, "utf8"));
  expect(run?.environments).toHaveLength(1);
  expect(environment).toMatchObject({
    state: "ready",
    backendRef: BACKEND,
    imageDigest: IMAGE_DIGEST,
    runnerDigest: containerRunnerDigest(snapshot.capabilities[0].binding.value.runtimeDigest),
  });
  const environmentId = environment?.identity.environmentId ?? "";
  expect(prepared.plan.environmentId).toBe(`environment:${hash(f.input.invocationId)}`);
  expect(environmentId).not.toBe(prepared.plan.environmentId);
  expect(prepared.plan.backendRef).toBe(BACKEND);
  expect(lifecycle.calls.filter((call) => call === "create")).toHaveLength(1);
  expect(lifecycle.requests[0]?.envelope.directories).toEqual([
    expect.objectContaining({
      canonicalRootId: prepared.workspaces[0]?.canonicalRootId,
      access: "read",
    }),
  ]);
  expect(
    (await f.services.brokerV2.preparations.reserve({ ...prepared, invocation: f.input })).applied,
  ).toBe(true);
  await dispatch(prepared.plan);
  expect(executed).toHaveLength(1);
  expect(executed[0]).toMatchObject({
    identity: environment?.identity,
    createIntentId: environment?.createIntentId,
    locator: environment?.locator,
    stopFence: 0,
    invocationId: prepared.plan.identity.invocationId,
  });
  const record = await f.repository
    .sandboxExecutionJournal(OWNER_ID, AGENT_ID)
    .read(prepared.plan.identity);
  expect(record?.facts.result).toMatchObject({ kind: "result" });
  expect(record?.facts.resource).toMatchObject({
    supervision: "released",
    evidence: {
      ...taskEnvironmentCallEvidence({
        environmentId,
        invocationId: prepared.plan.identity.invocationId,
        createIntentId: environment?.createIntentId ?? "",
        runtimeInstanceId: environment?.locator?.runtimeInstanceId ?? "",
        runtimeEnvironmentId: environment?.locator?.runtimeEnvironmentId ?? "",
      }),
      subject: { kind: "task_environment", environmentId },
    },
  });
  expect(record?.releaseReceipt).not.toBeNull();
  const linked = await store.read(environmentId);
  expect(linked?.calls).toEqual([
    expect.objectContaining({
      invocationId: prepared.plan.identity.invocationId,
      completedAt: expect.any(String),
    }),
  ]);
  expect(await f.services.resources.stopRun(RUN_ID, "run_finished")).toEqual({ released: true });
  const stopped = await store.read(environmentId);
  expect(stopped).toMatchObject({
    state: "released",
    stopIntent: { reason: "run_finished" },
    releaseReceipt: { basis: "verified_stopped" },
  });
  expect(lifecycle.calls.filter((call) => call === "stop")).toHaveLength(1);
});

it("stops the whole task environment when a container call's result is lost", async () => {
  const { f, lifecycle, prepare, dispatch } = await setup("lost");
  const prepared = await prepare();
  await f.services.brokerV2.preparations.reserve({ ...prepared, invocation: f.input });
  await dispatch(prepared.plan);
  const journal = f.repository.sandboxExecutionJournal(OWNER_ID, AGENT_ID);
  const lost = await journal.read(prepared.plan.identity);
  expect(lost?.facts.result).toMatchObject({ kind: "unknown" });
  expect(lost?.facts.resource.supervision).toBe("lost");
  const store = f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const environmentId =
    (await store.readRun(RUN_ID))?.environments[0]?.identity.environmentId ?? "";
  expect((await store.read(environmentId))?.state).toBe("running");
  expect(await f.services.resources.stopRun(RUN_ID, "run_cancelled")).toEqual({ released: true });
  expect(await store.read(environmentId)).toMatchObject({
    state: "released",
    stopIntent: { reason: "run_cancelled" },
  });
  const released = await journal.read(prepared.plan.identity);
  expect(released?.facts.resource.supervision).toBe("released");
  expect(released?.releaseReceipt).not.toBeNull();
  expect(lifecycle.calls.filter((call) => call === "stop")).toHaveLength(1);
});

function writeProductState(
  f: Awaited<ReturnType<typeof setup>>["f"],
  statement: string,
  ...parameters: string[]
) {
  const database = new Database(path.join(f.f.resource.stateRoot, "product.sqlite"));
  try {
    database.prepare(statement).run(...parameters);
  } finally {
    database.close();
  }
}
function readReservationRecovery(f: Awaited<ReturnType<typeof setup>>["f"], jobId: string) {
  const database = new Database(path.join(f.f.resource.stateRoot, "product.sqlite"), {
    readonly: true,
  });
  try {
    const row = database
      .prepare("SELECT recovery_json FROM sandbox_execution_records WHERE job_id=?")
      .get(jobId) as { recovery_json: string | null } | undefined;
    return row?.recovery_json ? JSON.parse(row.recovery_json) : undefined;
  } finally {
    database.close();
  }
}
const RESERVATION_RELEASE_CONFIRMED = {
  status: "resolved",
  reasonCode: "SANDBOX_RESERVATION_RELEASE_CONFIRMED",
} as const;
const settleRunCheckpoint = (f: Awaited<ReturnType<typeof setup>>["f"]) =>
  writeProductState(
    f,
    `INSERT INTO run_coordination_checkpoints
       (run_id, owner_id, agent_id, revision, phase, runtime_event_count, terminal_status, output_kind, updated_at)
     VALUES (?, ?, ?, 1, 'runtime_settled', 0, 'completed', 'no-answer', ?)
     ON CONFLICT(run_id) DO UPDATE SET phase='runtime_settled', terminal_status='completed',
       output_kind='no-answer', final_answer_ref=NULL`,
    RUN_ID,
    OWNER_ID,
    AGENT_ID,
    T1,
  );
const expireRunExecutionLease = (f: Awaited<ReturnType<typeof setup>>["f"]) =>
  writeProductState(
    f,
    "UPDATE run_execution_leases SET expires_at=? WHERE run_id=? AND released_at IS NULL",
    T1,
    RUN_ID,
  );

async function settledContainerCall() {
  const scope = await setup();
  const prepared = await scope.prepare();
  await scope.f.services.brokerV2.preparations.reserve({ ...prepared, invocation: scope.f.input });
  await scope.dispatch(prepared.plan);
  const record = await scope.f.repository
    .sandboxExecutionJournal(OWNER_ID, AGENT_ID)
    .read(prepared.plan.identity);
  expect(record?.facts.result).toMatchObject({ kind: "result" });
  const store = () => scope.f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const environmentId =
    (await store().readRun(RUN_ID))?.environments[0]?.identity.environmentId ?? "";
  const stops = () => scope.lifecycle.calls.filter((call) => call === "stop").length;
  const recover = () => scope.f.services.resources.recoverPending(new AbortController().signal, 10);
  return { ...scope, store, environmentId, stops, recover };
}

it("[R2-P2] keeps a running Run's leftover task environment for its next claim after the execution lease expires", async () => {
  const f = await settledContainerCall();
  await f.f.reopen();
  expireRunExecutionLease(f.f);
  await f.recover();
  expect((await f.store().read(f.environmentId))?.state).not.toBe("released");
  expect(f.stops()).toBe(0);
});

it("[R2-P2] stops a reconciling Run's leftover task environment after Agent restart once its execution lease expires", async () => {
  const f = await settledContainerCall();
  writeProductState(f.f, "UPDATE runs SET status='reconciling_external_result' WHERE id=?", RUN_ID);
  await f.f.reopen();
  await f.recover();
  expect((await f.store().read(f.environmentId))?.state).not.toBe("released");
  expect(f.stops()).toBe(0);

  expireRunExecutionLease(f.f);
  await f.recover();
  expect(await f.store().read(f.environmentId)).toMatchObject({
    state: "released",
    stopIntent: { reason: "supervision_lost" },
    releaseReceipt: { basis: "verified_stopped" },
  });
  await f.recover();
  expect(f.stops()).toBe(1);
  expect(f.executed).toHaveLength(1);
});

it("[R2-P2] keeps a leftover task environment while its Run waits for approval without a lease", async () => {
  const f = await settledContainerCall();
  await f.f.reopen();
  expireRunExecutionLease(f.f);
  writeProductState(f.f, "UPDATE runs SET status='awaiting_approval' WHERE id=?", RUN_ID);
  await f.recover();
  expect((await f.store().read(f.environmentId))?.state).not.toBe("released");
  expect(f.stops()).toBe(0);
});

it("[R2-P2] finishes an environment stop left unacknowledged before Agent restart and retries while the Worker is unreachable", async () => {
  const f = await settledContainerCall();
  f.lifecycle.unreachableStops = 2;
  expect(await f.f.services.resources.stopRun(RUN_ID, "run_finished")).toEqual({
    released: false,
  });
  const requested = await f.store().read(f.environmentId);
  expect(requested).toMatchObject({
    state: "stop_requested",
    stopIntent: { reason: "run_finished", acknowledgedAt: null },
  });
  settleRunCheckpoint(f.f);

  await f.f.reopen();
  expireRunExecutionLease(f.f);
  await f.recover();
  expect((await f.store().read(f.environmentId))?.state).toBe("stop_requested");
  await f.recover();
  expect(await f.store().read(f.environmentId)).toMatchObject({
    state: "released",
    stopIntent: {
      stopIntentId: requested?.stopIntent?.stopIntentId,
      reason: "run_finished",
    },
    releaseReceipt: { basis: "verified_stopped" },
  });
  expect(f.stops()).toBe(3);
  expect(f.executed).toHaveLength(1);
});

async function secondCall(f: Awaited<ReturnType<typeof setup>>["f"]) {
  const toolCallId = "tool-read-second";
  const invocationId = `runtime-tool:${hash([RUN_ID, toolCallId])}`;
  await f.persist(`runtime-tool-intent:${hash([RUN_ID, toolCallId])}`, {
    request: {
      schemaVersion: "execution.v2",
      kind: "request",
      type: "work.execute",
      messageId: invocationId,
      correlationId: `run:${RUN_ID}`,
      causationId: RUN_ID,
      dataClassification: f.input.dataClassification,
      risk: "high",
      authorizationRef: f.input.authorizationRef,
      scope: f.input.requestScope,
      idempotencyKey: invocationId,
      payload: {
        inputRef: f.input.inputRef,
        capabilityHandleRef: f.input.handleRef,
        capabilityId: f.input.capabilityRef,
        capabilityVersion: f.input.capabilityVersion,
        operation: f.input.operation,
        delegatedContextRefs: f.input.delegatedContextRefs,
        secretRefs: f.input.secretRefs,
        resourceCeiling: f.input.resourceCeiling,
        requestedAt: f.input.requestedAt,
        deadlineAt: f.input.deadlineAt,
      },
    },
  });
  return {
    input: {
      ...f.input,
      invocationId,
      idempotencyKey: invocationId,
      receiptRef: `${f.input.receiptRef}-second`,
    },
    call: { ...f.call, toolCallId },
  };
}

it("reuses the Run's task environment for a later container call", async () => {
  const { f, lifecycle, executed, prepare, dispatch } = await setup();
  const first = await prepare();
  await f.services.brokerV2.preparations.reserve({ ...first, invocation: f.input });
  await dispatch(first.plan);
  const next = await secondCall(f);
  const second = await f.services.runtime.prepare(next.input, next.call);
  if (!("reservation" in second)) throw new Error("expected a sandbox-execution.v2 admission");
  expect(second.plan.environmentId).not.toBe(first.plan.environmentId);
  expect(second.plan.identity.jobId).not.toBe(first.plan.identity.jobId);
  expect(
    (await f.services.brokerV2.preparations.reserve({ ...second, invocation: next.input })).applied,
  ).toBe(true);
  await dispatch(second.plan);
  expect(executed.map((item) => item.invocationId)).toEqual([
    first.plan.identity.invocationId,
    second.plan.identity.invocationId,
  ]);
  const store = f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const environments = (await store.readRun(RUN_ID))?.environments ?? [];
  expect(environments).toHaveLength(1);
  expect(new Set(executed.map((item) => item.identity.environmentId))).toEqual(
    new Set([environments[0]?.identity.environmentId]),
  );
  expect(environments[0]?.calls.map((call) => call.invocationId)).toEqual([
    first.plan.identity.invocationId,
    second.plan.identity.invocationId,
  ]);
  expect(lifecycle.calls.filter((call) => call === "create")).toHaveLength(1);
});

it("refuses a container operation binding when task environments are not configured", async () => {
  const f = await productionSandboxScope(read, undefined, {
    piParameters: { path: "notes.txt" },
    directoryOperations: ["read"],
    profileRef: "authorized-project.v1",
  });
  cleanups.push(f.close);
  await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow(
    "SANDBOX_TASK_ENVIRONMENT_UNAVAILABLE",
  );
  expect(
    await f.services.brokerV2.preparations.readAdmissionByInvocation({
      runId: RUN_ID,
      invocationId: f.input.invocationId,
    }),
  ).toBeUndefined();
  expect(
    await f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID).readRun(RUN_ID),
  ).toBeUndefined();
});

it.each([
  ["an SRT operation binding", { ...read, backendRef: "srt" }, false, "SANDBOX_OPERATION_SRT_ONLY"],
  ["a legacy SRT file read", read, true, "SANDBOX_BINDING_SRT_ONLY"],
] as const)(
  "refuses %s before admission when strict mode is on",
  async (_name, binding, legacy, reasonCode) => {
    const lifecycle = new Lifecycle();
    const f = await productionSandboxScope(binding, undefined, {
      piParameters: { path: "notes.txt" },
      directoryOperations: ["read"],
      profileRef: "authorized-project.v1",
      legacyFileRead: legacy,
      taskEnvironments: { backendRef: BACKEND, imageDigest: IMAGE_DIGEST, lifecycle },
    });
    cleanups.push(f.close);
    expect(f.services.executionMode).toBe("strict");
    await expect(
      f.services.strictModeRefusal({
        capabilityRef: f.input.capabilityRef,
        capabilityVersion: f.input.capabilityVersion,
        operation: f.input.operation,
      }),
    ).resolves.toBe(reasonCode);
    await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow(
      "SANDBOX_STRICT_MODE_UNAVAILABLE",
    );
    expect(
      await f.services.brokerV2.preparations.readAdmissionByInvocation({
        runId: RUN_ID,
        invocationId: f.input.invocationId,
      }),
    ).toBeUndefined();
    expect(
      await f.repository
        .sandboxJobJournal(OWNER_ID, AGENT_ID)
        .readByInvocation({ runId: RUN_ID, invocationId: f.input.invocationId }),
    ).toBeUndefined();
    expect(
      await f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID).readRun(RUN_ID),
    ).toBeUndefined();
    expect(lifecycle.calls).toEqual([]);
  },
);

it.each([
  ["strict mode with a container binding", read, true, "strict", null],
  ["SRT mode with an SRT binding", { ...read, backendRef: "srt" }, false, "srt", null],
  [
    "strict mode with an undeclared operation",
    { ...read, operation: "write" },
    true,
    "strict",
    null,
  ],
] as const)(
  "reports no strict-mode refusal for %s",
  async (_name, binding, strict, mode, reasonCode) => {
    const lifecycle = new Lifecycle();
    const f = await productionSandboxScope(binding, undefined, {
      piParameters: { path: "notes.txt" },
      directoryOperations: ["read"],
      profileRef: "authorized-project.v1",
      ...(strict
        ? { taskEnvironments: { backendRef: BACKEND, imageDigest: IMAGE_DIGEST, lifecycle } }
        : {}),
    });
    cleanups.push(f.close);
    expect(f.services.executionMode).toBe(mode);
    await expect(
      f.services.strictModeRefusal({
        capabilityRef: f.input.capabilityRef,
        capabilityVersion: f.input.capabilityVersion,
        operation: "read",
      }),
    ).resolves.toBe(reasonCode);
    await expect(
      f.services.strictModeRefusal({
        capabilityRef: "capability-missing",
        capabilityVersion: f.input.capabilityVersion,
        operation: "read",
      }),
    ).rejects.toThrow("SANDBOX_HOST_BINDING_UNAVAILABLE");
    expect(lifecycle.calls).toEqual([]);
  },
);

it("releases a reserved container call that never started when the Run is cancelled", async () => {
  const { f, lifecycle, executed, prepare } = await setup();
  const prepared = await prepare();
  await f.services.brokerV2.preparations.reserve({ ...prepared, invocation: f.input });
  expect(await f.services.resources.stopRun(RUN_ID, "run_cancelled")).toEqual({ released: true });
  const admission = await f.services.brokerV2.preparations.readAdmission(prepared.plan.identity);
  expect(admission).toMatchObject({
    phase: "reserved",
    releaseReceipt: {
      verification: {
        basis: "task_environment_released",
        taskEnvironmentIds: [expect.any(String)],
      },
    },
    workspaceBlocked: false,
  });
  const store = f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  expect((await store.readRun(RUN_ID))?.environments).toEqual([
    expect.objectContaining({
      state: "released",
      stopIntent: expect.objectContaining({ reason: "run_cancelled" }),
    }),
  ]);
  expect(executed).toEqual([]);
  expect(lifecycle.calls.filter((call) => call === "stop")).toHaveLength(1);
});

async function unboundContainer(
  status: "cancelled" | "failed" | "reconciling_external_result" = "cancelled",
) {
  let authority = SERVICE_AUTHORITY;
  const scope = await setup("returned", read, {
    realRun: true,
    piParameters: { path: "notes.txt" },
    directoryOperations: ["read"],
    authority: () => authority,
  });
  const prepared = await scope.prepare();
  expect(
    (
      await scope.f.services.brokerV2.preparations.reserve({
        ...prepared,
        invocation: scope.f.input,
      })
    ).applied,
  ).toBe(true);
  const runs = scope.f.repository.runLifecycle(OWNER_ID, AGENT_ID, authority.product);
  const current = await runs.readRun(RUN_ID);
  if (!current) throw new Error("Run missing");
  const terminal = {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    authority: authority.lease,
    expectedRevision: current.revision,
    idempotencyKey: createIdempotencyKey(`d6-${status}`),
    commandFingerprint: `d6-${status}`,
    payloadRef: "restart-prompt",
  };
  if (status === "reconciling_external_result")
    writeProductState(
      scope.f,
      "UPDATE runs SET status='reconciling_external_result' WHERE id=?",
      RUN_ID,
    );
  else if (status === "cancelled") await runs.cancelRun(terminal);
  else
    await runs.transitionRun({
      ...terminal,
      nextStatus: "failed",
      executionLease: {
        ...prepared.plan.executionLease,
        executionLeaseId: createRunExecutionLeaseId(prepared.plan.executionLease.executionLeaseId),
        authorityLeaseId: createAuthorityLeaseId(prepared.plan.executionLease.authorityLeaseId),
        deploymentId: createDeploymentId(prepared.plan.executionLease.deploymentId),
      },
    });
  const parent = path.join(process.cwd(), ".ci-output/r2-d6");
  await mkdir(parent, { recursive: true });
  const evidenceRoot = await mkdtemp(path.join(parent, "unbound-"));
  const snapshot = async (stage: string) => {
    const database = new Database(path.join(scope.f.f.resource.stateRoot, "product.sqlite"), {
      readonly: true,
    });
    try {
      const result = {
        authority,
        run: database.prepare("SELECT id, status, revision FROM runs WHERE id=?").get(RUN_ID),
        admission: database
          .prepare(
            "SELECT job_id, preparation_state, started_at, reservation_stopped_at FROM sandbox_execution_records WHERE job_id=?",
          )
          .get(prepared.plan.identity.jobId),
        occupancy: database
          .prepare("SELECT released_at FROM sandbox_workspace_occupancy WHERE job_id=?")
          .all(prepared.plan.identity.jobId),
        reservationReceipts: database
          .prepare("SELECT * FROM sandbox_reservation_release_receipts WHERE job_id=?")
          .all(prepared.plan.identity.jobId),
        environments: database
          .prepare(
            "SELECT e.environment_id, e.state, e.stop_fence, e.create_intent_id FROM execution_environments e JOIN execution_jobs j USING(execution_job_id) WHERE j.run_id=?",
          )
          .all(RUN_ID),
        environmentReceipts: database
          .prepare(
            "SELECT r.* FROM execution_environment_release_receipts r JOIN execution_environments e USING(environment_id) JOIN execution_jobs j USING(execution_job_id) WHERE j.run_id=?",
          )
          .all(RUN_ID),
        stopIntents: database
          .prepare(
            "SELECT i.environment_id, i.stop_fence, i.stop_intent_id, i.reason, i.requested_at, i.authority_json FROM execution_environment_stop_intents i JOIN execution_environments e USING(environment_id) JOIN execution_jobs j USING(execution_job_id) WHERE j.run_id=?",
          )
          .all(RUN_ID),
        otherEnvironments: database
          .prepare(
            "SELECT j.run_id, e.environment_id, e.state, e.stop_fence FROM execution_environments e JOIN execution_jobs j USING(execution_job_id) WHERE j.run_id!=?",
          )
          .all(RUN_ID),
        environmentLeases: database
          .prepare(
            "SELECT l.released_at FROM execution_environment_leases l JOIN execution_environments e USING(environment_id) JOIN execution_jobs j USING(execution_job_id) WHERE j.run_id=?",
          )
          .all(RUN_ID),
        intents: database
          .prepare("SELECT kind FROM sandbox_execution_intents WHERE job_id=?")
          .all(prepared.plan.identity.jobId),
        lifecycleCalls: [...scope.lifecycle.calls],
        executed: [...scope.executed],
        published: [...scope.published],
        quickCheck: database.prepare("PRAGMA quick_check").all(),
      };
      await writeFile(path.join(evidenceRoot, `${stage}.json`), JSON.stringify(result, null, 2));
      return result;
    } finally {
      database.close();
    }
  };
  const restart = async () => {
    authority = { ...authority, agentServiceBootId: `${authority.agentServiceBootId}:restart` };
    await scope.f.reopen();
  };
  return { ...scope, prepared, snapshot, restart };
}

it("[R2-D6] stops a cancelled Run's unbound container after Agent restart without replay", async () => {
  const f = await unboundContainer();
  const before = await f.snapshot("cancelled-before-restart");
  expect(before.run).toMatchObject({ status: "cancelled" });
  expect(before.admission).toMatchObject({ preparation_state: "reserved", started_at: null });
  expect(before.environments).toEqual([expect.objectContaining({ state: "ready" })]);
  expect(before.reservationReceipts).toEqual([]);
  expect(before.environmentReceipts).toEqual([]);
  await f.restart();
  await f.f.services.resources.recoverPending(new AbortController().signal, 10);
  const after = await f.snapshot("recovered-after-restart");
  expect(after.environments).toEqual([expect.objectContaining({ state: "released" })]);
  expect(after.environmentReceipts).toHaveLength(1);
  expect(after.reservationReceipts).toHaveLength(1);
  expect(after.occupancy).toEqual([expect.objectContaining({ released_at: T1 })]);
  expect(after.admission).toMatchObject({ preparation_state: "reserved", started_at: null });
  expect(after.executed).toEqual([]);
  expect(after.published).toEqual([]);
  expect(after.intents).toEqual([]);
  expect(after.lifecycleCalls.filter((call) => call === "stop")).toHaveLength(1);
  expect(after.lifecycleCalls.filter((call) => call === "verifyStopped")).toHaveLength(1);
  await f.restart();
  await f.f.services.resources.recoverPending(new AbortController().signal, 10);
  const repeated = await f.snapshot("repeated-after-second-restart");
  expect({ ...repeated, authority: after.authority }).toEqual(after);
});

it("[R2-P2] releases a reconciling Run's fenced container reservation after Agent restart and stops the environment once its lease expires", async () => {
  const f = await unboundContainer("reconciling_external_result");
  const before = await f.snapshot("reconciling-before-restart");
  expect(before.run).toMatchObject({ status: "reconciling_external_result" });
  expect(before.admission).toMatchObject({ preparation_state: "reserved", started_at: null });
  expect(before.environments).toEqual([expect.objectContaining({ state: "ready" })]);
  await f.restart();
  await f.f.services.resources.recoverPending(new AbortController().signal, 10);
  const fenced = await f.snapshot("reconciling-reservation-released");
  expect(readReservationRecovery(f.f, f.prepared.plan.identity.jobId)).toMatchObject(
    RESERVATION_RELEASE_CONFIRMED,
  );
  expect(fenced.admission).toMatchObject({
    preparation_state: "reserved",
    started_at: null,
    reservation_stopped_at: expect.any(String),
  });
  expect(fenced.reservationReceipts).toHaveLength(1);
  expect(
    JSON.parse((fenced.reservationReceipts[0] as { verification_json: string }).verification_json),
  ).toMatchObject({ basis: "task_environment_bind_fenced" });
  expect(fenced.occupancy).toEqual([expect.objectContaining({ released_at: T1 })]);
  expect(fenced.environments).toEqual([expect.objectContaining({ state: "ready" })]);
  expect(fenced.environmentLeases).toEqual([expect.objectContaining({ released_at: null })]);
  expect(fenced.lifecycleCalls.filter((call) => call === "stop")).toHaveLength(0);

  expireRunExecutionLease(f.f);
  await f.f.services.resources.recoverPending(new AbortController().signal, 10);
  const stopped = await f.snapshot("reconciling-environment-stopped");
  expect(stopped.environments).toEqual([expect.objectContaining({ state: "released" })]);
  expect(stopped.stopIntents).toEqual([expect.objectContaining({ reason: "supervision_lost" })]);
  expect(stopped.environmentReceipts).toHaveLength(1);
  expect(stopped.reservationReceipts).toEqual(fenced.reservationReceipts);
  expect(stopped.admission).toMatchObject({ preparation_state: "reserved", started_at: null });
  expect(stopped.executed).toEqual([]);
  expect(stopped.published).toEqual([]);
  expect(stopped.intents).toEqual([]);
  expect(stopped.lifecycleCalls.filter((call) => call === "stop")).toHaveLength(1);
});

it("[R2-D6] stops a failed Run's unbound container without stopping another Run", async () => {
  const f = await unboundContainer("failed");
  const commands = new ThreadCommandService({
    repository: f.f.repository.threadRepository(),
    clock: { now: () => T1 },
    authority: () => SERVICE_AUTHORITY.product,
  });
  const thread = await commands.create({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: createThreadId("d6-other-thread"),
    idempotencyKey: "d6-other-thread",
    resultRef: "restart-prompt",
  });
  const otherRunId = createRunId("d6-other-run");
  await commands.admitOwnerMessage({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: thread.thread.id,
    expectedThreadRevision: thread.thread.revision,
    sessionId: createSessionId("d6-other-session"),
    runId: otherRunId,
    idempotencyKey: "d6-other-message",
    contentRef: "restart-prompt",
    sourceProofRef: "fixture-owner",
    dataClassification: "private",
    resultRef: "restart-prompt",
  });
  let sequence = 0;
  const store = f.f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const coordinator = new TaskEnvironmentCoordinator({
    store,
    backend: f.lifecycle,
    authority: () => SERVICE_AUTHORITY,
    clock: { now: () => T1 },
    ids: { next: (scope) => `d6-other:${scope}:${++sequence}` },
  });
  const other = await coordinator.acquire({
    runId: otherRunId,
    hostId: f.prepared.plan.identity.hostId,
    envelope: {
      schemaVersion: "execution-envelope.v1",
      directories: [],
      network: [],
      resources: {
        cpuMillicores: 1000,
        memoryBytes: 268435456,
        maxProcesses: 64,
        privateStorageBytes: 16777216,
      },
    },
    leases: [],
    policyDigest: "a".repeat(64),
    imageDigest: IMAGE_DIGEST,
    runnerDigest: "c".repeat(64),
    deadlineAt: T2,
  });
  expect(other.state).toBe("ready");
  await f.restart();
  await f.f.services.resources.recoverPending(new AbortController().signal, 10);
  const after = await f.snapshot("failed-run-recovered");
  expect(after.run).toMatchObject({ status: "failed" });
  expect(after.environments).toEqual([expect.objectContaining({ state: "released" })]);
  expect(after.environmentReceipts).toHaveLength(1);
  expect(after.reservationReceipts).toHaveLength(1);
  expect(after.executed).toEqual([]);
  expect(after.intents).toEqual([]);
  expect(
    await f.f.repository
      .executionEnvironmentStore(OWNER_ID, AGENT_ID)
      .read(other.identity.environmentId),
  ).toEqual(other);
  expect(f.lifecycle.stopped).toEqual(
    new Set([
      f.lifecycle.requests.find(({ identity }) => identity.runId === RUN_ID)?.createIntentId,
    ]),
  );
});

it.each(["stop_rejected", "proof_missing", "wrong_run", "wrong_locator"] as const)(
  "[R2-D6] holds the unbound reservation when %s and releases it on a manual stop retry",
  async (fault) => {
    const f = await unboundContainer();
    const originalVerify = f.lifecycle.verifyStopped.bind(f.lifecycle);
    const failure =
      fault === "stop_rejected"
        ? vi.spyOn(f.lifecycle, "stop").mockRejectedValue(new Error("stop rejected"))
        : vi.spyOn(f.lifecycle, "verifyStopped").mockImplementation(async (input) => {
            if (fault === "proof_missing") throw new Error("stop proof unavailable");
            const proof = await originalVerify(input);
            if (proof.basis !== "verified_stopped") throw new Error("stopped proof missing");
            return fault === "wrong_run"
              ? { ...proof, identity: { ...proof.identity, runId: "another-run" } }
              : {
                  ...proof,
                  locator: { ...proof.locator, runtimeEnvironmentId: "another-container" },
                };
          });
    await f.restart();
    await f.f.services.resources.recoverPending(new AbortController().signal, 10);
    const failed = await f.snapshot(`${fault}-held`);
    expect(failed.environments).toEqual([expect.objectContaining({ state: "stop_requested" })]);
    expect(failed.stopIntents).toHaveLength(1);
    expect(failed.environmentReceipts).toEqual([]);
    expect(failed.reservationReceipts).toEqual([]);
    expect(failed.occupancy).toEqual([expect.objectContaining({ released_at: null })]);
    expect(failed.environmentLeases).toEqual([expect.objectContaining({ released_at: null })]);
    expect(failed.admission).toMatchObject({ preparation_state: "reserved", started_at: null });
    expect(failed.executed).toEqual([]);
    expect(failed.published).toEqual([]);
    expect(failed.intents).toEqual([]);
    await f.restart();
    await f.f.services.resources.recoverPending(new AbortController().signal, 10);
    const paused = await f.snapshot(`${fault}-paused-after-restart`);
    expect({ ...paused, authority: failed.authority }).toEqual(failed);
    expect(failure).toHaveBeenCalledTimes(1);
    failure.mockRestore();
    expect(await f.f.services.resources.stopRun(RUN_ID, "run_cancelled")).toEqual({
      released: true,
    });
    const released = await f.snapshot(`${fault}-manual-release`);
    expect(released.environments).toEqual([expect.objectContaining({ state: "released" })]);
    expect(released.environmentReceipts).toHaveLength(1);
    expect(released.reservationReceipts).toHaveLength(1);
    expect(released.stopIntents).toEqual(failed.stopIntents);
    expect(released.occupancy).toEqual([expect.objectContaining({ released_at: T1 })]);
    expect(released.executed).toEqual([]);
    expect(released.intents).toEqual([]);
  },
);

it("[R2-D6] does not start recovery after its caller has cancelled the pump", async () => {
  const f = await unboundContainer();
  await f.restart();
  const before = await f.snapshot("before-aborted-pump");
  const controller = new AbortController();
  controller.abort();
  await f.f.services.resources.recoverPending(controller.signal, 10);
  expect(await f.snapshot("after-aborted-pump")).toEqual(before);
});

it.each([true, false])(
  "[R2-D6] releases a running Run's fenced container reservation from environment release or the bind fence (environment released=%s)",
  async (released) => {
    const { f, lifecycle, executed, prepare } = await setup("returned", read, {
      realRun: true,
      piParameters: { path: "notes.txt" },
      directoryOperations: ["read"],
    });
    const prepared = await prepare();
    const preparations = f.services.brokerV2.preparations;
    await preparations.reserve({ ...prepared, invocation: f.input });
    const store = f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
    const environment = (await store.readRun(RUN_ID))?.environments[0];
    if (!environment) throw new Error("Task environment missing");
    if (released) {
      let nextId = 0;
      const coordinator = new TaskEnvironmentCoordinator({
        store,
        backend: lifecycle,
        authority: () => SERVICE_AUTHORITY,
        clock: { now: () => T1 },
        ids: { next: (scope) => `automatic-recovery:${scope}:${++nextId}` },
      });
      const stopped = await coordinator.stop({
        environmentId: environment.identity.environmentId,
        reason: "failure",
        stoppedResourceRefs: [],
      });
      expect(stopped.state).toBe("released");
      expect(stopped.releaseReceipt).toBeDefined();
    }
    await preparations.interruptReservation({
      identity: prepared.plan.identity,
      authority: SERVICE_AUTHORITY,
      now: T1,
      reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
    });
    const signal = new AbortController().signal;
    await f.services.resources.recoverPending(signal, 10);
    const admission = await preparations.readAdmission(prepared.plan.identity);
    expect(admission).toMatchObject({ phase: "reserved" });
    const database = new Database(path.join(f.f.resource.stateRoot, "product.sqlite"), {
      readonly: true,
    });
    try {
      const occupancy = database
        .prepare("SELECT released_at AS releasedAt FROM sandbox_workspace_occupancy WHERE job_id=?")
        .all(prepared.plan.identity.jobId);
      expect(occupancy).toEqual([expect.objectContaining({ releasedAt: T1 })]);
    } finally {
      database.close();
    }
    if (released) {
      expect(admission).toMatchObject({
        workspaceBlocked: false,
        releaseReceipt: {
          verification: {
            basis: "task_environment_released",
            taskEnvironmentIds: [environment.identity.environmentId],
          },
        },
      });
    } else {
      expect(admission).toMatchObject({
        workspaceBlocked: false,
        releaseReceipt: { verification: { basis: "task_environment_bind_fenced" } },
      });
      expect(admission).not.toHaveProperty("releaseReceipt.verification.taskEnvironmentIds");
      expect((await store.read(environment.identity.environmentId))?.state).toBe("ready");
    }
    await f.services.resources.recoverPending(signal, 10);
    expect(await preparations.readAdmission(prepared.plan.identity)).toEqual(admission);
    expect(executed).toEqual([]);
    expect(lifecycle.calls.filter((call) => call === "stop")).toHaveLength(released ? 1 : 0);
  },
);

const NOT_STARTED = {
  outcome: "failed",
  outputRef: null,
  errorCode: "SANDBOX_TOOL_NOT_STARTED",
} as const;
const silentDelivery = { assertDisclosure: async () => {}, saveReceipt: async () => {} };

it("[R2-P2] ends a running Run's fenced container call as not started once and runs the next call in the same environment", async () => {
  const { f, lifecycle, executed, prepare, dispatch } = await setup("returned", read, {
    realRun: true,
    piParameters: { path: "notes.txt" },
    directoryOperations: ["read"],
  });
  const prepared = await prepare();
  const preparations = f.services.brokerV2.preparations;
  await preparations.reserve({ ...prepared, invocation: f.input });
  const store = f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const environment = (await store.readRun(RUN_ID))?.environments[0];
  if (!environment) throw new Error("Task environment missing");
  await preparations.interruptReservation({
    identity: prepared.plan.identity,
    authority: SERVICE_AUTHORITY,
    now: T1,
    reasonCode: "SANDBOX_PREVIOUS_BOOT_UNKNOWN",
  });
  await f.services.resources.recoverPending(new AbortController().signal, 10);
  expect(await preparations.readAdmission(prepared.plan.identity)).toMatchObject({
    phase: "reserved",
    recovery: RESERVATION_RELEASE_CONFIRMED,
    workspaceBlocked: false,
    releaseReceipt: { verification: { basis: "task_environment_bind_fenced" } },
  });
  expect(await store.read(environment.identity.environmentId)).toMatchObject({ state: "ready" });
  expect(lifecycle.calls.filter((call) => call === "stop")).toHaveLength(0);
  const invocation = { runId: RUN_ID, invocationId: prepared.plan.identity.invocationId };
  expect(await f.services.completeToolResult(invocation, silentDelivery)).toMatchObject(
    NOT_STARTED,
  );
  expect(await f.services.completeToolResult(invocation, silentDelivery)).toMatchObject(
    NOT_STARTED,
  );
  expect(executed).toEqual([]);

  const next = await secondCall(f);
  const second = await f.services.runtime.prepare(next.input, next.call);
  if (!("reservation" in second)) throw new Error("expected a sandbox-execution.v2 admission");
  expect((await preparations.reserve({ ...second, invocation: next.input })).applied).toBe(true);
  await dispatch(second.plan);
  expect(executed.map((item) => item.invocationId)).toEqual([second.plan.identity.invocationId]);
  expect(executed[0]?.identity.environmentId).toBe(environment.identity.environmentId);
  expect((await store.readRun(RUN_ID))?.environments).toHaveLength(1);
  expect(lifecycle.calls.filter((call) => call === "create")).toHaveLength(1);
  expect(lifecycle.calls.filter((call) => call === "stop")).toHaveLength(0);
});

it("[R2-P2] ends a container call as not started when its reservation is stopped after the call registered with the environment", async () => {
  const { f, lifecycle, executed, prepare, dispatch } = await setup("returned", read, {
    realRun: true,
    piParameters: { path: "notes.txt" },
    directoryOperations: ["read"],
  });
  const prepared = await prepare();
  const preparations = f.services.brokerV2.preparations;
  await preparations.reserve({ ...prepared, invocation: f.input });
  const request = SqliteExecutionContext.prototype.request;
  let fencedAfterLink = 0;
  const linkCall = vi
    .spyOn(SqliteExecutionContext.prototype, "request")
    .mockImplementation(async function <TResult>(
      this: SqliteExecutionContext,
      operation: string,
      payload: unknown,
    ): Promise<TResult> {
      const result = (await request.call(this, operation, payload)) as TResult;
      if (operation === "capabilityInvocation.executionEnvironment.linkCall") {
        linkCall.mockRestore();
        await preparations.interruptReservation({
          identity: prepared.plan.identity,
          authority: SERVICE_AUTHORITY,
          now: T1,
          reasonCode: "SANDBOX_PREVIOUS_BOOT_UNKNOWN",
        });
        fencedAfterLink += 1;
      }
      return result;
    });
  try {
    await dispatch(prepared.plan).catch(() => undefined);
  } finally {
    linkCall.mockRestore();
  }
  expect(fencedAfterLink).toBe(1);
  const store = f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const [environment] = (await store.readRun(RUN_ID))?.environments ?? [];
  expect(environment?.calls.map((call) => call.invocationId)).toEqual([
    prepared.plan.identity.invocationId,
  ]);
  expect(await preparations.readAdmission(prepared.plan.identity)).toMatchObject({
    phase: "reserved",
    stopRequestedAt: T1,
  });
  expect(executed).toEqual([]);

  await f.services.resources.recoverPending(new AbortController().signal, 10);
  expect(await preparations.readAdmission(prepared.plan.identity)).toMatchObject({
    phase: "reserved",
    recovery: RESERVATION_RELEASE_CONFIRMED,
    workspaceBlocked: false,
    releaseReceipt: { verification: { basis: "task_environment_bind_fenced" } },
  });
  expect(
    await f.services.completeToolResult(
      { runId: RUN_ID, invocationId: prepared.plan.identity.invocationId },
      silentDelivery,
    ),
  ).toMatchObject(NOT_STARTED);
  expect(executed).toEqual([]);
  expect(lifecycle.calls.filter((call) => call === "stop")).toHaveLength(0);
});

it("rejects a reserved container release while its task environment is still running", async () => {
  const { f, prepare } = await setup();
  const prepared = await prepare();
  await f.services.brokerV2.preparations.reserve({ ...prepared, invocation: f.input });
  const plan = prepared.plan;
  const interrupted = await f.services.brokerV2.preparations.interruptReservation({
    identity: plan.identity,
    authority: SERVICE_AUTHORITY,
    now: T1,
    reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
  });
  const fenced = interrupted.admission;
  if (fenced.phase !== "reserved" || !fenced.stopRequestedAt)
    throw new Error("reservation was not fenced");
  const stopRequestedAt = fenced.stopRequestedAt;
  const store = f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const running = (await store.readRun(RUN_ID))?.environments ?? [];
  expect(running.map((environment) => environment.state)).toEqual(["ready"]);
  await expect(
    f.services.brokerV2.preparations.releaseReservation({
      identity: plan.identity,
      authority: SERVICE_AUTHORITY,
      now: T1,
      verification: {
        schemaVersion: "sandbox-reservation-release.v1",
        basis: "task_environment_released",
        identity: plan.identity,
        environmentId: plan.environmentId,
        semanticFingerprint: fenced.plan.semanticFingerprint,
        stopRequestedAt,
        checkedAt: T1,
        validUntil: new Date(Date.parse(T1) + 1000).toISOString(),
        taskEnvironmentIds: running.map((environment) => environment.identity.environmentId),
        evidence: { ref: "environment-release:forged", digest: "d".repeat(64) },
      },
    }),
  ).rejects.toThrow("Invalid reservation release verification");
  expect(await f.services.brokerV2.preparations.readAdmission(plan.identity)).not.toHaveProperty(
    "releaseReceipt",
  );
});

async function preparedWriteSetup(
  outcome: "returned" | "lost" | "closed",
  beforeCommit: (workspace: string) => Promise<void> = async () => {},
) {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(T1) });
  const setupResult = await setup(
    outcome,
    preparedWrite,
    writeOptions,
    (workspace) => writeFile(path.join(workspace, "file.txt"), "before"),
    beforeCommit,
  );
  const prepared = await setupResult.prepare();
  expect(
    (
      await setupResult.f.services.brokerV2.preparations.reserve({
        ...prepared,
        invocation: setupResult.f.input,
      })
    ).applied,
  ).toBe(true);
  await setupResult.dispatch(prepared.plan);
  const store = setupResult.f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const environment = (await store.readRun(RUN_ID))?.environments[0];
  const record = await setupResult.f.repository
    .sandboxExecutionJournal(OWNER_ID, AGENT_ID)
    .read(prepared.plan.identity);
  const content = await readFile(path.join(setupResult.f.host.workspace, "file.txt"), "utf8");
  return { ...setupResult, prepared, store, environment, record, content };
}

it("publishes a prepared write from the host under the Run's task environment", async () => {
  const { f, executed, published, prepared, store, environment, record, content } =
    await preparedWriteSetup("returned");
  expect(prepared.plan.backendRef).toBe(BACKEND);
  expect(content).toBe("candidate");
  expect(executed).toEqual([]);
  expect(published).toEqual([
    {
      identity: environment?.identity,
      createIntentId: environment?.createIntentId,
      locator: environment?.locator,
      stopFence: 0,
      invocationId: prepared.plan.identity.invocationId,
      deadlineAt: prepared.plan.effectiveDeadlineAt,
      authorizationRef: prepared.plan.authorizationRef,
    },
  ]);
  const environmentId = environment?.identity.environmentId ?? "";
  expect(record?.facts.environment).toMatchObject({
    kind: "container",
    taskEnvironmentId: environmentId,
  });
  expect(record?.facts.result).toMatchObject({ kind: "result", completion: { type: "value" } });
  expect(record?.facts.effect).toMatchObject({
    kind: "verified",
    verifierRef: PI_WRITE_VERIFIER.ref,
    evidence: {
      ref: record?.facts.result?.kind === "result" ? record.facts.result.output.ref : "",
    },
  });
  expect(record?.facts.resource).toMatchObject({
    supervision: "released",
    evidence: { subject: { kind: "task_environment", environmentId } },
  });
  expect(record?.releaseReceipt).not.toBeNull();
  expect((await store.read(environmentId))?.calls).toEqual([
    expect.objectContaining({
      invocationId: prepared.plan.identity.invocationId,
      completedAt: expect.any(String),
    }),
  ]);
  expect(await f.services.resources.stopRun(RUN_ID, "run_finished")).toEqual({ released: true });
  expect(await store.read(environmentId)).toMatchObject({ state: "released" });
});

it("keeps the user's newer file and records a version conflict when it changed after preparation", async () => {
  const { published, record, content } = await preparedWriteSetup("returned", (workspace) =>
    writeFile(path.join(workspace, "file.txt"), "edited by the user"),
  );
  expect(published).toHaveLength(1);
  expect(content).toBe("edited by the user");
  expect(record?.facts.result).toMatchObject({
    kind: "error",
    reasonCode: "FILE_VERSION_CONFLICT",
  });
  expect(record?.facts.effect).toMatchObject({ kind: "verified" });
  expect(record?.facts.resource.supervision).toBe("released");
});

it("writes nothing and stops the environment when its task environment refuses host publication", async () => {
  const { f, published, store, environment, record, content } = await preparedWriteSetup("closed");
  expect(published).toHaveLength(1);
  expect(content).toBe("before");
  expect(record?.facts.result).toMatchObject({ kind: "unknown" });
  expect(record?.facts.resource.supervision).toBe("lost");
  expect(await f.services.resources.stopRun(RUN_ID, "run_cancelled")).toEqual({ released: true });
  expect(await store.read(environment?.identity.environmentId ?? "")).toMatchObject({
    state: "released",
  });
});

it("treats a lost host publication reply as an unknown effect", async () => {
  const { record } = await preparedWriteSetup("lost");
  expect(record?.facts.result).toMatchObject({ kind: "unknown" });
  expect(record?.facts.effect.kind).toBe("unknown");
  expect(record?.facts.resource.supervision).toBe("lost");
});

it("refuses a write without a prepared candidate on the container route", async () => {
  const { f, executed, published, prepare, dispatch } = await setup(
    "returned",
    { ...preparedWrite, contract: { ...preparedWrite.contract, ...PI_FIXED_FILE_CONTRACT } },
    writeOptions,
    (workspace) => writeFile(path.join(workspace, "file.txt"), "before"),
  );
  const prepared = await prepare();
  await f.services.brokerV2.preparations.reserve({ ...prepared, invocation: f.input });
  await dispatch(prepared.plan);
  expect(executed).toEqual([]);
  expect(published).toEqual([]);
  expect(await readFile(path.join(f.host.workspace, "file.txt"), "utf8")).toBe("before");
  const admission = await f.services.brokerV2.preparations.readAdmission(prepared.plan.identity);
  expect(admission?.phase).toBe("reserved");
});

async function lostContainerCall() {
  let authority = SERVICE_AUTHORITY;
  const scope = await setup("lost", read, {
    piParameters: { path: "notes.txt" },
    directoryOperations: ["read"],
    authority: () => authority,
  });
  const prepared = await scope.prepare();
  await scope.f.services.brokerV2.preparations.reserve({ ...prepared, invocation: scope.f.input });
  await scope.dispatch(prepared.plan);
  const journal = () => scope.f.repository.sandboxExecutionJournal(OWNER_ID, AGENT_ID);
  const record = await journal().read(prepared.plan.identity);
  if (!record) throw new Error("missing container execution record");
  const supersede = async () => {
    authority = {
      ...SERVICE_AUTHORITY,
      product: { ...SERVICE_AUTHORITY.product, fencingToken: 2 },
      lease: { ...SERVICE_AUTHORITY.lease, fencingToken: 2 },
    };
    writeProductState(scope.f, "UPDATE deployments SET fencing_token=2");
    writeProductState(scope.f, "UPDATE authority_leases SET fencing_token=2");
    await scope.f.reopen();
  };
  return { ...scope, journal, prepared, record, supersede };
}

it("[R2-P2] keeps a container call's unknown result while its task environment is still running", async () => {
  const f = await lostContainerCall();
  expect(f.record.facts.result).toMatchObject({ kind: "unknown" });
  expect(f.record.facts.resource.supervision).toBe("lost");
  expect(f.record.releaseReceipt).toBeUndefined();
  const store = f.f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const environmentId =
    (await store.readRun(RUN_ID))?.environments[0]?.identity.environmentId ?? "";
  expect((await store.read(environmentId))?.state).toBe("running");

  const recovered = await f.f.services.recoverMissingToolResult(f.record);
  expect(recovered.facts.result).toMatchObject({ kind: "unknown" });
  expect(await f.journal().read(f.prepared.plan.identity)).toEqual(f.record);
  expect(f.executed).toHaveLength(1);
});

it("[R2-P2] records a released container call's result as lost only after its execution authority is superseded", async () => {
  const f = await lostContainerCall();
  expect(await f.f.services.resources.stopRun(RUN_ID, "run_cancelled")).toEqual({ released: true });
  const released = await f.journal().read(f.prepared.plan.identity);
  expect(released?.facts.resource.supervision).toBe("released");
  expect(released?.releaseReceipt).toEqual(
    expect.objectContaining({ acceptedAt: expect.any(String) }),
  );
  expect(released?.facts.result).toMatchObject({ kind: "unknown" });
  if (!released) throw new Error("missing released record");

  const beforeSupersede = await f.f.services.recoverMissingToolResult(released);
  expect(beforeSupersede.facts.result).toMatchObject({ kind: "unknown" });
  expect(f.executed).toHaveLength(1);

  await f.supersede();
  const latest = await f.journal().read(f.prepared.plan.identity);
  if (!latest) throw new Error("missing record after restart");
  const recovered = await f.f.services.recoverMissingToolResult(latest);
  expect(recovered.facts.result).toMatchObject({
    kind: "error",
    reasonCode: "SANDBOX_TOOL_RESULT_LOST",
  });
  expect(f.executed).toHaveLength(1);
});

function readProductState(
  f: Awaited<ReturnType<typeof setup>>["f"],
  statement: string,
  ...parameters: string[]
) {
  const database = new Database(path.join(f.f.resource.stateRoot, "product.sqlite"), {
    readonly: true,
  });
  try {
    return database.prepare(statement).get(...parameters) as Record<string, unknown> | undefined;
  } finally {
    database.close();
  }
}

it("[R2-P2] keeps a released container call's unknown result when its environment release basis never dispatched the call", async () => {
  const f = await lostContainerCall();
  expect(await f.f.services.resources.stopRun(RUN_ID, "run_cancelled")).toEqual({ released: true });
  const released = await f.journal().read(f.prepared.plan.identity);
  expect(released?.facts.resource.supervision).toBe("released");
  expect(released?.releaseReceipt).toEqual(
    expect.objectContaining({ acceptedAt: expect.any(String) }),
  );
  const store = f.f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const environmentId =
    (await store.readRun(RUN_ID))?.environments[0]?.identity.environmentId ?? "";
  const receipt = readProductState(
    f.f,
    "SELECT stop_fence AS stopFence, accepted_at AS acceptedAt, authority_json AS authorityJson FROM execution_environment_release_receipts WHERE environment_id=?",
    environmentId,
  );
  if (!receipt) throw new Error("missing environment release receipt");
  writeProductState(
    f.f,
    "DELETE FROM execution_environment_release_receipts WHERE environment_id=?",
    environmentId,
  );
  writeProductState(
    f.f,
    "INSERT INTO execution_environment_release_receipts (environment_id,basis,stop_fence,accepted_at,proof_json,authority_json) VALUES (?,'create_not_dispatched',?,?,NULL,?)",
    environmentId,
    String(receipt["stopFence"]),
    String(receipt["acceptedAt"]),
    String(receipt["authorityJson"]),
  );

  await f.supersede();
  const latest = await f.journal().read(f.prepared.plan.identity);
  if (!latest) throw new Error("missing record after restart");
  const recovered = await f.f.services.recoverMissingToolResult(latest);
  expect(recovered.facts.result).toMatchObject({ kind: "unknown" });
  expect(recovered).toEqual(latest);
  expect(f.executed).toHaveLength(1);
});

it("[R2-P2] keeps a released container call's unknown result when its environment call record is missing", async () => {
  const f = await lostContainerCall();
  expect(await f.f.services.resources.stopRun(RUN_ID, "run_cancelled")).toEqual({ released: true });
  const released = await f.journal().read(f.prepared.plan.identity);
  expect(released?.facts.resource.supervision).toBe("released");
  expect(released?.releaseReceipt).toEqual(
    expect.objectContaining({ acceptedAt: expect.any(String) }),
  );
  const store = f.f.repository.executionEnvironmentStore(OWNER_ID, AGENT_ID);
  const environmentId =
    (await store.readRun(RUN_ID))?.environments[0]?.identity.environmentId ?? "";
  writeProductState(
    f.f,
    "DELETE FROM execution_environment_calls WHERE environment_id=? AND invocation_id=?",
    environmentId,
    f.prepared.plan.identity.invocationId,
  );

  await f.supersede();
  const latest = await f.journal().read(f.prepared.plan.identity);
  if (!latest) throw new Error("missing record after restart");
  const recovered = await f.f.services.recoverMissingToolResult(latest);
  expect(recovered.facts.result).toMatchObject({ kind: "unknown" });
  expect(recovered).toEqual(latest);
  expect(f.executed).toHaveLength(1);
});
