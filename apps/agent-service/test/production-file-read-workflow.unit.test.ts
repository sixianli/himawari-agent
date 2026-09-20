import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ApprovalService,
  type AutomaticActionReviewPort,
  type CapabilityManifest,
  type GovernedActionIntent,
  type GovernedGrantRecord,
  type HostDirectoryGrant,
  hostDirectoryGrantStateKey,
  type RuntimeToolInvocation,
} from "@himawari-agent/application";
import {
  ConstrainedHostFileSystem,
  parseProductConfiguration,
} from "@himawari-agent/platform-node";
import {
  InMemoryAuthorizationStore,
  InMemoryCapabilityRegistryStore,
} from "@himawari-agent/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeHostFileReadCapability } from "../src/capability-programs/host-file-read.js";
import { createProductionFileReadServices } from "../src/production-file-read-services.js";
import {
  type FileReadBinding,
  type FileReadExecutionContext,
  ProductionFileReadWorkflow,
} from "../src/production-file-read-workflow.js";
import { ProductionRuntimeTools } from "../src/production-runtime-tools.js";
import { invocation, now, runtimeToolFixture } from "./runtime-tools.fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(automaticReview?: AutomaticActionReviewPort, coding = false) {
  const base = runtimeToolFixture(10_000);
  const root = await mkdtemp(path.join(tmpdir(), "file-workflow-"));
  roots.push(root);
  await writeFile(path.join(root, "note.txt"), "独有记录：蓝鹭 731\n第二行：验收内容\n第三行\n");
  const platform = new ConstrainedHostFileSystem();
  const rootIdentity = await platform.inspectRoot(root);
  let grant: HostDirectoryGrant = {
    id: "directory:test",
    revision: 1,
    hostId: "mac:test",
    canonicalRootId: `${rootIdentity.device}:${rootIdentity.inode}`,
    displayPath: root,
    operations: coding ? ["read", "create", "update"] : ["read"],
    dataClassification: "private",
    disclosure: "model",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
    authorizationRef: "directory-approval:test",
    revokedAt: null,
    expiresAt: "2026-09-06T01:00:00.000Z",
  };
  const config = parseProductConfiguration(
    JSON.parse(
      await readFile(
        new URL(
          "../../../test/integration/fixtures/file-summary/configuration.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
    now,
  );
  const model = config.modelDescriptors.find(({ role }) => role === "primary");
  if (!model || !config.runPolicy) throw new Error("missing test config");
  const route = {
    hostId: grant.hostId,
    workerInstanceId: base.options.peer().workerInstanceId,
    grantId: grant.id,
    capabilityRef: "file:test",
    capabilityVersion: "1.0.0",
    maximumBytes: 4096,
  };
  const configuration = {
    ...config,
    ownerId: base.options.ownerId,
    agentId: base.options.agentId,
    runPolicy: {
      ...config.runPolicy,
      fileRead: route,
      ...(coding ? { coding: { ...route, enabledTools: ["read", "write", "edit"] as const } } : {}),
    },
  };
  const store = new InMemoryAuthorizationStore();
  const capabilities = new InMemoryCapabilityRegistryStore(undefined, store);
  const manifest: CapabilityManifest = {
    ...base.capability.declaration,
    ref: route.capabilityRef,
    manifestVersion: "capability.v2",
    operations: coding ? ["read", "write", "edit"] : ["inspect", "read", "disclose"],
    sourceIdentity: "test",
    artifact: {
      digest: "test",
      signatureStatus: "not_applicable",
      signerRef: null,
      rollbackArtifactRef: null,
    },
    scopes: {
      dataClassifications: ["public", "private"],
      filesystem: [root],
      secrets: [],
      network: [],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy", checkedAt: now },
    reviewedBy: null,
    reviewedAt: null,
    contractCompatibility: ["host-file.v1"],
    runtime: {
      kind: "program",
      argv: ["test-only"],
      environmentKeys: [],
      workdirRef: root,
      stdin: "protected_payload",
      stdout: "protected_payload",
      subprocesses: [],
      network: [],
      filesystem: [root],
    },
  };
  await capabilities.create({ ...base.capability, ref: manifest.ref, declaration: manifest });
  let at = now;
  const clock = { now: () => at };
  const call: RuntimeToolInvocation = {
    ...invocation,
    capabilityHandleRef: null,
    capabilityRef: "host.file.read",
    arguments: { path: "note.txt" },
    executionDeadlineAt: "2026-09-06T00:01:00.000Z",
    context: {
      threadId: "thread:test" as NonNullable<
        NonNullable<RuntimeToolInvocation["context"]>["threadId"]
      >,
      modelRef: model.ref,
      executionLease: {
        executionLeaseId: "execution:test" as NonNullable<
          RuntimeToolInvocation["context"]
        >["executionLease"]["executionLeaseId"],
        expectedLeaseRevision: 1,
        authorityLeaseId: base.options.authority().lease.leaseId,
        authorityFencingToken: 1,
        ...base.options.authority().product,
        consumerId: "consumer:test",
      },
    },
  };
  type Repository = Parameters<typeof createProductionFileReadServices>[0]["repository"];
  const assertHeld = vi.fn(async () => ({}));
  const readSource = vi.fn(async () => ({
    ownerId: base.options.ownerId,
    agentId: base.options.agentId,
    runId: call.runId,
    threadId: call.context?.threadId,
  }));
  const repository = {
    readScopedState: async (_ownerId: string, _agentId: string, key: string) =>
      key === hostDirectoryGrantStateKey(grant.id)
        ? { key, revision: grant.revision, value: grant }
        : undefined,
    capabilityStore: () => capabilities,
    authorizationStore: () => store,
    runExecutionSource: () => ({ read: readSource }),
    runDispatch: () => ({ assertHeld }),
  } as unknown as Repository;
  const services = createProductionFileReadServices({
    configuration,
    repository,
    authority: base.options.authority,
    clock,
    ids: base.options.ids,
    ...(automaticReview ? { automaticReview } : {}),
  });
  const approvals = new ApprovalService({ store, clock });
  const permitted = new Set(coding ? ["read", "write", "edit"] : ["inspect", "read", "disclose"]);
  const intents: GovernedActionIntent[] = [];
  const authorize = services.authorize;
  const respond = async (intent: GovernedActionIntent, approvalId: string) => {
    const approval = await store.getApproval(approvalId);
    if (!approval) throw new Error("approval missing");
    const approved: GovernedGrantRecord = {
      id: `grant:${approval.id}`,
      revision: 1,
      ownerId: intent.ownerId,
      agentId: intent.agentId,
      kind: "one_time",
      scope: {
        capabilityRef: intent.capabilityRef,
        capabilityVersion: intent.capabilityVersion,
        operations: [intent.operation],
        exactResourceRef: intent.resourceRef,
        resourcePrefixes: [],
        resourceIdentities: intent.resourceRefs,
        maxDataClassification: intent.dataClassification,
        sideEffects: [intent.sideEffect],
        maxCostMicrosPerUse: 0,
        maxFrequency: { count: 1, intervalMs: null },
        disclosure: intent.disclosure,
        recipients: intent.recipients,
        credentialOrAccessChange: false,
      },
      intentFingerprint: approval.semanticSnapshotHash,
      sourceApprovalRequestId: approval.id,
      validFrom: now,
      expiresAt: intent.expiresAt,
      maxUses: 1,
      uses: 0,
      maxTotalCostMicros: 0,
      spentCostMicros: 0,
      revokedAt: null,
      revocationReasonCode: null,
    };
    await approvals.respond({
      approvalRequestId: approval.id,
      expectedRevision: approval.revision,
      semanticSnapshotHash: approval.semanticSnapshotHash,
      response: { decision: "approved", grant: approved, recentAuthenticationRef: null },
    });
  };
  services.authorize = async (intent, signal) => {
    intents.push(intent);
    let decision = await authorize(intent, signal);
    if (decision.decision === "ASK" && permitted.has(intent.operation)) {
      await respond(intent, decision.approvalRequest.id);
      decision = await authorize(intent, signal);
    }
    return decision;
  };
  let beforePhase: ((phase: string) => Promise<void>) | undefined;
  const read = vi.spyOn(platform, "read");
  const inspect = vi.spyOn(platform, "inspect");
  base.setExecutor(async (request) => {
    await beforePhase?.(request.payload.operation);
    const payload = base.payloads.get(request.payload.inputRef);
    if (!payload) throw new Error("input missing");
    const input: unknown = JSON.parse(new TextDecoder().decode(payload.ciphertext));
    return executeHostFileReadCapability(input, {
      hostId: grant.hostId,
      workerInstanceId: route.workerInstanceId,
      platform,
      clock,
    });
  });
  const options = {
    ...base.options,
    clock,
    fileRead: services,
    ...(coding ? { coding: configuration.runPolicy.coding } : {}),
    capabilities,
    ceiling: { ...base.options.ceiling, maxOutputBytes: 4096 },
  };
  const open = async () => {
    const tool = new ProductionRuntimeTools(options);
    await tool.listAuthorized(call.runId, []);
    return tool;
  };
  return {
    ...base,
    root,
    call,
    options,
    services,
    store,
    capabilities,
    intents,
    permitted,
    read,
    inspect,
    open,
    assertHeld,
    readSource,
    setGrant: (change: Partial<HostDirectoryGrant>) => {
      grant = { ...grant, ...change };
    },
    setTime: (time: string) => {
      at = time;
    },
    beforePhase: (hook: NonNullable<typeof beforePhase>) => {
      beforePhase = hook;
    },
    approvals: () => store.listApprovals(options.ownerId, options.agentId),
    executeRequests: () =>
      base.request.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "work.execute"),
  };
}

describe("production file read workflow through the Worker transport", () => {
  it("binds both private phases to the original model tool checkpoint", async () => {
    const f = await fixture();
    if (!f.call.context) throw new Error("trusted context missing");
    const call = {
      ...f.call,
      context: { ...f.call.context, continuationRef: "checkpoint:read-tool" },
    };
    expect((await (await f.open()).execute(call)).outcome).toBe("succeeded");
    const phases = [...f.artifacts.values()].filter((value) =>
      value.operationKey.startsWith("runtime-tool-intent:"),
    );
    expect(phases).toHaveLength(2);
    for (const artifact of phases) {
      const payload = await f.options.payloads.get(artifact.payloadRef);
      if (!payload) throw new Error("payload missing");
      const bytes = await f.options.protector.unprotect({
        ownerId: artifact.ownerId,
        agentId: artifact.agentId,
        payload,
      });
      expect(JSON.parse(new TextDecoder().decode(bytes)).recovery).toEqual({
        version: "tool-batch-recovery.v1",
        continuationRef: "checkpoint:read-tool",
        toolCallId: call.toolCallId,
      });
    }
    expect(JSON.stringify(f.executeRequests())).not.toContain("checkpoint:read-tool");
  });

  it("issues separate single-use credentials and feeds real Pi read output back; restart replays both stages", async () => {
    const f = await fixture();
    const tool = await f.open();
    expect(await tool.preflight(f.call)).toMatchObject({
      allowed: true,
      reasonCode: "FILE_READ_WORKFLOW_REQUIRED",
    });
    const result = await tool.execute(f.call);
    expect(result).toMatchObject({
      outcome: "succeeded",
      modelContent: expect.stringContaining("独有记录：蓝鹭 731"),
    });
    expect(f.executeRequests().map(({ payload }) => payload.operation)).toEqual([
      "inspect",
      "read",
    ]);
    const [inspect, read] = f.executeRequests();
    expect(inspect?.payload.inputRef).not.toBe(read?.payload.inputRef);
    expect(inspect?.payload.capabilityHandleRef).not.toBe(read?.payload.capabilityHandleRef);
    for (const request of f.executeRequests()) {
      expect(
        await f.capabilities.getExecutionHandle(request.payload.capabilityHandleRef),
      ).toMatchObject({
        maxUses: 1,
        operation: request.payload.operation,
        inputRefs: [request.payload.inputRef],
      });
      expect(Date.parse(request.payload.deadlineAt)).toBeLessThanOrEqual(
        Date.parse(f.call.executionDeadlineAt as string),
      );
    }
    expect(await (await f.open()).execute(f.call)).toEqual(result);
    expect(f.executeRequests()).toHaveLength(2);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(await f.approvals()).toHaveLength(3);
    expect(f.intents.find(({ operation }) => operation === "disclose")).toMatchObject({
      disclosure: "named_recipients",
      finalRisk: "HIGH",
      recipients: [expect.stringContaining("model:openrouter:")],
    });
    expect(f.assertHeld).toHaveBeenCalled();
  });

  it("does not share an active execution promise with a different lease attempt", async () => {
    const f = await fixture();
    const tool = await f.open();
    const context = f.call.context;
    if (!context) throw new Error("Missing test context");
    const first = tool.execute(f.call);
    await expect(
      tool.execute({
        ...f.call,
        context: {
          ...context,
          executionLease: {
            ...context.executionLease,
            expectedLeaseRevision: context.executionLease.expectedLeaseRevision + 1,
          },
        },
      }),
    ).rejects.toThrow("Tool call identity changed");
    expect((await first).outcome).toBe("succeeded");
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it.each(["inspect", "read", "disclose"])(
    "requires an independent %s permission",
    async (operation) => {
      const f = await fixture();
      f.permitted.delete(operation);
      expect(await (await f.open()).execute(f.call)).toMatchObject({
        outcome: "awaiting_approval",
        approval: {
          approvalRequestId: expect.any(String),
          semanticSnapshotHash: expect.any(String),
        },
      });
      expect(f.read).not.toHaveBeenCalled();
      expect(f.executeRequests()).toHaveLength(operation === "inspect" ? 0 : 1);
      if (operation === "inspect") expect(f.inspect).not.toHaveBeenCalled();
      f.permitted.add(operation);
      expect(await (await f.open()).execute(f.call)).toMatchObject({ outcome: "succeeded" });
      expect(f.executeRequests()).toHaveLength(2);
    },
  );

  it.each(["../secret", "/outside/note.txt", "a/../note.txt", "~/note.txt", "note.txt\\escape"])(
    "rejects unsafe path %s before metadata dispatch",
    async (file) => {
      const f = await fixture();
      expect(
        await (await f.open()).execute({ ...f.call, arguments: { path: file } }),
      ).toMatchObject({ outcome: "failed", errorCode: "FILE_READ_PATH_OUTSIDE_SCOPE" });
      expect(f.request).not.toHaveBeenCalled();
      expect(f.inspect).not.toHaveBeenCalled();
    },
  );

  it("keeps model authority fields out of the operation input", async () => {
    const f = await fixture();
    expect(
      await (await f.open()).execute({
        ...f.call,
        arguments: { path: "note.txt", approved: true },
      }),
    ).toMatchObject({ errorCode: "FILE_READ_REQUEST_INVALID" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("keeps denied approval terminal and never probes the target", async () => {
    const f = await fixture();
    f.permitted.clear();
    await (await f.open()).execute(f.call);
    const [approval] = await f.approvals();
    if (!approval) throw new Error("approval missing");
    await new ApprovalService({ store: f.store, clock: f.options.clock }).respond({
      approvalRequestId: approval.id,
      expectedRevision: approval.revision,
      semanticSnapshotHash: approval.semanticSnapshotHash,
      response: { decision: "denied" },
    });
    f.permitted.add("inspect");
    expect(await (await f.open()).execute(f.call)).toMatchObject({ errorCode: "approval_denied" });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it.each([{ revokedAt: now }, { expiresAt: now }, { dataClassification: "restricted" as const }])(
    "rejects unavailable directory authority before dispatch: %o",
    async (change) => {
      const f = await fixture();
      f.setGrant(change);
      expect((await (await f.open()).execute(f.call)).outcome).toBe("failed");
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(["hostId", "relativePath", "identity", "extra"])(
    "rejects mismatched Worker metadata: %s",
    async (field) => {
      const f = await fixture();
      f.permitted.delete("read");
      await (await f.open()).execute(f.call);
      // Simulate a corrupted Worker result at the trusted payload boundary, before disclosure.
      const artifact = [...f.artifacts.values()].find(({ operationKey }) =>
        operationKey.startsWith("runtime-tool-result:"),
      );
      if (!artifact) throw new Error("result missing");
      const payload = f.payloads.get(artifact.payloadRef);
      if (!payload) throw new Error("payload missing");
      const result = JSON.parse(new TextDecoder().decode(payload.ciphertext));
      const target = JSON.parse(result.modelContent);
      if (field === "identity") target.identity.inode = "invalid";
      else if (field === "extra") target.extra = "unexpected";
      else target[field] = "wrong";
      result.modelContent = JSON.stringify(target);
      f.payloads.set(payload.ref, {
        ...payload,
        ciphertext: new TextEncoder().encode(JSON.stringify(result)),
      });
      expect(await (await f.open()).execute(f.call)).toMatchObject({
        errorCode: "FILE_READ_TARGET_INVALID",
      });
      expect(f.read).not.toHaveBeenCalled();
      expect(f.executeRequests()).toHaveLength(1);
    },
  );

  it("does not expose internally issued phase Handles as model authorities", async () => {
    const f = await fixture();
    const tool = await f.open();
    await tool.execute(f.call);
    const [inspect] = f.executeRequests();
    if (!inspect) throw new Error("inspect missing");
    const forged = {
      ...f.call,
      capabilityRef: inspect.payload.capabilityId,
      capabilityHandleRef: inspect.payload.capabilityHandleRef,
      arguments: { inputRef: inspect.payload.inputRef },
    };
    expect(await tool.preflight(forged)).toMatchObject({ allowed: false });
    await expect(tool.execute(forged)).rejects.toThrow();
    expect(f.executeRequests()).toHaveLength(2);
  });

  it("uses the original Pi line range semantics", async () => {
    const f = await fixture();
    const result = await (await f.open()).execute({
      ...f.call,
      arguments: { path: "note.txt", offset: 2, limit: 1 },
    });
    expect(result.outcome).toBe("succeeded");
    expect(result.modelContent).toContain("第二行：验收内容");
    expect(result.modelContent).not.toContain("蓝鹭 731");
    expect(result.modelContent).toContain("offset=3");
  });

  it("rejects a file replaced between inspect and read without reading the replacement", async () => {
    const f = await fixture();
    f.beforePhase(async (phase) => {
      if (phase === "read") {
        await rename(path.join(f.root, "note.txt"), path.join(f.root, "old.txt"));
        await writeFile(path.join(f.root, "note.txt"), "replacement");
      }
    });
    expect(await (await f.open()).execute(f.call)).toMatchObject({
      outcome: "failed",
      resultRef: null,
    });
    expect(f.read).not.toHaveBeenCalled();
    expect(await (await f.open()).execute(f.call)).toMatchObject({ outcome: "failed" });
    expect(f.executeRequests()).toHaveLength(2);
  });

  it.each(["missing", "symlink", "oversize"])(
    "does not issue a content read for %s targets",
    async (kind) => {
      const f = await fixture();
      if (kind === "missing") await rm(path.join(f.root, "note.txt"));
      if (kind === "symlink") {
        await rename(path.join(f.root, "note.txt"), path.join(f.root, "real.txt"));
        await symlink("real.txt", path.join(f.root, "note.txt"));
      }
      if (kind === "oversize") await writeFile(path.join(f.root, "note.txt"), "x".repeat(4097));
      expect(await (await f.open()).execute(f.call)).toMatchObject({
        outcome: "failed",
        resultRef: null,
      });
      expect(f.read).not.toHaveBeenCalled();
      expect(f.executeRequests()).toHaveLength(1);
    },
  );

  it("does not resume with changed grant revision, thread, model, or execution lease", async () => {
    const f = await fixture();
    f.permitted.delete("read");
    const tool = await f.open();
    await tool.execute(f.call);
    f.setGrant({ revision: 2 });
    expect(await tool.execute(f.call)).toMatchObject({ errorCode: "FILE_READ_CONTEXT_CHANGED" });
    expect(f.executeRequests()).toHaveLength(1);
    f.setGrant({ revision: 1 });
    const context = f.call.context;
    if (!context) throw new Error("test context missing");
    expect(
      await tool.execute({ ...f.call, context: { ...context, modelRef: "unconfigured" } }),
    ).toMatchObject({ errorCode: "FILE_READ_BINDING_UNAVAILABLE" });
    f.readSource.mockResolvedValueOnce({
      ...(await f.readSource()),
      threadId: "wrong-thread" as typeof context.threadId,
    });
    expect(await tool.execute(f.call)).toMatchObject({
      errorCode: "FILE_READ_BINDING_UNAVAILABLE",
    });
    f.assertHeld.mockRejectedValueOnce(new Error("lease expired"));
    await expect(tool.execute(f.call)).rejects.toThrow("lease expired");
    expect(f.read).not.toHaveBeenCalled();
  });

  it("stops at a cancelled Run between phases", async () => {
    const f = await fixture();
    const authorize = f.services.authorize;
    f.services.authorize = async (intent, signal) => {
      const decision = await authorize(intent, signal);
      if (intent.operation === "read")
        vi.mocked(f.options.assertRunActive).mockRejectedValue(new Error("RUN_NOT_ACTIVE"));
      return decision;
    };
    await expect((await f.open()).execute(f.call)).rejects.toThrow("RUN_NOT_ACTIVE");
    expect(f.executeRequests()).toHaveLength(1);
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each(["inspect", "read"])("does not resend an uncertain %s after restart", async (phase) => {
    const f = await fixture();
    const request = f.options.transport.request;
    f.options.transport = {
      ...f.options.transport,
      request: async (message) => {
        const response = await request(message);
        // The Worker has run, but the connection dies before an acknowledged result.
        if (message.type === "work.execute" && message.payload.operation === phase)
          throw new Error("test connection lost after execution");
        return response;
      },
    };
    expect(await (await f.open()).execute(f.call)).toMatchObject({ outcome: "result_unknown" });
    expect(await (await f.open()).execute(f.call)).toMatchObject({ outcome: "result_unknown" });
    expect(f.executeRequests()).toHaveLength(phase === "inspect" ? 1 : 2);
    expect(f.read).toHaveBeenCalledTimes(phase === "inspect" ? 0 : 1);
  });

  it("coalesces concurrent identical calls and rejects changed argument replay", async () => {
    const f = await fixture();
    const tool = await f.open();
    const [first, second] = await Promise.all([tool.execute(f.call), tool.execute(f.call)]);
    expect(first.outcome).toBe("succeeded");
    expect(second).toEqual(first);
    expect(
      await tool.execute({ ...f.call, arguments: { path: "note.txt", offset: 2 } }),
    ).toMatchObject({ errorCode: "FILE_READ_CONTEXT_CHANGED" });
    expect(f.executeRequests()).toHaveLength(2);
  });

  it("resumes an approved read under a fresh execution lease without repeating inspect", async () => {
    const f = await fixture();
    f.permitted.delete("read");
    expect(await (await f.open()).execute(f.call)).toMatchObject({ outcome: "awaiting_approval" });
    f.permitted.add("read");
    f.setTime(new Date(Date.parse(now) + 1000).toISOString());
    if (!f.call.context) throw new Error("Expected trusted runtime context");
    const resumed = {
      ...f.call,
      context: {
        ...f.call.context,
        continuationRef: "protected-resume",
        executionLease: Object.freeze({
          ...f.call.context.executionLease,
          expectedLeaseRevision: f.call.context.executionLease.expectedLeaseRevision + 1,
        }),
      },
    };
    expect(await (await f.open()).execute(resumed)).toMatchObject({ outcome: "succeeded" });
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.executeRequests()).toHaveLength(2);
  });

  it("does not execute pending approval after the shared deadline", async () => {
    const f = await fixture();
    f.permitted.delete("read");
    await (await f.open()).execute(f.call);
    f.setTime(f.call.executionDeadlineAt as string);
    expect(await (await f.open()).execute(f.call)).toMatchObject({
      errorCode: "FILE_READ_DEADLINE_REQUIRED",
    });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.executeRequests()).toHaveLength(1);
  });

  it("does not let a directory-only routing config become execution authority", async () => {
    const f = await fixture();
    f.permitted.clear();
    expect(await (await f.open()).execute(f.call)).toMatchObject({
      outcome: "awaiting_approval",
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(await f.capabilities.getExecutionHandle("model-supplied-handle")).toBeUndefined();
  });

  it("refuses disclosure after its grant is revoked following the read", async () => {
    const f = await fixture();
    f.beforePhase(async (phase) => {
      if (phase === "read") {
        f.permitted.delete("disclose");
        const grant = (await f.store.listGrants(f.options.ownerId, f.options.agentId)).find(
          ({ scope }) => scope.operations.includes("disclose"),
        );
        if (!grant) throw new Error("grant missing");
        await f.store.revokeGrant(grant.id, now, "test");
      }
    });
    const result = await (await f.open()).execute(f.call);
    expect(result.outcome).toBe("failed");
    expect(result.modelContent).not.toContain("蓝鹭 731");
    expect(result.resultRef).toBeNull();
  });
});

it("passes optional review through the production authority entry before any file dispatch", async () => {
  const review = vi.fn(async () => undefined);
  const f = await fixture({ maximumWaitMs: 1000, review });
  f.permitted.clear();
  expect(await (await f.open()).execute(f.call)).toMatchObject({ outcome: "awaiting_approval" });
  expect(review).toHaveBeenCalledTimes(1);
  expect(review.mock.calls[0]).toMatchObject([
    { policyVersion: "file-read.v1", intent: { operation: "inspect" } },
    expect.any(AbortSignal),
  ]);
  expect(f.executeRequests()).toEqual([]);
  expect(await f.approvals()).toHaveLength(1);
  expect(await (await f.open()).execute(f.call)).toMatchObject({ outcome: "awaiting_approval" });
  expect(review).toHaveBeenCalledTimes(1);
});

it("cancels production authorization review before opening confirmation or dispatching a file tool", async () => {
  const controller = new AbortController();
  let forwarded = false;
  const f = await fixture({
    maximumWaitMs: 1000,
    review: async (_input, signal) => {
      controller.abort();
      forwarded = signal.aborted;
    },
  });
  f.permitted.clear();
  expect(await (await f.open()).execute(f.call, { signal: controller.signal })).toMatchObject({
    outcome: "failed",
    errorCode: "action_cancelled",
    resultRef: null,
  });
  expect(forwarded).toBe(true);
  expect(await f.approvals()).toEqual([]);
  expect(await f.store.listGrants(f.options.ownerId, f.options.agentId)).toEqual([]);
  expect(f.executeRequests()).toEqual([]);
});

it.each(["known", "missing-diagnostic", "possibly-sent"])(
  "verifies durable file conflict after restart before new approval: %s",
  async (mode) => {
    const f = await fixture(undefined, true);
    const call = {
      ...f.call,
      capabilityRef: "file:test.write",
      arguments: { path: "note.txt", content: "mine" },
    };
    const unused = async (): Promise<never> => {
      throw new Error("unexpected reservation");
    };
    const prepare = vi.fn(async (): Promise<never> => {
      throw new Error("SANDBOX_FILE_VERSION_CHANGED");
    });
    const open = async () => {
      const tool = new ProductionRuntimeTools({
        ...f.options,
        sandbox: { journal: { admit: unused }, scopes: { read: unused }, prepare },
      });
      await tool.listAuthorized(call.runId, []);
      return tool;
    };
    const before = await readFile(path.join(f.root, "note.txt"), "utf8");
    const first = await (await open()).execute(call);
    const firstApproval = (await f.approvals())[0];
    if (!firstApproval) throw new Error("first approval missing");
    expect(first).toMatchObject({ outcome: "failed", errorCode: "FILE_VERSION_CONFLICT" });
    expect(f.request).not.toHaveBeenCalled();
    expect(await (await open()).execute(call)).toEqual(first);
    expect(prepare).toHaveBeenCalledOnce();
    f.permitted.delete("write");
    const regenerated = {
      ...call,
      toolCallId: "regenerated",
      fileConflictOf: call.toolCallId,
      arguments: { path: "note.txt", content: `${before}mine` },
    };
    if (mode !== "known") {
      const diagnostic = [...f.artifacts.values()].find((item) =>
        item.operationKey.startsWith("runtime-tool-diagnostic:"),
      );
      if (!diagnostic) throw new Error("diagnostic missing");
      if (mode === "missing-diagnostic") f.artifacts.delete(diagnostic.operationKey);
      else {
        const payload = f.payloads.get(diagnostic.payloadRef);
        if (!payload) throw new Error("diagnostic payload missing");
        const changed = {
          ...JSON.parse(new TextDecoder().decode(payload.ciphertext)),
          stage: "possibly_sent",
        };
        f.payloads.set(payload.ref, {
          ...payload,
          ciphertext: new TextEncoder().encode(JSON.stringify(changed)),
        });
      }
      expect(await (await open()).execute(regenerated)).toMatchObject({
        errorCode: "CODING_CONFLICT_REGENERATION_BLOCKED",
      });
      expect(prepare).toHaveBeenCalledOnce();
      expect(await f.approvals()).toHaveLength(1);
      return;
    }
    expect(await (await open()).execute(regenerated)).toMatchObject({
      outcome: "awaiting_approval",
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(await readFile(path.join(f.root, "note.txt"), "utf8")).toBe(before);
    const approvals = await f.approvals();
    expect(approvals).toHaveLength(2);
    expect(approvals[0]?.intentId).not.toBe(approvals[1]?.intentId);
    const lineageArtifact = [...f.artifacts.values()].find((item) =>
      item.operationKey.endsWith(":conflict-lineage"),
    );
    if (!lineageArtifact) throw new Error("lineage missing");
    const payload = f.payloads.get(lineageArtifact.payloadRef);
    if (!payload) throw new Error("lineage payload missing");
    expect(JSON.parse(new TextDecoder().decode(payload.ciphertext))).toMatchObject({
      previousToolCallId: call.toolCallId,
      previousIntentId: firstApproval.intentId,
      intentId: approvals.find((approval) => approval.id !== firstApproval.id)?.intentId,
      depth: 1,
    });
    f.permitted.add("write");
    expect(await (await open()).execute(regenerated)).toMatchObject({
      errorCode: "FILE_VERSION_CONFLICT",
    });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(f.request).not.toHaveBeenCalled();
  },
);

it("restores a known private inspection only after outer queue proof and validates its target", async () => {
  const f = await fixture();
  f.permitted.delete("read");
  expect(await (await f.open()).execute(f.call)).toMatchObject({ outcome: "awaiting_approval" });
  const values = new Map<string, unknown>();
  let inspection: import("@himawari-agent/application").RuntimeToolExecutionResult | undefined;
  for (const artifact of f.artifacts.values()) {
    const payload = f.payloads.get(artifact.payloadRef);
    if (!payload) continue;
    const value = JSON.parse(new TextDecoder().decode(payload.ciphertext));
    if (artifact.operationKey.startsWith("runtime-file-read:")) {
      const suffix = artifact.operationKey.split(":").slice(2).join(":");
      values.set(suffix, value);
    }
    if (artifact.operationKey.startsWith("runtime-tool-result:")) inspection = value;
  }
  if (!inspection || !f.call.context) throw new Error("inspection missing");
  const frozen = values.get("context") as { binding: FileReadBinding };
  const phase = vi.fn(async (..._args: Parameters<FileReadExecutionContext["phase"]>) => ({
    outcome: "succeeded" as const,
    resultRef: null,
    errorCode: null,
    externalActionId: null,
    modelContent: "read result",
  }));
  const restoreInspection = vi.fn(async () => inspection);
  const ctx: FileReadExecutionContext = {
    ownerId: f.options.ownerId,
    agentId: f.options.agentId,
    now: () => now,
    authorityFence: () => 2,
    workerInstanceId: () => frozen.binding.workerInstanceId,
    assertActive: async () => {},
    canResumeAuthority: async () => true,
    restoreInspection,
    load: async (key) => values.get(key),
    save: async (key, value) => {
      if (!values.has(key)) values.set(key, value);
      return { ref: `recovery:${key}`, value: values.get(key) };
    },
    phase,
  };
  f.permitted.add("read");
  const services = { ...f.services, binding: async () => frozen.binding };
  const workflow = new ProductionFileReadWorkflow(services);
  const resumed = {
    ...f.call,
    context: {
      ...f.call.context,
      continuationRef: "original-queue",
      executionLease: {
        ...f.call.context.executionLease,
        fencingToken: 2,
        authorityFencingToken: 2,
      },
    },
  };
  expect(await workflow.execute(resumed, ctx)).toMatchObject({ outcome: "succeeded" });
  expect(phase).toHaveBeenCalledTimes(1);
  expect(phase.mock.calls[0]?.[1]).toBe("read");
  if (inspection.outcome !== "succeeded") throw new Error("Expected completed inspection");
  const target = JSON.parse(inspection.modelContent);
  inspection = {
    ...inspection,
    modelContent: JSON.stringify({ ...target, relativePath: "different.txt" }),
  };
  expect(await workflow.execute(resumed, ctx)).toMatchObject({
    errorCode: "FILE_READ_TARGET_INVALID",
  });
  expect(phase).toHaveBeenCalledTimes(1);
  expect(
    await workflow.execute({ ...resumed, arguments: { path: "different.txt" } }, ctx),
  ).toMatchObject({ errorCode: "FILE_READ_CONTEXT_CHANGED" });
});
