import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CapabilityInvocationReceiptPort,
  type CapabilityInvocationResultPort,
  type SandboxExecutionJournalPort,
  type SandboxExecutionPreparationPort,
  SandboxExecutionReconciliationService,
  SandboxScopeService,
} from "@himawari-agent/application";
import {
  type SandboxExecutionBrokerCommand,
  type SandboxExecutionPlanV2,
  sandboxExecutionFactsSchema,
  sandboxExecutionReservationSchema,
} from "@himawari-agent/execution-contracts";
import { PayloadUdsClient, PayloadUdsServer } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionPayloadBrokerHandler } from "../../apps/agent-service/src/production-payload-broker-handler.ts";
import { sandboxV2Admission, sandboxV2Call } from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openSandboxJournal,
  operationsForDatabase,
  SERVICE_AUTHORITY,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(reserve = false, newBoot = false, resource = false) {
  const f = await openSandboxJournal();
  cleanups.push(f.close);
  const baseInput = sandboxV2Admission(f);
  const input = resource
    ? {
        ...baseInput,
        plan: {
          ...baseInput.plan,
          mode: "background" as const,
          operationContract: { ref: "task", version: "1", kind: "task_start" as const },
        },
        facts: sandboxExecutionFactsSchema.parse({
          ...baseInput.facts,
          environment: {
            ...baseInput.facts.environment,
            mode: "background",
            resourceRef: "task-output",
          },
          resource: {
            ...baseInput.facts.resource,
            resourceRef: "task-output",
            status: { kind: "task", state: "starting" },
          },
        }),
      }
    : baseInput;
  const operations = operationsForDatabase(f.database);
  const invoke = (operation: string, value: unknown) =>
    operations.execute(operation, { ownerId: OWNER_ID, agentId: AGENT_ID, input: value });
  const preparations: SandboxExecutionPreparationPort = {
    reserve: async (value) =>
      invoke("capabilityInvocation.sandboxV2.reserve", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["reserve"]>
      >,
    readAdmission: async (value) =>
      invoke("capabilityInvocation.sandboxV2.readAdmission", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["readAdmission"]>
      >,
    readAdmissionByInvocation: async (value) =>
      invoke("capabilityInvocation.sandboxV2.readAdmissionByInvocation", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["readAdmissionByInvocation"]>
      >,
    readAdmissionByResource: async (value) =>
      invoke("capabilityInvocation.sandboxV2.readAdmissionByResource", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["readAdmissionByResource"]>
      >,
    listAdmissions: async (value) =>
      invoke("capabilityInvocation.sandboxV2.listAdmissions", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["listAdmissions"]>
      >,
    bindAndStart: async (value) =>
      invoke("capabilityInvocation.sandboxV2.bindAndStart", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["bindAndStart"]>
      >,
  };
  const reservation = sandboxExecutionReservationSchema.parse({
    schemaVersion: "sandbox-preparation.v1",
    identity: input.plan.identity,
    environmentId: input.plan.environmentId,
    resourceRef: null,
    mode: input.plan.mode,
    workspaceConflictRefs: input.workspaces.map((item) => item.ref),
    sequence: 1,
    createdAt: input.plan.requestedAt,
  });
  const admission = reserve
    ? (await preparations.reserve({ ...input, reservation })).admission
    : undefined;
  const record =
    admission?.phase === "reserved"
      ? {
          plan: admission.plan,
          facts: input.facts,
          startedAt: null,
          operationRevision: 0,
          workspaces: input.workspaces,
        }
      : sandboxV2Call(f, "admit", input).record;
  const unavailable = async (): Promise<never> => {
    throw new Error("not part of observation boundary");
  };
  const journal: SandboxExecutionJournalPort = {
    admit: unavailable,
    read: async (value) => sandboxV2Call(f, "read", value),
    listPending: unavailable,
    start: async (value) => sandboxV2Call(f, "start", value),
    append: async (value) => sandboxV2Call(f, "append", value),
    recordOperation: async (value) => sandboxV2Call(f, "recordOperation", value),
    prepareIntent: unavailable,
    dispatchIntent: unavailable,
    acknowledgeIntent: unavailable,
    observeIntent: unavailable,
  };
  const receipts: CapabilityInvocationReceiptPort = {
    consume: unavailable,
    read: async (value) =>
      invoke("capabilityInvocation.read", value) as Awaited<
        ReturnType<CapabilityInvocationReceiptPort["read"]>
      >,
  };
  const results: CapabilityInvocationResultPort = {
    observeOutput: unavailable,
    lookupOutput: unavailable,
    lookupFrozen: async (value) =>
      invoke("capabilityInvocationResult.lookupFrozen", value) as Awaited<
        ReturnType<CapabilityInvocationResultPort["lookupFrozen"]>
      >,
  };
  let registrations = 0;
  let outputWrites = 0;
  let now = T1;
  let beforeVerify = async () => {};
  const scopeReader = new SandboxScopeService({
    payloads: { get: async (ref) => (ref === f.scopePayload.ref ? f.scopePayload : undefined) },
    protector: f.protector,
    files: f.files,
    hostId: record.plan.identity.hostId,
    now: () => now,
    digest: (bytes) => createHash("sha256").update(bytes).digest("hex"),
  });
  const resolve = ({ semanticFingerprint: _fingerprint, ...candidate }: SandboxExecutionPlanV2) =>
    scopeReader.resolve(candidate, f.scope.parentRequestId);
  const handler = new ProductionPayloadBrokerHandler({
    receipts,
    results,
    payloadsFor: () => ({ get: async () => undefined }),
    protector: f.protector,
    currentAuthority: () => SERVICE_AUTHORITY,
    clock: { now: () => now },
    ids: { next: (scope) => scope },
    agentServiceInstanceId: SERVICE_AUTHORITY.agentServiceInstanceId,
    agentServiceBootId: SERVICE_AUTHORITY.agentServiceBootId,
    maximumPayloadBytes: 1024,
    allowedContentTypes: ["application/json"],
    sandboxExecutions: {
      hostId: record.plan.identity.hostId,
      appendOutput: async () => {
        outputWrites++;
      },
      readOutput: async (_record, query) => ({
        resourceRef: query.resourceRef,
        cursor: query.cursor,
        nextCursor: null,
        output: { ref: "protected-page", digest: "a".repeat(64), byteLength: 0 },
        truncated: false,
        end: true,
      }),
      journal,
      registerControl: async () => {
        registrations++;
        return true;
      },
      reconciliation: new SandboxExecutionReconciliationService({
        hostId: record.plan.identity.hostId,
        journal,
        evidence: { verify: unavailable },
        timeoutMs: 100,
        now: () => now,
      }),
      ...(reserve ? { preparations, verifyPreparation: async () => {} } : {}),
      resolveScope: resolve,
      verifyStart: async (plan) => {
        await beforeVerify();
        await resolve(plan);
      },
    },
  });
  const directory = await mkdtemp(path.join(tmpdir(), "r3-broker-"));
  const credential = { tokenRef: "fixture", tokenValue: "0123456789abcdef0123456789abcdef" };
  const shared = {
    credential,
    agentServiceInstanceId: SERVICE_AUTHORITY.agentServiceInstanceId,
    agentServiceBootId: SERVICE_AUTHORITY.agentServiceBootId,
    workerInstanceId: SERVICE_AUTHORITY.workerInstanceId,
    workerBootId: newBoot ? "new-worker-boot" : SERVICE_AUTHORITY.workerBootId,
    authorityEpoch: 1,
    fencingToken: 1,
    maximumBodyBytes: 65536,
    maximumPayloadBytes: 1024,
    requestTimeoutMs: 1000,
  };
  const server = new PayloadUdsServer({
    ...shared,
    runtimeDirectory: directory,
    allowedWorkerIdentities: [
      { workerInstanceId: shared.workerInstanceId, workerBootId: shared.workerBootId },
    ],
    handler,
  });
  cleanups.push(async () => {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await server.start();
  let sequence = 0;
  const client = new PayloadUdsClient({
    ...shared,
    socketPath: server.socketPath,
    nextId: (scope) => `${scope}:${++sequence}`,
  });
  await client.connect();
  const identity = {
    handleRef: record.plan.handleRef,
    invocationId: record.plan.identity.invocationId,
    workerInstanceId: shared.workerInstanceId,
    workerBootId: shared.workerBootId,
    authorityEpoch: 1,
    fencingToken: 1,
  };
  const request = (command: SandboxExecutionBrokerCommand) =>
    client.sandboxExecution(identity, record.plan.identity, command);
  const revoke = () => {
    const changed = f.database
      .prepare(
        "UPDATE capability_handles SET revoked_at=?, record_json=json_set(record_json,'$.revokedAt',?) WHERE id=?",
      )
      .run(T1, T1, record.plan.handleRef);
    expect(changed.changes).toBe(1);
  };
  return {
    f,
    record,
    client,
    identity,
    request,
    revoke,
    registrations: () => registrations,
    outputWrites: () => outputWrites,
    preparations,
    setBeforeVerify: (hook: () => Promise<void>) => {
      beforeVerify = hook;
    },
    expire: () => {
      now = T2;
    },
    close: async () => {
      await server.stop();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("v2 observation over authenticated UDS and SQLite", () => {
  it("reserves before compilation and binds a later digest once over real UDS", async () => {
    const f = await fixture(true);
    expect((await f.request({ kind: "read" })).record.phase).toBe("reserved");
    const initial = f.record.facts;
    const facts = sandboxExecutionFactsSchema.parse({
      ...initial,
      environment: { ...initial.environment, policyDigest: "9".repeat(64) },
      resource: { ...initial.resource, policyDigest: "9".repeat(64), sequence: 2 },
    });
    const command = { kind: "bind", expectedSequence: 1, facts } as const;
    const replies = await Promise.all([f.request(command), f.request(command)]);
    expect(replies.filter((reply) => reply.applied)).toHaveLength(1);
    expect((await f.request(command)).applied).toBe(false);
    expect(
      f.f.database.prepare("SELECT count(*) FROM capability_invocation_receipts").pluck().get(),
    ).toBe(1);
    expect((await f.request({ kind: "read" })).record.phase).toBe("bound");
    await expect(
      f.request({
        ...command,
        facts: sandboxExecutionFactsSchema.parse({
          ...facts,
          environment: { ...facts.environment, policyDigest: "8".repeat(64) },
          resource: { ...facts.resource, policyDigest: "8".repeat(64) },
        }),
      }),
    ).rejects.toThrow();
  });
  it("rejects withdrawal during preparation without binding or consuming again", async () => {
    const f = await fixture(true);
    f.setBeforeVerify(async () => f.revoke());
    const facts = sandboxExecutionFactsSchema.parse({
      ...f.record.facts,
      resource: { ...f.record.facts.resource, sequence: 2 },
    });
    await expect(f.request({ kind: "bind", expectedSequence: 1, facts })).rejects.toThrow();
    expect((await f.request({ kind: "read" })).record.phase).toBe("reserved");
    expect(
      f.f.database.prepare("SELECT started_at FROM sandbox_execution_records").pluck().get(),
    ).toBeNull();
  });
  it("reads explicit v2 facts and resolves the protected scope without consuming again", async () => {
    const f = await fixture();
    try {
      expect((await f.request({ kind: "read" })).record.plan.schemaVersion).toBe(
        "sandbox-execution.v2",
      );
      expect((await f.request({ kind: "resolve" })).resolvedScope?.scope.inputRef).toBe(
        f.record.plan.inputRef,
      );
      const command = {
        kind: "start",
        expectedSequence: 1,
        policyDigest: f.record.facts.environment.policyDigest,
      } as const;
      const started = await Promise.all([f.request(command), f.request(command)]);
      expect(started.filter((value) => value.applied)).toHaveLength(1);
      expect(
        f.f.database.prepare("SELECT count(*) FROM capability_invocation_receipts").pluck().get(),
      ).toBe(1);
    } finally {
      await f.close();
    }
  });
  it("rechecks real durable revocation after asynchronous preparation, while old reads remain observations", async () => {
    const f = await fixture();
    try {
      f.setBeforeVerify(async () => {
        f.revoke();
      });
      await expect(
        f.request({
          kind: "start",
          expectedSequence: 1,
          policyDigest: f.record.facts.environment.policyDigest,
        }),
      ).rejects.toThrow();
      expect((await f.request({ kind: "read" })).record.startedAt).toBeNull();
      await expect(f.request({ kind: "resolve" })).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
  it("rejects old boot, different target, unknown commands and expired starts", async () => {
    const f = await fixture();
    try {
      await expect(
        f.client.sandboxExecution({ ...f.identity, workerBootId: "old" }, f.record.plan.identity, {
          kind: "read",
        }),
      ).rejects.toThrow();
      await expect(
        f.client.sandboxExecution(
          f.identity,
          { ...f.record.plan.identity, hostId: "foreign" },
          { kind: "read" },
        ),
      ).rejects.toThrow();
      await expect(
        f.request({ kind: "launch-again" } as unknown as SandboxExecutionBrokerCommand),
      ).rejects.toThrow();
      f.expire();
      expect((await f.request({ kind: "read" })).record.startedAt).toBeNull();
      await expect(
        f.request({
          kind: "start",
          expectedSequence: 1,
          policyDigest: f.record.facts.environment.policyDigest,
        }),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
  it("accepts loss facts but never treats a Worker claim as cleanup proof", async () => {
    const f = await fixture();
    try {
      await f.request({
        kind: "start",
        expectedSequence: 1,
        policyDigest: f.record.facts.environment.policyDigest,
      });
      const forged = sandboxExecutionFactsSchema.parse({
        ...f.record.facts,
        resource: {
          ...f.record.facts.resource,
          sequence: 2,
          supervision: "controlled",
          evidence: {
            ref: "worker-claim",
            digest: "a".repeat(64),
            profileRef: f.record.plan.binding.profileRef,
            qualificationRef: f.record.plan.binding.qualificationRef,
            validUntil: T2,
            subject: { kind: "local_process", processIdentityRef: "pid-is-not-proof" },
          },
        },
      });
      await expect(
        f.request({
          kind: "append",
          expectedSequence: 1,
          expectedOperationRevision: 0,
          facts: forged,
        }),
      ).rejects.toThrow();
      const facts = sandboxExecutionFactsSchema.parse({
        ...f.record.facts,
        resource: {
          ...f.record.facts.resource,
          sequence: 2,
          supervision: "lost",
          cleanup: "unknown",
          reasonCode: "host_disconnected",
        },
      });
      expect(
        (
          await f.request({
            kind: "append",
            expectedSequence: 1,
            expectedOperationRevision: 0,
            facts,
          })
        ).applied,
      ).toBe(true);
      const read = (await f.request({ kind: "read" })).record;
      if (read.phase !== "bound") throw new Error("expected a bound execution");
      expect(read.facts.resource.supervision).toBe("lost");
      expect(
        f.f.database.prepare("SELECT released_at FROM sandbox_workspace_occupancy").pluck().get(),
      ).toBeNull();
      const checked = await f.request({ kind: "reconcile", expectedSequence: 2 });
      if (checked.record.phase !== "bound") throw new Error("expected bound");
      expect(checked.record.facts.resource.supervision).toBe("lost");
      expect(checked.record.startedAt).toEqual(read.startedAt);
    } finally {
      await f.close();
    }
  });
});

it("new authenticated Worker reconciles old jobs without inheriting execution or output authority", async () => {
  const f = await fixture(false, true);
  f.revoke();
  await expect(f.request({ kind: "read" })).rejects.toThrow();
  const observed = await f.request({ kind: "reconcile", expectedSequence: 1 });
  expect(observed.record.phase).toBe("bound");
  if (observed.record.phase !== "bound") throw new Error("expected bound record");
  expect(observed.record.facts.resource).toMatchObject({
    supervision: "lost",
    cleanup: "unknown",
    sequence: 3,
  });
  expect(observed.resolvedScope).toBeNull();
  expect(observed.output).toBeNull();
  expect(observed.record.startedAt).toBeNull();
  expect(
    f.f.database.prepare("SELECT count(*) FROM capability_invocation_receipts").pluck().get(),
  ).toBe(1);
  await expect(f.request({ kind: "reconcile", expectedSequence: 1 })).rejects.toThrow();
  await expect(
    f.request({
      kind: "start",
      expectedSequence: 3,
      policyDigest: f.record.facts.environment.policyDigest,
    }),
  ).rejects.toThrow();
  await expect(
    f.client.sandboxExecution(
      { ...f.identity, workerBootId: SERVICE_AUTHORITY.workerBootId },
      f.record.plan.identity,
      { kind: "reconcile", expectedSequence: 3 },
    ),
  ).rejects.toThrow();
});

it("registers control only for a live reserved invocation without starting it", async () => {
  const f = await fixture(true);
  const command = {
    kind: "register_control",
    expectedSequence: 1,
    control: {
      directory: "/private/tmp/control",
      token: "a".repeat(64),
      sessionId: "11111111-1111-1111-1111-111111111111",
      jobId: f.record.plan.identity.jobId,
      attemptId: f.record.plan.identity.attemptId,
    },
  } as const;
  const result = await f.request(command);
  expect(result.record.phase).toBe("reserved");
  expect(result.record.startedAt).toBeNull();
  expect(result.resolvedScope).toBeNull();
  expect(result.output).toBeNull();
  expect(f.registrations()).toBe(1);
  f.revoke();
  await expect(f.request(command)).rejects.toThrow();
  expect(f.registrations()).toBe(1);
});

it("routes task output through authenticated UDS without consuming a new Handle", async () => {
  const f = await fixture(false, false, true);
  const command = {
    kind: "output" as const,
    resourceRef: "task-output",
    cursor: null,
    limit: 16,
    expectedSequence: 1,
  };
  const first = await f.request(command);
  expect(first.output).toMatchObject({
    resourceRef: "task-output",
    output: { ref: "protected-page" },
    end: true,
  });
  expect(await f.request(command)).toEqual(first);
  await expect(f.request({ ...command, resourceRef: "other-task" })).rejects.toThrow();
  expect((await f.request({ kind: "read" })).record.operationRevision).toBe(0);
  f.expire();
  expect((await f.request(command)).output).toEqual(first.output);
});

it("binds resource lookup and output append to the original Run and authenticated Worker", async () => {
  const f = await fixture(false, false, true);
  const found = await f.preparations.readAdmissionByResource({
    runId: f.record.plan.identity.runId,
    resourceRef: "task-output",
  });
  expect(found?.phase).toBe("bound");
  expect(
    await f.preparations.readAdmissionByResource({
      runId: "other-run",
      resourceRef: "task-output",
    }),
  ).toBeUndefined();
  const command = {
    kind: "append_output" as const,
    resourceRef: "task-output",
    expectedSequence: f.record.facts.resource.sequence,
    chunk: { index: 0, offset: 0, bytesBase64: "dGVzdA==", end: false },
  };
  expect((await f.request(command)).applied).toBe(true);
  expect(f.outputWrites()).toBe(1);
  await expect(f.request({ ...command, resourceRef: "foreign-task" })).rejects.toThrow();
  expect(f.outputWrites()).toBe(1);
});
