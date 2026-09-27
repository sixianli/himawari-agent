import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ExecutionEnvironmentLifecyclePort,
  RemoteExecutionBackend,
  taskEnvironmentCallEvidence,
} from "@himawari-agent/application";
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
import { afterEach, expect, it, vi } from "vitest";
import type { SandboxContainerRoute } from "../../apps/execution-worker/src/production-sandbox-execution-v2.ts";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import { queuedLiveWorker } from "../fixtures/queued-live-worker.ts";
import {
  AGENT_ID,
  OWNER_ID,
  RUN_ID,
  SERVICE_AUTHORITY,
  serviceRequest,
  T1,
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
  async stop(input: Parameters<ExecutionEnvironmentLifecyclePort["stop"]>[0]) {
    this.calls.push("stop");
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
