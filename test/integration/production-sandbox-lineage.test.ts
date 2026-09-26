import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExecutionEnvironmentLifecyclePort,
  SandboxExecutionRecord,
  WorkerExecuteRequest,
} from "@himawari-agent/application";
import {
  executionV2MessageSchema,
  PI_FIXED_FILE_CONTRACT,
  PI_PREPARED_FILE_CONTRACT,
  PI_WRITE_VERIFIER,
  piFileRecoveryOperationKey,
  type SandboxOperationBinding,
  sandboxExecutionFactsSchema,
} from "@himawari-agent/execution-contracts";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import {
  ConstrainedHostFileSystem,
  createDirectoryMoveJournal,
  createPiFilePublicationJournal,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductionSandboxFileRecovery } from "../../apps/agent-service/src/production-sandbox-file-recovery.ts";
import messages from "../../packages/execution-contracts/test/fixtures/v2/messages.json" with {
  type: "json",
};
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import { sandboxV2Admission } from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  grantHandle,
  OWNER_ID,
  RUN_ID,
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
    if (scope.schemaVersion !== "sandbox-scope.v1") throw new Error("expected directory scope");
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
    expect(await f.services.resources.stopRun(f.call.runId, "run_cancelled")).toEqual({
      released: true,
    });
    const prepared = await f.services.runtime.prepare(f.input, f.call);
    if (!("reservation" in prepared)) throw new Error("Expected reservation");
    await f.services.brokerV2.preparations.reserve({ ...prepared, invocation: f.input });
    expect(await f.services.resources.stopRun(f.call.runId, "run_cancelled")).toEqual({
      released: false,
    });
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
  it("refuses a delegated child before admission when strict mode is on", async () => {
    const calls: string[] = [];
    const refuse = (name: string) => async (): Promise<never> => {
      calls.push(name);
      throw new Error("unexpected task environment call");
    };
    const lifecycle: ExecutionEnvironmentLifecyclePort = {
      capabilities: refuse("capabilities"),
      create: refuse("create"),
      inspect: refuse("inspect"),
      stop: refuse("stop"),
      verifyStopped: refuse("verifyStopped"),
      destroy: refuse("destroy"),
    };
    const f = await productionSandboxScope(descriptor, undefined, {
      taskEnvironments: { backendRef: "container-test", imageDigest: "b".repeat(64), lifecycle },
    });
    cleanups.push(f.close);
    await expect(
      f.services.child.prepare(childInput(f), request(f.input.invocationId)),
    ).rejects.toThrow("SANDBOX_STRICT_MODE_UNAVAILABLE");
    expect(
      await f.repository
        .sandboxJobJournal(OWNER_ID, AGENT_ID)
        .readByInvocation({ runId: RUN_ID, invocationId: "child-invocation" }),
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });

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

it("freezes the host file version and rejects changes while waiting", async () => {
  const f = await productionSandboxScope(
    { ...descriptor, contract: { ref: "pi-coding-tool", version: "2", kind: "fixed_read" } },
    undefined,
    { piParameters: { path: "file.txt" } },
  );
  cleanups.push(f.close);
  await writeFile(path.join(f.host.workspace, "file.txt"), "before");
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared)) throw new Error("Expected v2 reservation");
  expect(prepared.workspaces[0]?.file?.name).toBe("file.txt");
  const scope = await f.services.runtime.scopes.read(prepared.plan, f.call.runId);
  expect(scope.fileTarget?.before?.contentDigest).toBe(
    createHash("sha256").update("before").digest("hex"),
  );
  await writeFile(path.join(f.host.workspace, "file.txt"), "concurrent modification");
  await expect(f.services.runtime.scopes.read(prepared.plan, f.call.runId)).rejects.toThrow(
    "SANDBOX_FILE_VERSION_CHANGED",
  );
  const database = openQualifiedDatabase(path.join(f.f.resource.stateRoot, "product.sqlite"));
  try {
    expect(
      database.prepare("SELECT COUNT(*) AS n FROM capability_invocation_receipts").get(),
    ).toEqual({ n: 0 });
  } finally {
    database.close();
  }
});

describe("fixed file recovery into the original SQLite invocation", () => {
  it.each([
    "released",
    "still-running",
    "unbound-artifact",
    "wrong-invocation",
    "production",
    "production-directory",
  ])("requires release and bound durable output (%s)", async (scenario) => {
    const moving = scenario === "production-directory";
    const parameters = moving
      ? { path: "reports", destination: "recovered" }
      : { path: "recovered.txt", content: "candidate" };
    const targetPath = moving ? "recovered/note.txt" : "recovered.txt";
    const f = await productionSandboxScope(
      {
        ...descriptor,
        operation: moving ? "move_directory" : "write",
        directoryOperations: moving ? ["move"] : ["read", "create", "update"],
        contract: {
          ...PI_FIXED_FILE_CONTRACT,
          ...(moving ? { version: "4" } : {}),
          kind: "verified_effect",
          verifierRef: moving ? "host-directory-move" : PI_WRITE_VERIFIER.ref,
          verifierVersion: PI_WRITE_VERIFIER.version,
          targetRef: moving ? "pi-input:source-destination" : PI_WRITE_VERIFIER.targetRef,
        },
      },
      undefined,
      {
        piParameters: parameters,
        realFileIdentity: true,
        ...(moving ? { directoryOperations: ["read", "move"] as const } : {}),
      },
    );
    cleanups.push(f.close);
    if (moving) {
      await mkdir(path.join(f.host.workspace, "reports"));
      await writeFile(path.join(f.host.workspace, "reports/note.txt"), "candidate");
    }
    let record = await startParent(f, false);
    const { scope } = await f.services.brokerV2.resolveScope(record.plan);
    if (scope.schemaVersion !== "sandbox-scope.v1") throw new Error("expected directory scope");
    const privateDirectory = path.join(f.host.binding.privateRoot, record.plan.identity.jobId);
    await mkdir(privateDirectory, { mode: 0o700 });
    const grant = {
      ...f.f.directoryGrant,
      canonicalRootId: scope.directoryGrant.canonicalRootId,
      displayPath: f.host.workspace,
      operations: ["read", "create", "update"] as const,
    };
    const publication = moving
      ? undefined
      : createPiFilePublicationJournal({
          privateDirectory,
          workspace: f.host.workspace,
          scope,
          parametersJson: JSON.stringify({ path: "recovered.txt", content: "candidate" }),
        });
    const bytes = Buffer.from("candidate"),
      digest = createHash("sha256").update(bytes).digest("hex");
    const platform = new ConstrainedHostFileSystem();
    if (moving) {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(T1));
        await createDirectoryMoveJournal({
          scope,
          workspace: f.host.workspace,
          privateDirectory,
          directoryRenameExecutable: fileURLToPath(
            new URL(
              "../../dist/node-runtime/node_modules/@himawari-agent/platform-node/dist/files/rename-native",
              import.meta.url,
            ),
          ),
        }).execute();
      } finally {
        vi.useRealTimers();
      }
    } else {
      if (!publication) throw new Error("publication missing");
      await platform.createExclusive(grant, "recovered.txt", bytes, {
        beforePublish: (proof) =>
          publication.prepared({
            publication: proof,
            relativePath: "recovered.txt",
            byteLength: bytes.length,
            contentDigest: digest,
          }),
      });
    }
    // Preserve the native publication, but omit the Worker result in SQLite.
    const recoverOutput = vi.fn(async () => {
      if (!publication) throw new Error("directory recovery must use production composition");
      const proof = await publication.recover(grant);
      expect(proof).toMatchObject({ contentDigest: digest });
      const value = { recovered: proof };
      const encoded = Buffer.from(JSON.stringify(value));
      const key =
        scenario === "wrong-invocation"
          ? piFileRecoveryOperationKey("another-call")
          : piFileRecoveryOperationKey(record.plan.identity.invocationId);
      const saved = await f.persist(key, value);
      return {
        ref: scenario === "unbound-artifact" ? "missing-output" : saved.ref,
        digest: createHash("sha256").update(encoded).digest("hex"),
        byteLength: encoded.length,
      };
    });
    const supervision = {
      ref: "release-fixture",
      digest: "e".repeat(64),
      qualificationRef: record.plan.binding.qualificationRef,
      profileRef: record.plan.binding.profileRef,
      validUntil: T2,
      subject: { kind: "local_process", processIdentityRef: "test-process" },
    };
    const journal = f.repository.sandboxExecutionJournal(OWNER_ID, AGENT_ID);
    if (scenario !== "still-running") {
      for (const state of ["stopping", "released"] as const) {
        const resourceState = { ...record.facts.resource } as Record<string, unknown>;
        delete resourceState["reasonCode"];
        delete resourceState["evidence"];
        const facts = sandboxExecutionFactsSchema.parse({
          ...record.facts,
          resource: {
            ...resourceState,
            sequence: record.facts.resource.sequence + 1,
            supervision: state,
            cleanup: state === "released" ? "confirmed" : "pending",
            ...(state === "released"
              ? { evidence: supervision }
              : { reasonCode: "TEST_STOP_REQUESTED" }),
          },
        });
        record = (
          await journal.append({
            identity: record.plan.identity,
            expectedSequence: record.facts.resource.sequence,
            expectedOperationRevision: record.operationRevision,
            facts,
            authority: f.input.authority,
            now: T1,
            context: {
              now: T1,
              environment: record.facts.environment,
              operationContract: record.plan.operationContract,
              verification: {
                facts,
                identity: record.plan.identity,
                environmentId: record.plan.environmentId,
                policyDigest: facts.environment.policyDigest,
                resourceSequence: facts.resource.sequence,
                checkedAt: T1,
                validUntil: T2,
                outputs: [],
                evidence: [supervision],
              },
              currentResourceSequence: facts.resource.sequence,
              runState: "terminated",
              currentAuthority: false,
              currentFence: false,
              userDisclosureAllowed: false,
              modelDisclosureAllowed: false,
              conflictingWorkspaceRisk: false,
              pendingApprovalOrReconciliation: false,
              resultAlreadyDelivered: false,
            },
          })
        ).record;
      }
    }
    if (scenario === "production" || moving) {
      const delivery = {
        assertDisclosure: vi.fn(async () => {}),
        saveReceipt: vi.fn(async () => {}),
      };
      const request = {
        runId: record.plan.identity.runId,
        invocationId: record.plan.identity.invocationId,
      };
      const completed = await f.services.completeToolResult(request, delivery);
      expect(completed?.outcome).toBe("succeeded");
      expect(delivery.saveReceipt).toHaveBeenCalledTimes(1);
      const durable = await journal.read(record.plan.identity);
      expect(durable?.facts.effect.kind).toBe("verified");
      const uses = await handleUses(f);
      await writeFile(path.join(f.host.workspace, targetPath), "later edit");
      expect(await f.services.completeToolResult(request, delivery)).toEqual(completed);
      expect(await handleUses(f)).toBe(uses);
      expect(await readFile(path.join(f.host.workspace, targetPath), "utf8")).toBe("later edit");
      return;
    }
    const recover = createProductionSandboxFileRecovery({
      journal,
      authority: () => f.input.authority,
      now: () => T1,
      recoverOutput,
      // OS/process observation is the only synthetic evidence here. File records,
      // publication, encrypted artifacts and journal acceptance are real.
      verifyFresh: async (current) => {
        const facts = current.facts;
        return {
          facts,
          identity: current.plan.identity,
          environmentId: current.plan.environmentId,
          policyDigest: facts.environment.policyDigest,
          resourceSequence: facts.resource.sequence,
          checkedAt: T1,
          validUntil: T2,
          outputs: facts.result && facts.result.kind !== "unknown" ? [facts.result.output] : [],
          evidence: [
            supervision,
            ...(facts.effect.kind === "verified" ? [facts.effect.evidence] : []),
          ],
        };
      },
    });
    const uses = await handleUses(f);
    if (["unbound-artifact", "wrong-invocation"].includes(scenario)) {
      await expect(recover(record)).rejects.toThrow("durably bound");
      expect((await journal.read(record.plan.identity))?.facts.result).toBeNull();
    } else {
      const completed = await recover(record);
      if (scenario === "still-running") {
        expect(recoverOutput).not.toHaveBeenCalled();
        expect(completed.facts.result).toBeNull();
      } else {
        expect(completed.facts.result?.kind).toBe("result");
        expect(completed.facts.effect.kind).toBe("verified");
        expect(completed.releaseReceipt).toBeDefined();
        const after = await journal.read(record.plan.identity);
        expect(after?.operationRevision).toBe(completed.operationRevision);
        expect(after?.workspaceBlocked).toBe(false);
        expect(await recover(completed)).toEqual(completed);
        expect(recoverOutput).toHaveBeenCalledTimes(1);
      }
    }
    expect(await handleUses(f)).toBe(uses);
    expect(await readFile(path.join(f.host.workspace, targetPath), "utf8")).toBe("candidate");
  });
});

describe("prepared file admission", () => {
  it.each(["write", "edit"] as const)(
    "stages concurrent %s requests before occupancy and preserves their frozen candidates",
    async (tool) => {
      const f = await productionSandboxScope(
        {
          ...descriptor,
          operation: tool,
          directoryOperations: ["read", "create", "update"],
          contract: {
            ...PI_PREPARED_FILE_CONTRACT,
            kind: "verified_effect",
            verifierRef: PI_WRITE_VERIFIER.ref,
            verifierVersion: PI_WRITE_VERIFIER.version,
            targetRef: PI_WRITE_VERIFIER.targetRef,
          },
        },
        undefined,
        {
          resourceCeiling: {
            maxWallTimeMs: 10000,
            maxCpuTimeMs: 10000,
            maxMemoryBytes: 268435456,
            maxOutputBytes: 65536,
            maxProgressEvents: 10,
          },
          realFileIdentity: true,
          piParameters:
            tool === "write"
              ? { path: "file.txt", content: "candidate" }
              : { path: "file.txt", edits: [{ oldText: "before", newText: "candidate" }] },
        },
      );
      cleanups.push(f.close);
      const filename = path.join(f.host.workspace, "file.txt");
      await writeFile(filename, "before");
      const secondCall = { ...f.call, toolCallId: "second-preparation" };
      const secondId = `runtime-tool:${createHash("sha256")
        .update(JSON.stringify([secondCall.runId, secondCall.toolCallId]))
        .digest("hex")}`;
      const secondInput = {
        ...f.input,
        invocationId: secondId,
        idempotencyKey: secondId,
        receiptRef: "receipt-second-preparation",
      };
      await f.persist(`runtime-tool-intent:${secondId.slice("runtime-tool:".length)}`, {
        request: {
          messageId: secondId,
          causationId: secondCall.runId,
          payload: { inputRef: secondInput.inputRef, capabilityHandleRef: secondInput.handleRef },
        },
      });
      const database = openQualifiedDatabase(path.join(f.f.resource.stateRoot, "product.sqlite"));
      try {
        let ready!: () => void, proceed!: () => void;
        const arrived = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          proceed = resolve;
        });
        const original = ConstrainedHostFileSystem.prototype.stagePublication;
        let staged = 0;
        const interception = vi
          .spyOn(ConstrainedHostFileSystem.prototype, "stagePublication")
          .mockImplementation(async function (this: ConstrainedHostFileSystem, grant, bytes, mode) {
            const publication = await original.call(this, grant, bytes, mode);
            if (++staged <= 2) {
              if (staged === 2) ready();
              await barrier;
            }
            return publication;
          });
        const firstPromise = f.services.runtime.prepare(f.input, f.call);
        const secondPromise = f.services.runtime.prepare(secondInput, secondCall);
        const pending = Promise.all([firstPromise, secondPromise]);
        // Reject on setup failure rather than hiding it behind a barrier timeout.
        await Promise.race([
          arrived,
          pending.then(() => {
            throw new Error("preparation bypassed barrier");
          }),
        ]);
        expect(
          database.prepare("SELECT count(*) AS n FROM sandbox_workspace_occupancy").get(),
        ).toEqual({ n: 0 });
        expect(
          database.prepare("SELECT count(*) AS n FROM capability_invocation_receipts").get(),
        ).toEqual({ n: 0 });
        expect(await readFile(filename, "utf8")).toBe("before");
        proceed();
        const [first, second] = await pending;
        interception.mockRestore();
        if (!("reservation" in first) || !("reservation" in second))
          throw new Error("expected reservation candidates");
        const scope = await f.services.runtime.scopes.read(second.plan, f.call.runId);
        expect(scope.preparedFile).toBeDefined();
        if (!scope.preparedFile) throw new Error("missing prepared candidate");
        expect(await readFile(scope.preparedFile.content.identity.canonicalPath, "utf8")).toBe(
          "candidate",
        );
        expect(await f.services.runtime.prepare(secondInput, secondCall)).toEqual(second);
        await f.services.brokerV2.preparations.reserve({ ...first, invocation: f.input });
        await expect(
          f.services.brokerV2.preparations.reserve({ ...second, invocation: secondInput }),
        ).rejects.toThrow(/Workspace/);
        await f.services.brokerV2.preparations.enqueue({ ...second, invocation: secondInput });
        expect(
          database.prepare("SELECT count(*) AS n FROM capability_invocation_receipts").get(),
        ).toEqual({ n: 1 });
        await writeFile(filename, "external change");
        await expect(f.services.runtime.prepare(secondInput, secondCall)).rejects.toThrow(
          "SANDBOX_FILE_VERSION_CHANGED",
        );
        expect(await readFile(filename, "utf8")).toBe("external change");
        expect(await readFile(scope.preparedFile.content.identity.canonicalPath, "utf8")).toBe(
          "candidate",
        );
      } finally {
        vi.restoreAllMocks();
        database.close();
      }
    },
  );
});

it.each(["cancelled-before", "revoked-before", "stale-authority", "cancelled-during"])(
  "does not acquire occupancy or lose candidates when preparation authority changes (%s)",
  async (scenario) => {
    const f = await productionSandboxScope(
      {
        ...descriptor,
        operation: "write",
        directoryOperations: ["read", "create", "update"],
        contract: {
          ...PI_PREPARED_FILE_CONTRACT,
          kind: "verified_effect",
          verifierRef: PI_WRITE_VERIFIER.ref,
          verifierVersion: PI_WRITE_VERIFIER.version,
          targetRef: PI_WRITE_VERIFIER.targetRef,
        },
      },
      undefined,
      {
        resourceCeiling: {
          maxWallTimeMs: 10000,
          maxCpuTimeMs: 10000,
          maxMemoryBytes: 268435456,
          maxOutputBytes: 65536,
          maxProgressEvents: 10,
        },
        realFileIdentity: true,
        piParameters: { path: "file.txt", content: "candidate" },
      },
    );
    cleanups.push(f.close);
    const database = openQualifiedDatabase(path.join(f.f.resource.stateRoot, "product.sqlite"));
    try {
      const original = ConstrainedHostFileSystem.prototype.stagePublication;
      const stagedPaths: string[] = [];
      const intercepted = vi
        .spyOn(ConstrainedHostFileSystem.prototype, "stagePublication")
        .mockImplementation(async function (this: ConstrainedHostFileSystem, grant, bytes, mode) {
          const prepared = await original.call(this, grant, bytes, mode);
          stagedPaths.push(prepared.identity.canonicalPath);
          if (scenario === "cancelled-during")
            database.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(f.call.runId);
          return prepared;
        });
      if (scenario === "cancelled-before")
        database.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(f.call.runId);
      if (scenario === "revoked-before")
        database
          .prepare("UPDATE capability_handles SET revoked_at=? WHERE id=?")
          .run(T1, f.input.handleRef);
      const input =
        scenario === "stale-authority"
          ? { ...f.input, authority: { ...f.input.authority, workerBootId: "stale-boot" } }
          : f.input;
      await expect(f.services.runtime.prepare(input, f.call)).rejects.toThrow();
      if (scenario === "cancelled-during") {
        expect(stagedPaths).toHaveLength(2);
        expect(await readFile(stagedPaths[0] as string, "utf8")).toBe("candidate");
        expect(
          await f.artifacts().lookup({
            runId: f.call.runId,
            purpose: "trace",
            operationKey: `sandbox-scope:${f.input.invocationId}`,
          }),
        ).toBeDefined();
      } else expect(intercepted).not.toHaveBeenCalled();
      expect(
        database.prepare("SELECT count(*) AS n FROM sandbox_workspace_occupancy").get(),
      ).toEqual({ n: 0 });
      expect(
        database.prepare("SELECT count(*) AS n FROM capability_invocation_receipts").get(),
      ).toEqual({ n: 0 });
      await expect(readFile(path.join(f.host.workspace, "file.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      vi.restoreAllMocks();
      database.close();
    }
  },
);

it("freezes three directory resources and rejects a queued path replacement before admission", async () => {
  const f = await productionSandboxScope(
    {
      ...descriptor,
      operation: "move_directory",
      directoryOperations: ["move"],
      contract: {
        ref: "pi-coding-tool",
        version: "4",
        kind: "verified_effect",
        verifierRef: "host-directory-move",
        verifierVersion: "1",
        targetRef: "pi-input:source-destination",
      },
    },
    undefined,
    {
      realFileIdentity: true,
      directoryOperations: ["read", "move"],
      piParameters: { path: "reports", destination: "archive" },
    },
  );
  cleanups.push(f.close);
  await mkdir(path.join(f.host.workspace, "reports"));
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared)) throw new Error("expected reservation");
  expect(prepared.workspaces).toHaveLength(3);
  expect(prepared.reservation.workspaceConflictRefs).toHaveLength(3);
  await f.services.brokerV2.preparations.enqueue({ ...prepared, invocation: f.input });
  await rename(path.join(f.host.workspace, "reports"), path.join(f.host.workspace, "old"));
  await mkdir(path.join(f.host.workspace, "reports"));
  await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow(
    "DIRECTORY_MOVE_TARGET_CHANGED",
  );
  expect(
    (await f.services.brokerV2.preparations.readRunInventory({ runId: f.call.runId })).queue[0]
      ?.status,
  ).toBe("queued");
});
