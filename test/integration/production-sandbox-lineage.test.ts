import { createHash } from "node:crypto";
import type { SandboxExecutionRecord, WorkerExecuteRequest } from "@himawari-agent/application";
import {
  executionV2MessageSchema,
  type SandboxOperationBinding,
  sandboxExecutionFactsSchema,
} from "@himawari-agent/execution-contracts";
import { afterEach, describe, expect, it } from "vitest";
import messages from "../../packages/execution-contracts/test/fixtures/v2/messages.json" with {
  type: "json",
};
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import { sandboxV2Admission } from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  grantHandle,
  OWNER_ID,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

type Fixture = Awaited<ReturnType<typeof productionSandboxScope>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const descriptor: SandboxOperationBinding = {
  operation: "read",
  mode: "foreground",
  contract: { ref: "read", version: "1", kind: "fixed_read" },
  backendRef: "srt",
  scopeSource: "grant_targets",
  directoryOperations: ["read"],
  network: "disabled",
};
function request(causationId: string | null): WorkerExecuteRequest {
  const value = executionV2MessageSchema.parse({
    ...messages.find((item) => item.type === "work.execute"),
    causationId,
  });
  if (value.type !== "work.execute") throw new Error("Expected work.execute fixture");
  return value;
}
async function fixture(legacyFileRead = false, fileWorkflow = false) {
  const f = await productionSandboxScope(
    { ...descriptor, scopeSource: fileWorkflow ? "file_workflow" : "grant_targets" },
    undefined,
    { legacyFileRead },
  );
  cleanups.push(f.close);
  return f;
}
async function startParent(f: Fixture, controlled = true): Promise<SandboxExecutionRecord> {
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared)) throw new Error("Expected v2 reservation");
  const reserved = await f.services.brokerV2.preparations.reserve({
    ...prepared,
    invocation: f.input,
  });
  if (reserved.admission.phase !== "reserved") throw new Error("Expected reservation");
  const { plan, reservation } = reserved.admission;
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
  const initial = sandboxExecutionFactsSchema.parse({
    ...base,
    environment,
    resource: {
      ...base.resource,
      creator: plan.identity,
      environmentId: plan.environmentId,
      scopeDigest: plan.binding.scopeDigest,
      resourceRef: reservation.resourceRef,
      sequence: 2,
    },
  });
  const bound = await f.services.brokerV2.preparations.bindAndStart({
    identity: plan.identity,
    expectedSequence: 1,
    facts: initial,
    authority: f.input.authority,
    now: T1,
  });
  if (!controlled) return bound.record;
  // This supplies deterministic supervisor evidence at the journal's trusted
  // boundary. The test exercises scope inheritance, not OS isolation.
  const evidence = {
    ref: "supervision-lineage",
    digest: "e".repeat(64),
    qualificationRef: plan.binding.qualificationRef,
    profileRef: plan.binding.profileRef,
    validUntil: T2,
    subject: { kind: "local_process", processIdentityRef: "lineage-fixture-process" },
  };
  const facts = sandboxExecutionFactsSchema.parse({
    ...initial,
    resource: { ...initial.resource, sequence: 3, supervision: "controlled", evidence },
  });
  const record = bound.record;
  return (
    await f.repository.sandboxExecutionJournal(OWNER_ID, AGENT_ID).append({
      identity: plan.identity,
      expectedSequence: 2,
      expectedOperationRevision: record.operationRevision,
      facts,
      authority: f.input.authority,
      now: T1,
      context: {
        now: T1,
        environment,
        operationContract: plan.operationContract,
        verification: {
          facts,
          identity: plan.identity,
          environmentId: plan.environmentId,
          policyDigest: environment.policyDigest,
          resourceSequence: 3,
          checkedAt: T1,
          validUntil: T2,
          evidence: [evidence],
          outputs: [],
        },
        currentResourceSequence: 3,
        runState: "active",
        currentAuthority: true,
        currentFence: true,
        userDisclosureAllowed: true,
        modelDisclosureAllowed: true,
        conflictingWorkspaceRisk: false,
        pendingApprovalOrReconciliation: false,
        resultAlreadyDelivered: false,
      },
    })
  ).record;
}
async function handleUses(f: Fixture) {
  const handle = await f.repository
    .capabilityStore(OWNER_ID, AGENT_ID)
    .getExecutionHandle(f.input.handleRef);
  if (!handle || !("uses" in handle)) throw new Error("Expected governed execution handle");
  return handle.uses;
}
function childInput(f: Fixture) {
  return {
    ...f.input,
    invocationId: "child-invocation",
    receiptRef: "child-receipt",
    idempotencyKey: "child-key",
  };
}

describe("production sandbox file and delegation lineage", () => {
  it.each([false, true])(
    "binds a file read to its existing directory grant (legacy=%s)",
    async (legacy) => {
      const f = await fixture(legacy, !legacy);
      const prepared = await f.services.runtime.prepare(f.input, f.call);
      expect(prepared.plan.schemaVersion).toBe(
        legacy ? "sandbox-execution.v1" : "sandbox-execution.v2",
      );
      const scope = await f.services.runtime.scopes.read(prepared.plan, f.call.runId);
      expect(scope.directoryGrant).toMatchObject({
        ref: f.fileBinding.grant.id,
        revision: f.fileBinding.grant.revision,
        operations: ["read"],
      });
      expect(scope.networkAuthorizationRef).toBeNull();
      expect(prepared.plan.executionLease).toEqual(f.call.context?.executionLease);
      expect(prepared.plan.effectiveDeadlineAt <= f.fileBinding.grant.expiresAt).toBe(true);
      expect(await handleUses(f)).toBe(0);
    },
  );
  it.each([false, true])(
    "rejects a missing file binding before consuming authority (legacy=%s)",
    async (legacy) => {
      const f = await fixture(legacy, !legacy);
      f.setFileBindingAvailable(false);
      await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow(
        "SANDBOX_SCOPE_SOURCE_UNAVAILABLE",
      );
      expect(await handleUses(f)).toBe(0);
    },
  );
  it.each(["context", "deadline"])(
    "rejects a missing runtime %s before scope preparation",
    async (field) => {
      const f = await fixture();
      const { context, executionDeadlineAt, ...base } = f.call;
      if (!context || !executionDeadlineAt) throw new Error("Missing runtime fixture context");
      const call = field === "context" ? { ...base, executionDeadlineAt } : { ...base, context };
      await expect(f.services.runtime.prepare(f.input, call)).rejects.toThrow(
        "SANDBOX_SCOPE_SOURCE_UNAVAILABLE",
      );
    },
  );
  it("does not allow a caller to substitute the parent request", async () => {
    const f = await fixture();
    const prepared = await f.services.runtime.prepare(f.input, f.call);
    await expect(f.services.runtime.scopes.read(prepared.plan, "different-parent")).rejects.toThrow(
      "SANDBOX_PARENT_CHANGED",
    );
  });
  it("prepares a child with a fresh identity and inherited, bounded authority", async () => {
    const f = await fixture();
    const parent = await startParent(f);
    const child = await f.services.child.prepare(childInput(f), request(f.input.invocationId));
    expect(child.plan.identity).toMatchObject({
      invocationId: "child-invocation",
      toolCallId: "child-invocation",
      runId: parent.plan.identity.runId,
      hostId: parent.plan.identity.hostId,
    });
    expect(child.plan.identity.jobId).not.toBe(parent.plan.identity.jobId);
    expect(child.plan.executionLease).toEqual(parent.plan.executionLease);
    expect(child.plan.resourceCeiling).toEqual(parent.plan.resourceCeiling);
    expect(child.plan.effectiveDeadlineAt <= parent.plan.effectiveDeadlineAt).toBe(true);
    const scope = await f.services.child.scopes.read(child.plan, f.input.invocationId);
    expect(scope.parentToolCallId).toBe(parent.plan.identity.toolCallId);
    expect(scope.directoryGrant.operations).toEqual(["read"]);
    expect(scope.networkAuthorizationRef).toBeNull();
    expect(
      await f.services.brokerV2.preparations.readAdmissionByInvocation({
        runId: f.call.runId,
        invocationId: "child-invocation",
      }),
    ).toBeUndefined();
    expect(await handleUses(f)).toBe(1);
  });
  it.each(["absent", "unknown", "initializing", "expired"])(
    "refuses a child whose parent is %s",
    async (state) => {
      const f = await fixture();
      if (state === "initializing" || state === "expired")
        await startParent(f, state !== "initializing");
      if (state === "expired") f.setNow(T2);
      await expect(
        f.services.child.prepare(
          childInput(f),
          request(
            state === "absent" ? null : state === "unknown" ? "missing" : f.input.invocationId,
          ),
        ),
      ).rejects.toThrow("SANDBOX_PARENT_UNAVAILABLE");
    },
  );
  it("rejects child resource expansion while preserving the live parent", async () => {
    const f = await fixture();
    const parent = await startParent(f);
    await expect(
      f.services.child.prepare(
        {
          ...childInput(f),
          resourceCeiling: {
            ...f.input.resourceCeiling,
            maxOutputBytes: f.input.resourceCeiling.maxOutputBytes + 1,
          },
        },
        request(f.input.invocationId),
      ),
    ).rejects.toThrow("SANDBOX_CHILD_SCOPE_EXCEEDED");
    expect(
      (await f.repository.sandboxExecutionJournal(OWNER_ID, AGENT_ID).read(parent.plan.identity))
        ?.facts.resource.supervision,
    ).toBe("controlled");
  });
  it("rechecks revocation before returning a bound reservation replay", async () => {
    const f = await fixture();
    const parent = await startParent(f);
    const replay = await f.services.runtime.prepare(f.input, f.call);
    expect(replay.plan.identity).toEqual(parent.plan.identity);
    expect("reservation" in replay && replay.reservation.sequence).toBe(1);
    await f.repository
      .authorizationStore()
      .revokeGrant(f.input.authorizationRef ?? "", T1, "owner-requested");
    await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow();
  });
});

describe("production sandbox protected output and scope verification", () => {
  it("verifies an empty output observation without inventing result evidence", async () => {
    const f = await fixture();
    const record = await startParent(f, false);
    const proof = await f.services.brokerV2.evidence.verify({
      plan: record.plan,
      facts: record.facts,
      now: T1,
    });
    expect(proof).toMatchObject({
      identity: record.plan.identity,
      environmentId: record.plan.environmentId,
      checkedAt: T1,
      outputs: [],
      evidence: [],
    });
    expect(proof.validUntil > T1).toBe(true);
    await expect(f.services.brokerV2.resolveScope(record.plan)).resolves.toMatchObject({
      allowedDomains: [],
    });
    await expect(f.services.brokerV2.verifyStart(record.plan)).resolves.toBeUndefined();
  });
  it.each(["valid", "wrong-ref", "wrong-digest", "wrong-length", "wrong-effect"])(
    "requires exact invocation output bytes and provenance (%s)",
    async (change) => {
      const f = await fixture();
      const record = await startParent(f, false);
      const bytes = Buffer.from(JSON.stringify({ text: "Bound protected result" }));
      const payload = await f.f.protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: "output-lineage",
        dataClassification: "private",
        contentType: "application/json",
        plaintext: bytes,
        createdAt: T1,
      });
      await f.repository.capabilityInvocationResultPort(OWNER_ID, AGENT_ID).observeOutput({
        handleRef: record.plan.handleRef,
        invocationId: record.plan.identity.invocationId,
        authority: f.input.authority,
        now: T1,
        payload,
        plaintextByteLength: bytes.length,
      });
      const output = {
        ref: change === "wrong-ref" ? "unbound" : payload.ref,
        digest:
          change === "wrong-digest"
            ? "0".repeat(64)
            : createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.length + (change === "wrong-length" ? 1 : 0),
      };
      const facts = sandboxExecutionFactsSchema.parse({
        ...record.facts,
        result: {
          schemaVersion: "sandbox-execution.v2",
          identity: record.plan.identity,
          environmentId: record.plan.environmentId,
          policyDigest: record.facts.environment.policyDigest,
          occurredAt: T1,
          completion: { type: "value" },
          kind: "result",
          contract: {
            ref: record.plan.operationContract.ref,
            version: record.plan.operationContract.version,
          },
          output,
        },
        effect:
          change === "wrong-effect"
            ? {
                kind: "verified",
                verifierRef: "pi-write",
                verifierVersion: "1",
                targetRef: "file-target",
                occurredAt: T1,
                evidence: { ref: "other", digest: "0".repeat(64) },
              }
            : record.facts.effect,
      });
      const verify = f.services.brokerV2.evidence.verify({ plan: record.plan, facts, now: T1 });
      if (change === "valid")
        expect(await verify).toMatchObject({ outputs: [output], evidence: [] });
      else
        await expect(verify).rejects.toThrow(
          change === "wrong-ref"
            ? "SANDBOX_OUTPUT_BINDING_CHANGED"
            : change === "wrong-effect"
              ? "PI_WRITE_EVIDENCE_INVALID"
              : "SANDBOX_OUTPUT_CHANGED",
        );
      expect(await f.repository.payloadStore(OWNER_ID, AGENT_ID).get(payload.ref)).toEqual(payload);
    },
  );
  it("does not claim all resources released while an admission remains unbound", async () => {
    const f = await fixture();
    expect(await f.services.resources.stopRun(f.call.runId)).toEqual({ released: true });
    const prepared = await f.services.runtime.prepare(f.input, f.call);
    if (!("reservation" in prepared)) throw new Error("Expected reservation");
    await f.services.brokerV2.preparations.reserve({ ...prepared, invocation: f.input });
    expect(await f.services.resources.stopRun(f.call.runId)).toEqual({ released: false });
    expect(
      (
        await f.services.brokerV2.preparations.readAdmissionByInvocation({
          runId: f.call.runId,
          invocationId: f.input.invocationId,
        })
      )?.phase,
    ).toBe("reserved");
  });
  it("reports only installed capability limits and classifies foreground handles", async () => {
    const f = await fixture();
    expect(await f.services.maximumResourceCeiling("missing", "1")).toBeUndefined();
    expect(
      await f.services.maximumResourceCeiling(f.input.capabilityRef, f.input.capabilityVersion),
    ).toEqual(f.host.binding.maximumResourceCeiling);
    await expect(
      f.services.maximumResourceCeiling(f.input.capabilityRef, "different-version"),
    ).rejects.toThrow("SANDBOX_HOST_BINDING_UNAVAILABLE");
    const handle = {
      ...grantHandle(),
      operation: descriptor.operation,
      operations: [descriptor.operation],
    };
    expect(handle.ref).toBe(f.input.handleRef);
    expect(await f.services.taskHandle(handle)).toBe(false);
    expect(await f.services.taskHandle({ ...handle, capabilityRef: "missing" })).toBe(false);
  });
});

describe("legacy sandbox parent lineage", () => {
  it("admits one legacy parent and bounds child authority without relaunching it", async () => {
    const f = await fixture(true);
    const prepared = await f.services.runtime.prepare(f.input, f.call);
    if (!("observation" in prepared)) throw new Error("Expected legacy preparation");
    const parent = await f.services.broker.journal.admit({ ...prepared, invocation: f.input });
    await expect(f.services.child.prepare(childInput(f), request(null))).rejects.toThrow(
      "SANDBOX_PARENT_UNAVAILABLE",
    );
    await expect(f.services.child.prepare(childInput(f), request("missing"))).rejects.toThrow(
      "SANDBOX_PARENT_UNAVAILABLE",
    );
    await expect(
      f.services.child.prepare(childInput(f), request(f.input.invocationId)),
    ).rejects.toThrow("SANDBOX_PARENT_UNAVAILABLE");
    const observation = {
      ...parent.record.observation,
      sequence: 2,
      state: "starting" as const,
      policyDigest: "d".repeat(64),
      occurredAt: T1,
    };
    await f.services.broker.journal.append({ observation, authority: f.input.authority, now: T1 });
    const replay = await f.services.runtime.prepare(f.input, f.call);
    expect(replay.plan.identity).toEqual(parent.record.plan.identity);
    await expect(
      f.services.child.prepare(
        {
          ...childInput(f),
          resourceCeiling: {
            ...f.input.resourceCeiling,
            maxOutputBytes: f.input.resourceCeiling.maxOutputBytes + 1,
          },
        },
        request(f.input.invocationId),
      ),
    ).rejects.toThrow("SANDBOX_CHILD_SCOPE_EXCEEDED");
    const child = await f.services.child.prepare(childInput(f), request(f.input.invocationId));
    expect(child.plan.schemaVersion).toBe("sandbox-execution.v1");
    expect(child.plan.identity.invocationId).toBe("child-invocation");
    expect(child.plan.identity.jobId).not.toBe(parent.record.plan.identity.jobId);
    expect(child.plan.executionLease).toEqual(parent.record.plan.executionLease);
    expect(child.plan.effectiveDeadlineAt <= parent.record.plan.effectiveDeadlineAt).toBe(true);
    const scope = await f.services.child.scopes.read(child.plan, f.input.invocationId);
    expect(scope).toMatchObject({
      parentToolCallId: parent.record.plan.identity.toolCallId,
      parentRequestId: f.input.invocationId,
      networkAuthorizationRef: null,
    });
    expect(
      await f.services.broker.journal.readByInvocation({
        runId: f.call.runId,
        invocationId: "child-invocation",
      }),
    ).toBeUndefined();
    expect(await f.services.broker.journal.read(parent.record.plan.identity)).toMatchObject({
      observation: { state: "starting", sequence: 2 },
    });
    expect(await handleUses(f)).toBe(1);
    await expect(f.services.broker.resolveScope(parent.record.plan)).resolves.toMatchObject({
      allowedDomains: [],
    });
    await expect(f.services.broker.verifyStart(parent.record.plan)).resolves.toBeUndefined();
  });
});
