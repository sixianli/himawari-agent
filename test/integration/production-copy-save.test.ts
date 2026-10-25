import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DurableHostWorkspaceStateAdapter,
  FileOperationService,
  type IdempotentAgentCommand,
  type PreparedFileOperation,
  WorkspaceCopyService,
} from "@himawari-agent/application";
import {
  COPY_SAVE_VERIFIER,
  PI_COPY_SAVE_CONTRACT,
  sandboxScopeSchema,
} from "@himawari-agent/execution-contracts";
import {
  ConstrainedHostFileSystem,
  createWorkspaceCopyPublication,
  WorkspaceCopyStore,
} from "@himawari-agent/platform-node";
import { afterEach, expect, it, vi } from "vitest";
import { importProductionCopySave } from "../../apps/agent-service/src/production-copy-save.ts";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import { queuedLiveWorker } from "../fixtures/queued-live-worker.ts";
import {
  AGENT_ID,
  LIVE_SANDBOX,
  OWNER_ID,
  SERVICE_AUTHORITY,
  serviceRequest,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture(operation: "create" | "update" | "move" | "trash", dependency = false) {
  if (!LIVE_SANDBOX) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(T1));
  }
  let prepared: PreparedFileOperation | undefined;
  const f = await productionSandboxScope(
    {
      operation: "save_copy",
      mode: "foreground",
      backendRef: "srt",
      scopeSource: "grant_targets",
      network: "disabled",
      directoryOperations: ["read", "create", "update", "move", "trash"],
      contract: {
        ...PI_COPY_SAVE_CONTRACT,
        kind: "verified_effect",
        verifierRef: COPY_SAVE_VERIFIER.ref,
        verifierVersion: COPY_SAVE_VERIFIER.version,
        targetRef: COPY_SAVE_VERIFIER.targetRef,
      },
    },
    (value) => value,
    {
      realFileIdentity: true,
      directoryOperations: ["read", operation],
      piParameters: {},
      ...(LIVE_SANDBOX
        ? {
            piRuntimeRoot: path.resolve(
              process.env["HIMAWARI_QUALIFY_INSTALLED_RUNTIME"] ?? "dist/node-runtime",
            ),
            fixedFileCompletionQualification: true,
            ...(process.env["HIMAWARI_LIVE_HOST_PARENT"]
              ? { liveHostParent: process.env["HIMAWARI_LIVE_HOST_PARENT"] }
              : {}),
            resourceCeiling: {
              maxWallTimeMs: 60000,
              maxCpuTimeMs: 10000,
              maxMemoryBytes: 268435456,
              maxOutputBytes: 4096,
              maxProgressEvents: 10,
            },
          }
        : {}),
      prepareParameters: async ({ repository, grant, protect, readBytes }) => {
        const state = new DurableHostWorkspaceStateAdapter({
          read: (key) => repository.readScopedState(OWNER_ID, AGENT_ID, key),
          compareAndSet: async (input) =>
            (
              await repository.commitStateAndEvents({
                command: {
                  ownerId: OWNER_ID,
                  agentId: AGENT_ID,
                  authority: SERVICE_AUTHORITY.lease,
                  idempotencyKey: randomUUID() as IdempotentAgentCommand["idempotencyKey"],
                  commandType: "copy-test",
                  commandFingerprint: randomUUID(),
                },
                state: input,
                events: [],
                resultRef: input.key,
                committedAt: T1,
              })
            ).state,
        });
        const platform = new ConstrainedHostFileSystem();
        const hash = (value: string | Uint8Array) =>
          `sha256:${createHash("sha256").update(value).digest("hex")}`;
        const files = new FileOperationService({
          state,
          platform,
          hostId: grant.hostId,
          clock: { now: () => T1 },
          ids: { next: () => "copy-save-test" },
          digest: { digest: hash, digestCanonical: hash },
        });
        if (dependency) await writeFile(path.join(grant.displayPath, "dependency.txt"), "basis");
        if (operation !== "create")
          await writeFile(path.join(grant.displayPath, "save.txt"), "before");
        const copies = new WorkspaceCopyStore({
          candidateRoot: path.join(path.dirname(grant.displayPath), "copy-fixture"),
          protectPayload: protect,
        });
        const service = new WorkspaceCopyService({
          state,
          platform,
          files,
          copies,
          hostId: grant.hostId,
          clock: { now: () => T1 },
          ids: { next: () => "copy-source-test" },
          digest: { digest: hash, digestCanonical: hash },
          readPayload: readBytes,
        });
        const paths = [
          "save.txt",
          ...(operation === "move" ? ["moved.txt"] : []),
          ...(dependency ? ["dependency.txt"] : []),
        ];
        const copy = await service.create({
          grantId: grant.id,
          expectedGrantRevision: grant.revision,
          inputPaths: paths,
          allowedPaths: paths,
          spaceBudgetBytes: 4096,
        });
        if (operation === "move")
          await rename(path.join(copy, "save.txt"), path.join(copy, "moved.txt"));
        else if (operation === "trash") await unlink(path.join(copy, "save.txt"));
        else await writeFile(path.join(copy, "save.txt"), "after");
        const changes = await service.prepare({
          workspaceRef: copy,
          paths: operation === "move" ? ["save.txt", "moved.txt"] : ["save.txt"],
          expiresAt: T2,
        });
        expect(changes).toHaveLength(1);
        prepared = changes[0];
        if (!prepared) throw new Error("copy operation missing");
        expect(prepared.operation).toBe(operation);
        return { operationId: prepared.id, expectedHash: prepared.canonicalHash };
      },
    },
  );
  cleanups.push(f.close);
  return { f, prepared };
}
it.each(["create", "update", "move", "trash"] as const)(
  "admits Owner-prepared %s through the production queue and reuses fixed file execution",
  async (operation) => {
    const { f, prepared } = await fixture(operation);
    const candidate = await f.services.runtime.prepare(f.input, f.call);
    if (!("reservation" in candidate)) throw new Error("v2 required");
    await f.services.brokerV2.preparations.enqueue({ ...candidate, invocation: f.input });
    const admitted = await f.services.brokerV2.preparations.reserve({
      ...candidate,
      invocation: f.input,
    });
    if (admitted.admission.phase !== "reserved") throw new Error("reserved required");
    const scopePayload = LIVE_SANDBOX
      ? await f.repository.payloadStore(OWNER_ID, AGENT_ID).get(candidate.plan.binding.scopeRef)
      : undefined;
    const resolved =
      LIVE_SANDBOX && scopePayload
        ? {
            scope: sandboxScopeSchema.parse(
              JSON.parse(
                Buffer.from(
                  await f.f.protector.unprotect({
                    ownerId: OWNER_ID,
                    agentId: AGENT_ID,
                    payload: scopePayload,
                  }),
                ).toString(),
              ),
            ),
          }
        : (await (await f.connect(candidate.plan.identity))({ kind: "resolve" })).resolvedScope;
    if (!resolved || resolved.scope.schemaVersion !== "sandbox-scope.v1")
      throw new Error("scope required");
    expect(resolved.scope.directoryGrant.operations).toEqual(["read", operation]);
    const privateDirectory = path.join(f.host.binding.privateRoot, candidate.plan.identity.jobId);
    if (LIVE_SANDBOX) {
      const live = await queuedLiveWorker(f, SERVICE_AUTHORITY);
      cleanups.push(live.close);
      const plan = candidate.plan,
        base = serviceRequest();
      const result = await live.sandbox.execute({
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
      const admission = await f.services.brokerV2.preparations.readAdmission(plan.identity);
      console.info(
        JSON.stringify({
          event: "copy-save-live",
          operation,
          result,
          facts: admission?.phase === "bound" ? admission.record.facts : null,
        }),
      );
      expect(admission?.phase).toBe("bound");
      if (admission?.phase !== "bound") throw new Error("bound required");
      expect(admission.record.facts.effect.kind).toBe("verified");
      expect(admission.record.facts.result?.kind).toBe("result");
      expect(admission.record.facts.resource.supervision).toBe("released");
      const completion = await f.services.completeToolResult(
        { runId: plan.identity.runId, invocationId: plan.identity.invocationId },
        { assertDisclosure: async () => {}, saveReceipt: async () => {} },
      );
      expect(completion?.outcome).toBe("succeeded");
      if (process.env["HIMAWARI_P4_SAVE_EVIDENCE"])
        await writeFile(
          process.env["HIMAWARI_P4_SAVE_EVIDENCE"],
          JSON.stringify(
            {
              platform: process.platform,
              operation,
              result,
              completion,
              facts: admission.record.facts,
            },
            null,
            2,
          ),
          { flag: "wx" },
        );
    } else {
      await mkdir(privateDirectory, { mode: 0o700 });
      const journal = await createWorkspaceCopyPublication({
        scope: resolved.scope,
        workspace: f.fileBinding.grant.displayPath,
        privateDirectory,
      });
      const restage = vi
        .spyOn(ConstrainedHostFileSystem.prototype, "stagePublication")
        .mockRejectedValue(new Error("must prepare before admission"));
      expect(await journal.execute()).toMatchObject({
        operationId: prepared?.id,
        status: "verified",
      });
      expect(restage).not.toHaveBeenCalled();
      restage.mockRestore();
    }
    const imported = await importProductionCopySave({
      scope: resolved.scope,
      workspace: f.fileBinding.grant.displayPath,
      privateDirectory,
      repository: f.repository,
      authority: SERVICE_AUTHORITY.lease,
      now: T1,
    });
    expect(imported?.operation.status).toBe("verified");
    expect(
      (
        await f.repository.readScopedState(
          OWNER_ID,
          AGENT_ID,
          `host-workspace:file-operation:${prepared?.id}`,
        )
      )?.value["status"],
    ).toBe("verified");
    const target = path.join(
      f.fileBinding.grant.displayPath,
      operation === "move" ? "moved.txt" : "save.txt",
    );
    if (operation === "trash")
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(target, "utf8")).toBe(operation === "move" ? "before" : "after");
    const reopened = await createWorkspaceCopyPublication({
      scope: resolved.scope,
      workspace: f.fileBinding.grant.displayPath,
      privateDirectory,
    });
    expect(reopened.retained()?.operation.status).toBe("verified");
    await writeFile(target, "later owner edit");
    await importProductionCopySave({
      scope: resolved.scope,
      workspace: f.fileBinding.grant.displayPath,
      privateDirectory,
      repository: f.repository,
      authority: SERVICE_AUTHORITY.lease,
      now: T1,
    });
    expect(await readFile(target, "utf8")).toBe("later owner edit");
    await expect(reopened.execute()).rejects.toThrow("COPY_SAVE_ALREADY_STARTED");
  },
  120000,
);

it.each(["dependency", "target", "cancel", "revoke"] as const)(
  "does not save after queued %s changes",
  async (change) => {
    const { f } = await fixture("update", true);
    const candidate = await f.services.runtime.prepare(f.input, f.call);
    if (!("reservation" in candidate)) throw new Error("v2 required");
    expect(candidate.workspaces).toHaveLength(2);
    expect(
      candidate.workspaces.every(
        (claim) => claim.access === "write" && claim.file?.atomicPublish === false,
      ),
    ).toBe(true);
    await f.services.brokerV2.preparations.enqueue({ ...candidate, invocation: f.input });
    if (change === "cancel")
      await f.services.brokerV2.preparations.cancelQueued({
        identity: candidate.plan.identity,
        authority: SERVICE_AUTHORITY,
        now: T1,
      });
    else if (change === "revoke") {
      const { revokeFixtureDirectoryGrant } = await import("../fixtures/revoke-directory-grant.ts");
      await revokeFixtureDirectoryGrant(f.repository, f.fileBinding.grant.id, T1);
    } else
      await writeFile(
        path.join(
          f.fileBinding.grant.displayPath,
          change === "target" ? "save.txt" : "dependency.txt",
        ),
        "changed by owner",
      );
    await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow();
    expect(await readFile(path.join(f.fileBinding.grant.displayPath, "save.txt"), "utf8")).toBe(
      change === "target" ? "changed by owner" : "before",
    );
    expect(
      (
        await f.repository.readScopedState(
          OWNER_ID,
          AGENT_ID,
          "host-workspace:file-operation:copy-save-test",
        )
      )?.value["status"],
    ).toBe("prepared");
  },
);

it.each(["create", "update", "move", "trash"] as const)(
  "recovers %s after the file effect but before its final checkpoint without replay",
  async (operation) => {
    const { f } = await fixture(operation);
    const candidate = await f.services.runtime.prepare(f.input, f.call);
    if (!("reservation" in candidate)) throw new Error("v2 required");
    const admitted = await f.services.brokerV2.preparations.reserve({
      ...candidate,
      invocation: f.input,
    });
    if (admitted.admission.phase !== "reserved") throw new Error("reserved required");
    const resolved = await f.services.brokerV2.resolveScope(admitted.admission.plan);
    if (resolved.scope.schemaVersion !== "sandbox-scope.v1") throw new Error("scope required");
    const context = {
      scope: resolved.scope,
      workspace: f.fileBinding.grant.displayPath,
      privateDirectory: path.join(f.host.binding.privateRoot, candidate.plan.identity.jobId),
    };
    await mkdir(context.privateDirectory, { mode: 0o700 });
    const method =
      operation === "move" ? "move" : operation === "trash" ? "trash" : "publishPrepared";
    const original = ConstrainedHostFileSystem.prototype[method];
    const fault = vi
      .spyOn(ConstrainedHostFileSystem.prototype, method)
      .mockImplementation(async function (this: ConstrainedHostFileSystem, ...args: unknown[]) {
        await Reflect.apply(original, this, args);
        throw new Error("SIMULATED_LOST_FINAL_CHECKPOINT");
      });
    await expect((await createWorkspaceCopyPublication(context)).execute()).rejects.toThrow(
      "SIMULATED_LOST_FINAL_CHECKPOINT",
    );
    fault.mockRestore();
    const recovered = await createWorkspaceCopyPublication(context);
    expect(recovered.retained()?.operation.status).toBe("executing");
    await recovered.recover();
    expect(recovered.retained()?.operation.status).toBe("verified");
    const target = path.join(context.workspace, operation === "move" ? "moved.txt" : "save.txt");
    if (operation === "trash")
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(target, "utf8")).toBe(operation === "move" ? "before" : "after");
    await writeFile(target, "new owner version");
    await recovered.recover();
    expect(await readFile(target, "utf8")).toBe("new owner version");
    await importProductionCopySave({
      ...context,
      repository: f.repository,
      authority: SERVICE_AUTHORITY.lease,
      now: T1,
      recover: true,
    });
    expect(
      (
        await f.repository.readScopedState(
          OWNER_ID,
          AGENT_ID,
          "host-workspace:file-operation:copy-save-test",
        )
      )?.value["status"],
    ).toBe("verified");
  },
);
it("retains a changed dependency as a known pre-publication conflict", async () => {
  const { f } = await fixture("update", true);
  const candidate = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in candidate)) throw new Error("v2 required");
  const payload = await f.repository
    .payloadStore(OWNER_ID, AGENT_ID)
    .get(candidate.plan.binding.scopeRef);
  if (!payload) throw new Error("scope missing");
  const scope = sandboxScopeSchema.parse(
    JSON.parse(
      Buffer.from(
        await f.f.protector.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload }),
      ).toString(),
    ),
  );
  const context = {
    scope,
    workspace: f.fileBinding.grant.displayPath,
    privateDirectory: path.join(f.host.binding.privateRoot, candidate.plan.identity.jobId),
  };
  await mkdir(context.privateDirectory, { mode: 0o700 });
  await writeFile(path.join(context.workspace, "dependency.txt"), "new dependency");
  const journal = await createWorkspaceCopyPublication(context);
  const proof = await journal.execute().catch((error) => journal.conflicted(error));
  expect(proof.status).toBe("not_started");
  expect((await createWorkspaceCopyPublication(context)).retained()?.conflict).toBe(true);
  expect(await readFile(path.join(context.workspace, "save.txt"), "utf8")).toBe("before");
});
