import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import {
  type SandboxOperationBinding,
  sandboxExecutionFactsSchema,
} from "@himawari-agent/execution-contracts";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import {
  type JobHostControlObservation,
  openJobHostControl,
} from "../../packages/runtime-sandbox/src/job-host-control.ts";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import { sandboxV2Admission } from "../fixtures/sandbox-execution-v2-fixture.ts";
import { AGENT_ID, OWNER_ID, T1, T2 } from "../fixtures/sqlite-capability-invocation-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const descriptor = (operation: string, background = false): SandboxOperationBinding => ({
  operation,
  mode: background ? "background" : "foreground",
  contract: {
    ref: operation,
    version: "1",
    kind: background
      ? "task_start"
      : operation === "read" || operation === "search"
        ? "fixed_read"
        : "command",
  },
  backendRef: "srt",
  scopeSource: "grant_targets",
  directoryOperations:
    operation === "read" || operation === "search" ? ["read"] : ["read", "create", "update"],
  network: "grant_targets",
});
it("reuses the persisted queued plan with its original receipt and deadlines", async () => {
  const f = await productionSandboxScope(descriptor("bash"));
  cleanups.push(f.close);
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared)) throw new Error("expected v2");
  const position = await f.services.brokerV2.preparations.enqueue({
    ...prepared,
    invocation: f.input,
  });
  const replay = await f.services.runtime.prepare(
    { ...f.input, receiptRef: "newly-generated-receipt" },
    f.call,
  );
  expect(replay).toEqual(prepared);
  expect(
    await f.services.brokerV2.preparations.readQueuedByInvocation({
      runId: f.call.runId,
      invocationId: f.input.invocationId,
    }),
  ).toMatchObject({ ...position, plan: prepared.plan });
  await expect(
    f.services.runtime.prepare(
      { ...f.input, deadlineAt: new Date(Date.parse(f.input.deadlineAt) - 1).toISOString() },
      f.call,
    ),
  ).rejects.toThrow();
  await f.repository.authorizationStore().revokeGrant(f.input.authorizationRef ?? "", T1, "test");
  await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow();
});
it.each(["read", "edit", "write", "search", "bash", "background"])(
  "production scope derives %s from the same durable Grant",
  async (operation) => {
    const f = await productionSandboxScope(descriptor(operation, operation === "background"));
    cleanups.push(f.close);
    const prepared = await f.services.runtime.prepare(f.input, f.call);
    if (!("reservation" in prepared)) throw new Error("expected v2");
    const admitted = await f.services.brokerV2.preparations.reserve({
      ...prepared,
      invocation: f.input,
    });
    if (admitted.admission.phase !== "reserved") throw new Error("expected reserved");
    // SRT adds proxy sockets below the job directory on the production host.
    const socketPath = `/data/hermes/himawari/jobs/${admitted.admission.plan.identity.jobId}/claude-socks-0123456789abcdef.sock`;
    expect(Buffer.byteLength(socketPath)).toBeLessThan(108);
    const send = await f.connect(admitted.admission.plan.identity);
    const scope = (await send({ kind: "resolve" })).resolvedScope;
    if (!scope || scope.scope.schemaVersion !== "sandbox-scope.v1")
      throw new Error("directory scope missing");
    expect(scope.allowedDomains).toEqual(["example.com:443"]);
    expect(scope.scope.networkAuthorizationRef).toBe(f.input.authorizationRef);
    expect(scope.scope.directoryGrant.operations).toEqual(
      descriptor(operation).directoryOperations,
    );
    const replay = await f.services.runtime.prepare(f.input, f.call);
    if (!("reservation" in replay)) throw new Error("expected v2 replay");
    expect(
      (await f.services.brokerV2.preparations.reserve({ ...replay, invocation: f.input })).applied,
    ).toBe(false);
    expect((await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID))[0]?.uses).toBe(
      1,
    );
    expect(
      await f.repository.capabilityStore(OWNER_ID, AGENT_ID).getExecutionHandle(f.input.handleRef),
    ).toMatchObject({ uses: 1 });
    await f.repository.authorizationStore().revokeGrant(f.input.authorizationRef ?? "", T1, "test");
    await expect(f.services.brokerV2.verifyStart(admitted.admission.plan)).rejects.toThrow();
    await expect(send({ kind: "resolve" })).rejects.toThrow();
  },
);
it("rejects unsupported mode before consuming and rejects expired scope", async () => {
  const f = await productionSandboxScope(descriptor("bash"));
  cleanups.push(f.close);
  f.setSupport([{ schemaVersion: "sandbox-execution.v1", mode: "foreground" }]);
  await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow();
  expect((await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID))[0]?.uses).toBe(1);
  f.setSupport([{ schemaVersion: "sandbox-execution.v2", mode: "foreground" }]);
  f.setNow(T2);
  await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow();
});

it.each(["host", "network", "model", "thread", "operation"])(
  "production scope rejects mismatched approved %s",
  async (kind) => {
    const f = await productionSandboxScope(descriptor("bash"), (intent) => ({
      ...intent,
      ...(kind === "host"
        ? {
            targets: intent.targets.map((target) =>
              target.type === "host" ? { ...target, ref: "other-host" } : target,
            ),
          }
        : {}),
      ...(kind === "network"
        ? {
            targets: intent.targets.map((target) =>
              target.type === "network-domain"
                ? { ...target, ref: "unauthorized.example" }
                : target,
            ),
          }
        : {}),
      ...(kind === "model" ? { recipients: ["other-model"] } : {}),
      ...(kind === "thread" ? { threadId: "other-thread" } : {}),
      ...(kind === "operation" ? { operation: "write" } : {}),
    }));
    cleanups.push(f.close);
    await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow();
    expect(
      await f.repository.capabilityStore(OWNER_ID, AGENT_ID).getExecutionHandle(f.input.handleRef),
    ).toMatchObject({ uses: 0 });
  },
);
it.each(["grant", "parent"])("rejects substituted %s before admission", async (kind) => {
  const f = await productionSandboxScope(descriptor("bash"));
  cleanups.push(f.close);
  if (kind === "grant")
    await expect(
      f.services.runtime.prepare({ ...f.input, authorizationRef: "different-grant" }, f.call),
    ).rejects.toThrow("SANDBOX_EXECUTION_HANDLE_MISMATCH");
  else
    await expect(
      f.services.runtime.prepare(f.input, f.call, { ...f.call, toolCallId: "forged-parent" }),
    ).rejects.toThrow("SANDBOX_SCOPE_UNAVAILABLE");
});

it("UDS rechecks durable revocation after resolving scope", async () => {
  const f = await productionSandboxScope(descriptor("bash"));
  cleanups.push(f.close);
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared)) throw new Error("v2 required");
  const admitted = await f.services.brokerV2.preparations.reserve({
    ...prepared,
    invocation: f.input,
  });
  if (admitted.admission.phase !== "reserved") throw new Error("reserved required");
  const send = await f.connect(admitted.admission.plan.identity);
  f.setAfterResolve(async () => {
    await f.repository.authorizationStore().revokeGrant(f.input.authorizationRef ?? "", T1, "race");
  });
  await expect(send({ kind: "resolve" })).rejects.toThrow();
  expect(
    (await f.services.brokerV2.preparations.readAdmission(admitted.admission.plan.identity))?.phase,
  ).toBe("reserved");
});

it.each(["runtime", "directory"])("rechecks real %s identity before start", async (kind) => {
  const f = await productionSandboxScope(descriptor("bash"));
  cleanups.push(f.close);
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared)) throw new Error("v2 required");
  const admitted = await f.services.brokerV2.preparations.reserve({
    ...prepared,
    invocation: f.input,
  });
  if (admitted.admission.phase !== "reserved") throw new Error("reserved required");
  await f.services.brokerV2.verifyStart(admitted.admission.plan);
  if (kind === "runtime") await appendFile(f.host.binding.runner.path, "\n# replaced fixture\n");
  else {
    await rename(f.host.workspace, `${f.host.workspace}-old`);
    await mkdir(f.host.workspace);
  }
  await expect(f.services.brokerV2.verifyStart(admitted.admission.plan)).rejects.toThrow();
  expect(
    (await f.services.brokerV2.preparations.readAdmission(admitted.admission.plan.identity))?.phase,
  ).toBe("reserved");
});

it("manages the original task and live output through SQLite and authenticated UDS without consuming again", async () => {
  const f = await productionSandboxScope(descriptor("background", true));
  cleanups.push(f.close);
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared)) throw new Error("expected v2");
  const admitted = await f.services.brokerV2.preparations.reserve({
    ...prepared,
    invocation: f.input,
  });
  if (admitted.admission.phase !== "reserved") throw new Error("expected reserved");
  const { plan, reservation } = admitted.admission;
  const base = sandboxV2Admission(f.f).facts;
  const environment = {
    ...base.environment,
    creator: plan.identity,
    environmentId: plan.environmentId,
    mode: plan.mode,
    resourceRef: reservation.resourceRef,
    scopeDigest: plan.binding.scopeDigest,
    authorizationRef: plan.authorizationRef,
    backendRef: plan.backendRef,
    deadlineAt: plan.effectiveDeadlineAt,
    workspaceConflictRefs: reservation.workspaceConflictRefs,
  };
  const facts = sandboxExecutionFactsSchema.parse({
    ...base,
    environment,
    resource: {
      ...base.resource,
      creator: plan.identity,
      environmentId: plan.environmentId,
      scopeDigest: plan.binding.scopeDigest,
      resourceRef: reservation.resourceRef,
      status: { kind: "task", state: "starting" },
      sequence: 2,
    },
  });
  const bound = await f.services.brokerV2.preparations.bindAndStart({
    identity: plan.identity,
    expectedSequence: 1,
    facts,
    authority: f.input.authority,
    now: T1,
  });
  const resourceRef = reservation.resourceRef;
  if (!resourceRef) throw new Error("resource missing");
  const send = await f.connect(plan.identity);
  await send({
    kind: "append_output",
    resourceRef,
    expectedSequence: bound.record.facts.resource.sequence,
    chunk: { index: 0, offset: 0, bytesBase64: "aGVsbG8=", end: false },
  });
  const call = {
    ...f.call,
    capabilityRef: "execution.task.output",
    capabilityHandleRef: null,
    toolCallId: "output-query",
    arguments: { resourceRef, limit: 2 },
  };
  const result = await f.services.managedTasks.execute(call);
  expect(JSON.parse(result.modelContent)).toMatchObject({ bytesBase64: "aGU=", end: false });
  expect(await f.services.managedTasks.execute(call)).toEqual(result);
  await expect(
    f.services.managedTasks.execute({ ...call, arguments: { resourceRef: "foreign" } }),
  ).rejects.toThrow();
  if (!call.context) throw new Error("context missing");
  await expect(
    f.services.managedTasks.execute({
      ...call,
      context: { ...call.context, modelRef: "foreign-model" },
    }),
  ).rejects.toThrow();
  expect((await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID))[0]?.uses).toBe(1);
  await f.repository.authorizationStore().revokeGrant(f.input.authorizationRef ?? "", T1, "test");
  await expect(f.services.managedTasks.execute(call)).rejects.toThrow();
});

it("persists a finite stop for unbound reservations without claiming resource release", async () => {
  const f = await productionSandboxScope(descriptor("read"));
  cleanups.push(f.close);
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared)) throw new Error("expected v2");
  const admitted = await f.services.brokerV2.preparations.reserve({
    ...prepared,
    invocation: f.input,
  });
  if (admitted.admission.phase !== "reserved") throw new Error("expected reserved");
  expect(await f.services.resources.stopRun(f.call.runId)).toEqual({ released: false });
  const saved = await f.services.brokerV2.preparations.readAdmission(
    admitted.admission.plan.identity,
  );
  expect(saved).toMatchObject({
    phase: "reserved",
    recovery: {
      action: "stop",
      status: "unresolved",
      reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
      finishedAt: T1,
    },
  });
  const rpc = await f.connect(admitted.admission.plan.identity);
  await expect(rpc({ kind: "resolve" })).rejects.toThrow();
  const readback = new Database(path.join(f.f.resource.stateRoot, "product.sqlite"), {
    readonly: true,
  });
  try {
    expect(readback.prepare("SELECT count(*) FROM sandbox_release_receipts").pluck().get()).toBe(0);
    expect(
      readback
        .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
        .pluck()
        .get(),
    ).toBeGreaterThan(0);
  } finally {
    readback.close();
  }
});

it("stops bound foreground records without declaring unverified resources released", async () => {
  const f = await productionSandboxScope(descriptor("read"));
  cleanups.push(f.close);
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared)) throw new Error("expected v2");
  const admitted = await f.services.brokerV2.preparations.reserve({
    ...prepared,
    invocation: f.input,
  });
  if (admitted.admission.phase !== "reserved") throw new Error("expected reserved");
  const { plan, reservation } = admitted.admission;
  const base = sandboxV2Admission(f.f).facts;
  const environment = {
    ...base.environment,
    creator: plan.identity,
    environmentId: plan.environmentId,
    mode: plan.mode,
    resourceRef: reservation.resourceRef,
    scopeDigest: plan.binding.scopeDigest,
    authorizationRef: plan.authorizationRef,
    backendRef: plan.backendRef,
    deadlineAt: plan.effectiveDeadlineAt,
    workspaceConflictRefs: reservation.workspaceConflictRefs,
  };
  const facts = sandboxExecutionFactsSchema.parse({
    ...base,
    environment,
    resource: {
      ...base.resource,
      creator: plan.identity,
      environmentId: plan.environmentId,
      scopeDigest: plan.binding.scopeDigest,
      resourceRef: reservation.resourceRef,
      status: { kind: "foreground" },
      sequence: 2,
    },
  });
  const bound = await f.services.brokerV2.preparations.bindAndStart({
    identity: plan.identity,
    expectedSequence: 1,
    facts,
    authority: f.input.authority,
    now: T1,
  });

  const reconcile = vi.spyOn(f.services.brokerV2.reconciliation, "reconcile").mockResolvedValue({
    applied: true,
    record: {
      ...bound.record,
      facts: {
        ...bound.record.facts,
        resource: {
          ...bound.record.facts.resource,
          supervision: "released",
          cleanup: "confirmed",
          evidence: {
            ref: "release",
            digest: "a".repeat(64),
            profileRef: plan.binding.profileRef,
            qualificationRef: plan.binding.qualificationRef,
            validUntil: T2,
            subject: { kind: "local_process", processIdentityRef: "original-process" },
          },
        },
      },
    },
  });
  expect(await f.services.resources.stopRun(f.call.runId)).toEqual({ released: false });
  expect(reconcile).toHaveBeenCalledWith(
    expect.objectContaining({ identity: plan.identity, action: "stop" }),
  );
});

it.each(["pending", "rejected"] as const)(
  "sends stop to later admission pages while the first cleanup is %s",
  async (firstOutcome) => {
    const pages = vi.fn();
    const original = SqliteProductStateRepository.prototype.sandboxExecutionPreparations;
    const preparationFactory = vi
      .spyOn(SqliteProductStateRepository.prototype, "sandboxExecutionPreparations")
      .mockImplementation(function (this: SqliteProductStateRepository, ...args) {
        const port = original.apply(this, args);
        return { ...port, listAdmissions: pages };
      });
    // Replace only pagination before the production factory captures its frozen
    // port. Admission/binding still use SQLite; cleanup is the controlled boundary.
    let f: Awaited<ReturnType<typeof productionSandboxScope>>;
    try {
      f = await productionSandboxScope(descriptor("read"));
    } finally {
      preparationFactory.mockRestore();
    }
    cleanups.push(f.close);
    const prepared = await f.services.runtime.prepare(f.input, f.call);
    if (!("reservation" in prepared)) throw new Error("expected v2");
    const admitted = await f.services.brokerV2.preparations.reserve({
      ...prepared,
      invocation: f.input,
    });
    if (admitted.admission.phase !== "reserved") throw new Error("expected reserved");
    const { plan, reservation } = admitted.admission;
    const base = sandboxV2Admission(f.f).facts;
    const environment = {
      ...base.environment,
      creator: plan.identity,
      environmentId: plan.environmentId,
      mode: plan.mode,
      resourceRef: reservation.resourceRef,
      scopeDigest: plan.binding.scopeDigest,
      authorizationRef: plan.authorizationRef,
      backendRef: plan.backendRef,
      deadlineAt: plan.effectiveDeadlineAt,
      workspaceConflictRefs: reservation.workspaceConflictRefs,
    };
    const facts = sandboxExecutionFactsSchema.parse({
      ...base,
      environment,
      resource: {
        ...base.resource,
        creator: plan.identity,
        environmentId: plan.environmentId,
        scopeDigest: plan.binding.scopeDigest,
        resourceRef: reservation.resourceRef,
        status: { kind: "foreground" },
        sequence: 2,
      },
    });
    const bound = await f.services.brokerV2.preparations.bindAndStart({
      identity: plan.identity,
      expectedSequence: 1,
      facts,
      authority: f.input.authority,
      now: T1,
    });

    const admissions = Array.from({ length: 101 }, (_, index) => ({
      phase: "bound" as const,
      record: {
        ...bound.record,
        plan: {
          ...bound.record.plan,
          identity: {
            ...bound.record.plan.identity,
            jobId: `stop-page-${String(index).padStart(3, "0")}`,
          },
        },
      },
    }));
    pages
      .mockResolvedValueOnce(admissions.slice(0, 100))
      .mockResolvedValueOnce(admissions.slice(100));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = vi
      .spyOn(f.services.brokerV2.reconciliation, "reconcile")
      .mockImplementation(async (input) => {
        if (input.identity.jobId === "stop-page-000") {
          if (firstOutcome === "rejected") throw new Error("original host unavailable");
          await pending;
        }
        return { applied: false, record: bound.record };
      });
    const stopping = f.services.resources.stopRun(f.call.runId);
    try {
      await vi.waitFor(() =>
        expect(reconcile).toHaveBeenCalledWith(
          expect.objectContaining({
            identity: expect.objectContaining({ jobId: "stop-page-100" }),
            action: "stop",
          }),
        ),
      );
      expect(pages).toHaveBeenLastCalledWith({
        runId: f.call.runId,
        afterJobId: "stop-page-099",
        limit: 100,
      });
      expect(reconcile).toHaveBeenCalledTimes(101);
    } finally {
      release();
      expect(await stopping).toEqual({ released: false });
    }
  },
);

it.each(["stopRun", "recovery"] as const)(
  "releases never-started reservations through production %s and retains the stop fence",
  async (mode) => {
    // Real SQLite, installed-byte checks, authenticated socket and process exit;
    // supervisor facts and platform qualification remain controlled test inputs.
    vi.stubEnv("TMPDIR", "/tmp");
    let f: Awaited<ReturnType<typeof productionSandboxScope>>;
    try {
      f = await productionSandboxScope(descriptor("read"));
    } finally {
      vi.unstubAllEnvs();
    }
    cleanups.push(f.close);
    const prepared = await f.services.runtime.prepare(f.input, f.call);
    if (!("reservation" in prepared)) throw new Error("expected v2");
    const admitted = await f.services.brokerV2.preparations.reserve({
      ...prepared,
      invocation: f.input,
    });
    if (admitted.admission.phase !== "reserved") throw new Error("expected reserved");
    const { plan } = admitted.admission;
    const directory = path.join(f.host.binding.privateRoot, "c");
    await mkdir(directory, { mode: 0o700 });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const exited = once(child, "exit");
    cleanups.push(async () => {
      child.kill();
      await exited;
    });
    if (!child.pid) throw new Error("test host missing");
    const binding = {
      directory,
      token: "a".repeat(64),
      sessionId: randomUUID(),
      jobId: plan.identity.jobId,
      attemptId: plan.identity.attemptId,
    };
    let stops = 0;
    let sequence = 0;
    let observation: JobHostControlObservation = {
      ...binding,
      bootId: randomUUID(),
      processIdentityRef: `job-host-process:${randomUUID()}`,
      processId: child.pid,
      processStartedAt: T1,
      observedAt: T1,
      sequence: 1,
      phase: "ready",
      policyDigest: "b".repeat(64),
      privateDirectoryRef: `sandbox-private:${"a".repeat(64)}`,
      linuxNamespace: null,
      taskStarted: false,
      taskProcessExited: false,
      stdioClosed: false,
      srtReset: false,
      resources: null,
    };
    const server = await openJobHostControl(
      binding,
      () => ({ ...observation, sequence: ++sequence }),
      () => {
        stops++;
        observation = { ...observation, phase: "finished", srtReset: true };
        child.kill();
      },
    );
    cleanups.push(() => server.finish());
    await f.services.brokerV2.registerControl(plan, binding);
    if (mode === "stopRun") {
      await f.services.resources.stopRun(f.call.runId);
      await exited;
      expect(await f.services.resources.stopRun(f.call.runId)).toEqual({ released: true });
    } else {
      // The original host has exited without starting code; the terminal Run is
      // discovered by the production recovery lane, without a new user stop.
      observation = { ...observation, phase: "finished", srtReset: true };
      child.kill();
      await exited;
      const writer = new Database(path.join(f.f.resource.stateRoot, "product.sqlite"));
      try {
        writer.prepare("UPDATE runs SET status='completed' WHERE id=?").run(f.call.runId);
      } finally {
        writer.close();
      }
      await f.repository
        .authorizationStore()
        .revokeGrant(f.input.authorizationRef ?? "", T1, "test");
      await f.services.resources.recoverPending(new AbortController().signal, 1);
    }
    const saved = await f.services.brokerV2.preparations.readAdmission(plan.identity);
    expect(saved).toMatchObject({
      phase: "reserved",
      stopRequestedAt: T1,
      workspaceBlocked: false,
      releaseReceipt: { acceptedAt: T1, verification: { basis: "host_never_started" } },
      recovery: {
        status: "resolved",
        ...(mode === "recovery" ? { attempts: 1, action: "stop", nextAttemptAt: null } : {}),
      },
    });
    const readback = new Database(path.join(f.f.resource.stateRoot, "product.sqlite"), {
      readonly: true,
    });
    try {
      expect(
        readback
          .prepare("SELECT count(*) FROM sandbox_workspace_occupancy WHERE released_at IS NULL")
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        readback
          .prepare("SELECT started_at FROM sandbox_execution_records WHERE job_id=?")
          .pluck()
          .get(plan.identity.jobId),
      ).toBeNull();
      expect(
        readback.prepare("SELECT count(*) FROM sandbox_reservation_release_receipts").pluck().get(),
      ).toBe(1);
      expect(readback.prepare("SELECT count(*) FROM sandbox_release_receipts").pluck().get()).toBe(
        0,
      );
    } finally {
      readback.close();
    }
    const previousStops = stops;
    f.setNow(T2);
    expect(await f.services.resources.stopRun(f.call.runId)).toEqual({ released: true });
    expect(stops).toBe(previousStops);
    expect(await f.services.brokerV2.preparations.readAdmission(plan.identity)).toEqual(saved);
    await expect(f.services.brokerV2.verifyStart(plan)).rejects.toThrow();
  },
);
