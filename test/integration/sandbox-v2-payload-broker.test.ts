import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CapabilityInvocationReceiptPort,
  type CapabilityInvocationResultPort,
  type SandboxCleanupPending,
  type SandboxExecutionJournalPort,
  type SandboxExecutionPreparationPort,
  SandboxExecutionReconciliationService,
  type SandboxExecutionVerification,
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
  outputObservation,
  outputPayload,
  SERVICE_AUTHORITY,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(reserve = false, newBoot = false, resource = false, observed = false) {
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
    assertResultAuthority: async (value) => {
      invoke("capabilityInvocation.sandboxV2.assertResultAuthority", value);
    },
    authorizeReservationResult: async (value) => {
      invoke("capabilityInvocation.sandboxV2.authorizeReservationResult", value);
    },
    rebindQueued: async () => {
      throw new Error("Queue authority binding is Agent-internal");
    },
    listRecoveryCandidates: async (value) =>
      invoke("capabilityInvocation.sandboxV2.listRecoveryCandidates", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["listRecoveryCandidates"]>
      >,
    scheduleRecovery: async (value) =>
      invoke("capabilityInvocation.sandboxV2.scheduleRecovery", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["scheduleRecovery"]>
      >,
    beginReservationRecovery: async (value) =>
      invoke("capabilityInvocation.sandboxV2.beginReservationRecovery", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["beginReservationRecovery"]>
      >,
    finishReservationRecovery: async (value) =>
      invoke("capabilityInvocation.sandboxV2.finishReservationRecovery", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["finishReservationRecovery"]>
      >,
    validatePreparation: async (value) => {
      invoke("capabilityInvocation.sandboxV2.validatePreparation", value);
    },
    releaseReservation: async (value) =>
      invoke("capabilityInvocation.sandboxV2.releaseReservation", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["releaseReservation"]>
      >,
    interruptReservation: async (value) =>
      invoke("capabilityInvocation.sandboxV2.interruptReservation", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["interruptReservation"]>
      >,
    listRunningPrograms: async (value) =>
      invoke("capabilityInvocation.sandboxV2.listRunningPrograms", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["listRunningPrograms"]>
      >,
    readRunInventory: async (value) =>
      invoke("capabilityInvocation.sandboxV2.readRunInventory", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["readRunInventory"]>
      >,
    readQueuedByInvocation: async (value) =>
      invoke("capabilityInvocation.sandboxV2.readQueuedByInvocation", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["readQueuedByInvocation"]>
      >,
    enqueue: async (value) =>
      invoke("capabilityInvocation.sandboxV2.enqueue", value) as Awaited<
        ReturnType<SandboxExecutionPreparationPort["enqueue"]>
      >,
    cancelQueued: async (value) => {
      invoke("capabilityInvocation.sandboxV2.cancelQueued", value);
    },
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
    beginRecovery: async (input) => sandboxV2Call(f, "beginRecovery", input),
    finishRecovery: async (input) => sandboxV2Call(f, "finishRecovery", input),
    interruptRecovery: async (input) => {
      sandboxV2Call(f, "interruptRecovery", input);
    },
    admit: unavailable,
    read: async (value) => sandboxV2Call(f, "read", value),
    listPending: unavailable,
    start: async (value) => sandboxV2Call(f, "start", value),
    append: async (value) => sandboxV2Call(f, "append", value),
    recordOperation: async (value) => sandboxV2Call(f, "recordOperation", value),
    readResultRecovery: unavailable,
    importResult: unavailable,
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
  let observation: SandboxExecutionVerification | SandboxCleanupPending | undefined;
  let beforeObservation = async () => {};
  let observationReads = 0;
  let externalVerifications = 0;
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
      observeVerifiedControl: async () => {
        observationReads++;
        await beforeObservation();
        if (!observation) throw new Error("observation unavailable");
        return observation;
      },
      ...(observed
        ? {
            evidence: {
              verify: async () => {
                externalVerifications++;
                throw new Error("external facts lack authenticated evidence");
              },
            },
          }
        : {}),
      registerControl: async (plan) => {
        await beforeVerify();
        await resolve(plan);
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
    journal,
    setBeforeObservation: (hook: () => Promise<void>) => {
      beforeObservation = hook;
    },
    observe: (value: SandboxExecutionVerification | SandboxCleanupPending) => {
      observation = value;
    },
    verificationCounts: () => ({ observationReads, externalVerifications }),
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
  it("persists Agent-authenticated observations once while external claims still require verification", async () => {
    const f = await fixture(false, false, false, true);
    await f.request({
      kind: "start",
      expectedSequence: 1,
      policyDigest: f.record.facts.environment.policyDigest,
    });
    const evidence = {
      ref: "agent-control-evidence",
      digest: "a".repeat(64),
      profileRef: f.record.plan.binding.profileRef,
      qualificationRef: f.record.plan.binding.qualificationRef,
      validUntil: T2,
      subject: { kind: "local_process", processIdentityRef: "authenticated-host-process" },
    };
    const facts = sandboxExecutionFactsSchema.parse({
      ...f.record.facts,
      resource: {
        ...f.record.facts.resource,
        sequence: 2,
        supervision: "controlled",
        cleanup: "pending",
        evidence,
      },
    });
    f.observe({
      facts,
      identity: f.record.plan.identity,
      environmentId: f.record.plan.environmentId,
      policyDigest: facts.environment.policyDigest,
      resourceSequence: 2,
      checkedAt: T1,
      validUntil: T2,
      evidence: [evidence],
      outputs: [],
    });
    const result = await f.request({ kind: "observe_control", expectedSequence: 1 });
    expect(result.applied).toBe(true);
    expect(result.record.phase).toBe("bound");
    if (result.record.phase !== "bound") throw new Error("expected bound execution");
    expect(result.record.facts.resource.supervision).toBe("controlled");
    expect(f.verificationCounts()).toEqual({ observationReads: 1, externalVerifications: 0 });
    await expect(f.request({ kind: "observe_control", expectedSequence: 1 })).rejects.toThrow();
    expect(f.verificationCounts().observationReads).toBe(1);
    await expect(
      f.request({
        kind: "append",
        expectedSequence: 2,
        expectedOperationRevision: result.record.operationRevision,
        facts: sandboxExecutionFactsSchema.parse({
          ...facts,
          resource: { ...facts.resource, sequence: 3 },
        }),
      }),
    ).rejects.toThrow();
    expect(f.verificationCounts().externalVerifications).toBe(1);
  });
  it.each(["process_group_gone", "exit_cleanup_pending"] as const)(
    "keeps a controlled foreground record unchanged when a control check finds the process %s",
    async (exit) => {
      const f = await fixture(false, false, false, true);
      await f.request({
        kind: "start",
        expectedSequence: 1,
        policyDigest: f.record.facts.environment.policyDigest,
      });
      const evidence = {
        ref: "agent-control-evidence",
        digest: "a".repeat(64),
        profileRef: f.record.plan.binding.profileRef,
        qualificationRef: f.record.plan.binding.qualificationRef,
        validUntil: T2,
        subject: { kind: "local_process", processIdentityRef: "authenticated-host-process" },
      };
      const verification = (
        sequence: number,
        state: "controlled" | "process_group_gone" | "exit_cleanup_pending" | "unconfirmed",
      ) => {
        const { evidence: _evidence, ...unsupervised } = f.record.facts
          .resource as typeof f.record.facts.resource & { evidence?: unknown };
        const facts = sandboxExecutionFactsSchema.parse({
          ...f.record.facts,
          resource:
            state === "controlled" || state === "process_group_gone"
              ? {
                  ...f.record.facts.resource,
                  sequence,
                  supervision: state === "controlled" ? "controlled" : "released",
                  cleanup: state === "controlled" ? "pending" : "process_group_gone",
                  evidence,
                }
              : {
                  ...unsupervised,
                  sequence,
                  supervision: "lost",
                  cleanup: "unknown",
                  reasonCode:
                    state === "exit_cleanup_pending"
                      ? "SANDBOX_TASK_EXIT_CLEANUP_PENDING"
                      : "SANDBOX_CONTROL_UNCONFIRMED",
                },
        });
        return {
          facts,
          identity: f.record.plan.identity,
          environmentId: f.record.plan.environmentId,
          policyDigest: facts.environment.policyDigest,
          resourceSequence: sequence,
          checkedAt: T1,
          validUntil: T2,
          evidence: [evidence],
          outputs: [],
        };
      };
      f.observe(verification(2, "controlled"));
      const controlled = await f.request({ kind: "observe_control", expectedSequence: 1 });
      if (controlled.record.phase !== "bound") throw new Error("expected bound execution");
      f.observe(
        exit === "exit_cleanup_pending"
          ? {
              kind: "cleanup_pending",
              identity: f.record.plan.identity,
              environmentId: f.record.plan.environmentId,
              resourceSequence: 2,
              observedAt: T1,
            }
          : verification(3, exit),
      );
      const finished = await f.request({ kind: "observe_control", expectedSequence: 2 });
      expect(finished.applied).toBe(false);
      if (finished.record.phase !== "bound") throw new Error("expected bound execution");
      expect(finished.record.facts.resource.sequence).toBe(2);
      expect(finished.record.facts.resource.supervision).toBe("controlled");
      const reread = await f.request({ kind: "read" });
      if (reread.record.phase !== "bound") throw new Error("expected bound execution");
      expect(reread.record.facts).toEqual(controlled.record.facts);
      f.observe(verification(3, "unconfirmed"));
      const unconfirmed = await f.request({ kind: "observe_control", expectedSequence: 2 });
      expect(unconfirmed.applied).toBe(true);
      if (unconfirmed.record.phase !== "bound") throw new Error("expected bound execution");
      expect(unconfirmed.record.facts.resource).toMatchObject({
        sequence: 3,
        supervision: "lost",
        reasonCode: "SANDBOX_CONTROL_UNCONFIRMED",
      });
    },
  );
  it.each(["result", "release"] as const)(
    "rejects an in-flight control observation overtaken by a durable %s",
    async (writer) => {
      const f = await fixture(false, false, false, true);
      await f.request({
        kind: "start",
        expectedSequence: 1,
        policyDigest: f.record.facts.environment.policyDigest,
      });
      let entered!: () => void;
      let resume!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      f.setBeforeObservation(async () => {
        entered();
        await gate;
      });
      const evidence = {
        ref: "agent-control-evidence",
        digest: "a".repeat(64),
        profileRef: f.record.plan.binding.profileRef,
        qualificationRef: f.record.plan.binding.qualificationRef,
        validUntil: T2,
        subject: { kind: "local_process", processIdentityRef: "authenticated-host-process" },
      };
      const observed = sandboxExecutionFactsSchema.parse({
        ...f.record.facts,
        resource: {
          ...f.record.facts.resource,
          sequence: 2,
          supervision: "controlled",
          cleanup: "pending",
          evidence,
        },
      });
      f.observe({
        facts: observed,
        identity: f.record.plan.identity,
        environmentId: f.record.plan.environmentId,
        policyDigest: observed.environment.policyDigest,
        resourceSequence: 2,
        checkedAt: T1,
        validUntil: T2,
        evidence: [evidence],
        outputs: [],
      });
      const rejection = expect(
        f.request({ kind: "observe_control", expectedSequence: 1 }),
      ).rejects.toThrow();
      await waiting;
      try {
        let current = await f.journal.read(f.record.plan.identity);
        if (!current) throw new Error("missing current execution");
        const output = { ref: "race-result", digest: "f".repeat(64), byteLength: 0 };
        if (writer === "result")
          operationsForDatabase(f.f.database).execute("capabilityInvocationResult.observeOutput", {
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            input: outputObservation({
              payload: outputPayload(output.ref, `sha256:${output.digest}`),
            }),
          });
        for (const stage of writer === "result" ? ["result"] : ["stopping", "released"]) {
          const resource = { ...current.facts.resource } as Record<string, unknown>;
          delete resource["reasonCode"];
          delete resource["evidence"];
          const facts = sandboxExecutionFactsSchema.parse({
            ...current.facts,
            ...(stage === "result"
              ? {
                  effect: { kind: "not_applicable" },
                  result: {
                    schemaVersion: "sandbox-execution.v2",
                    identity: current.plan.identity,
                    environmentId: current.plan.environmentId,
                    policyDigest: current.facts.environment.policyDigest,
                    contract: { ref: "fixed-read", version: "1" },
                    occurredAt: T1,
                    kind: "result",
                    output,
                    completion: { type: "value" },
                  },
                }
              : {
                  resource: {
                    ...resource,
                    sequence: current.facts.resource.sequence + 1,
                    supervision: stage,
                    cleanup: stage === "released" ? "confirmed" : "pending",
                    ...(stage === "released" ? { evidence } : { reasonCode: "TEST_STOP" }),
                  },
                }),
          });
          const input: Parameters<SandboxExecutionJournalPort["append"]>[0] = {
            identity: current.plan.identity,
            expectedSequence: current.facts.resource.sequence,
            expectedOperationRevision: current.operationRevision,
            authority: SERVICE_AUTHORITY,
            now: T1,
            facts,
            context: {
              now: T1,
              environment: facts.environment,
              operationContract: current.plan.operationContract,
              verification: {
                facts,
                identity: current.plan.identity,
                environmentId: current.plan.environmentId,
                policyDigest: facts.environment.policyDigest,
                resourceSequence: facts.resource.sequence,
                checkedAt: T1,
                validUntil: T2,
                evidence: [evidence],
                outputs: stage === "result" ? [output] : [],
              },
              currentResourceSequence: facts.resource.sequence,
              runState: "terminated" as const,
              currentAuthority: false,
              currentFence: false,
              userDisclosureAllowed: false,
              modelDisclosureAllowed: false,
              conflictingWorkspaceRisk: false,
              pendingApprovalOrReconciliation: false,
              resultAlreadyDelivered: false,
            },
          };
          current = (
            stage === "result"
              ? await f.journal.recordOperation(input)
              : await f.journal.append(input)
          ).record;
        }
        resume();
        await rejection;
        expect(await f.journal.read(current.plan.identity)).toEqual(current);
        expect(current.workspaceBlocked).toBe(writer !== "release");
        expect(Boolean(current.releaseReceipt)).toBe(writer === "release");
        expect(current.facts.result?.kind ?? null).toBe(writer === "result" ? "result" : null);
      } finally {
        resume();
        await rejection;
      }
    },
  );

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
