import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { gatewayV2MessageSchema, type GatewayV2Command } from "@himawari-agent/gateway-contracts";
import { createProductionWorkspaceCopies } from "../../apps/agent-service/src/production-workspace-copies.ts";
import { createProductionApprovalGateway } from "../../apps/agent-service/src/production-approval-gateway.ts";
import { createProductionFileReadServices } from "../../apps/agent-service/src/production-file-read-services.ts";
import { parseProductConfiguration } from "@himawari-agent/platform-node";
import { revokeFixtureDirectoryGrant } from "../fixtures/revoke-directory-grant.ts";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import {
  OWNER_ID,
  AGENT_ID,
  SERVICE_AUTHORITY,
  T1,
  T2,
  LIVE_SANDBOX,
  serviceRequest,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";
import { queuedLiveWorker } from "../fixtures/queued-live-worker.ts";

vi.mock("node:child_process", async (original) => {
  const processes = await original<typeof import("node:child_process")>();
  return {
    ...processes,
    fork: (...args: Parameters<typeof processes.fork>) => {
      const child = processes.fork(...args);
      child.stderr?.on("data", (bytes: Buffer) => {
        for (const line of bytes.toString().split("\n"))
          if (/^JOB_HOST_[A-Z0-9_]+$/.test(line)) console.info(line);
      });
      return child;
    },
  };
});

vi.mock("@himawari-agent/runtime-sandbox", async (original) => {
  const runtime = await original<typeof import("@himawari-agent/runtime-sandbox")>();
  return {
    ...runtime,
    prepareSandboxJobHost: (...args: Parameters<typeof runtime.prepareSandboxJobHost>) => {
      if (process.platform === "linux") {
        // Pinned SRT creates these UDS bridges under TMPDIR; Linux sun_path
        // allows 107 pathname bytes. Fail before starting the expensive job.
        const bridge = path.join(
          args[0].policy.privateDirectory,
          "claude-socks-0123456789abcdef.sock",
        );
        if (Buffer.byteLength(bridge) > 107) throw new Error("LIVE_COPY_BRIDGE_PATH_TOO_LONG");
      }
      const host = runtime.prepareSandboxJobHost(...args);
      void host.ready.catch((error: unknown) =>
        console.info("copy-jobhost-start-failure", String(error)),
      );
      void host.result.then((result) =>
        console.info(
          JSON.stringify({
            event: "copy-jobhost-result",
            reason: result.reason,
            exitCode: result.exitCode,
            stderr: Buffer.from(result.stderr).toString(),
          }),
        ),
      );
      return host;
    },
  };
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("persists Owner copy selection and rejects changed source authority through the installed control", async () => {
  const f = await productionSandboxScope(
    {
      operation: "bash",
      mode: "foreground",
      contract: { ref: "pi-coding-tool", version: "1", kind: "command" },
      backendRef: "srt",
      scopeSource: "grant_targets",
      directoryOperations: ["read", "create", "update"],
      network: "disabled",
    },
    undefined,
    { realFileIdentity: true, realRun: true },
  );
  cleanup.push(f.close);
  const baseConfiguration = parseProductConfiguration(
    JSON.parse(
      await readFile(
        new URL("./fixtures/file-summary/configuration.json", import.meta.url),
        "utf8",
      ),
    ),
    T1,
  );
  const configuration = {
    ...baseConfiguration,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    capabilityDeployment: f.capabilityDeployment,
    modelDescriptors: [f.model],
    runPolicy: {
      version: "copy-test",
      systemInstruction: "",
      memoryLimit: 1,
      maxSelectedMemories: 1,
      maxMemoryClassification: "private" as const,
      coding: {
        hostId: f.fileBinding.hostId,
        workerInstanceId: f.fileBinding.workerInstanceId,
        grantId: f.fileBinding.grant.id,
        capabilityRef: f.input.capabilityRef,
        capabilityVersion: f.input.capabilityVersion,
        maximumBytes: 4096,
        enabledTools: ["bash", "read", "write"] as const,
      },
    },
  };
  const make = () =>
    createProductionWorkspaceCopies({
      configuration,
      repository: f.repository,
      protector: f.f.protector,
      authority: () => SERVICE_AUTHORITY.lease,
      clock: { now: () => T1 },
    });
  let control = await make();
  if (!control) throw new Error("copy control missing");
  let allowed = true;
  const payloads = f.repository.payloadStore(OWNER_ID, AGENT_ID);
  const protect = async (ref: string, text: string) => {
    await payloads.put(
      await f.f.protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref,
        plaintext: Buffer.from(text),
        contentType: "text/plain",
        dataClassification: "private",
        createdAt: T1,
      }),
    );
    return ref;
  };
  const readJson = async (ref: string) => {
    const payload = await payloads.get(ref);
    if (!payload) throw new Error("missing payload");
    return JSON.parse(
      Buffer.from(
        await f.f.protector.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload }),
      ).toString(),
    );
  };
  const invoke = async (type: GatewayV2Command["type"], payload: unknown, id: string) => {
    const command = gatewayV2MessageSchema.parse({
      schemaVersion: "gateway.v2",
      kind: "command",
      type,
      messageId: id,
      correlationId: id,
      causationId: null,
      dataClassification: "private",
      risk: "high",
      authorizationRef: "owner-copy",
      scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
      authority: SERVICE_AUTHORITY.product,
      actor: { actorType: "owner", actorId: OWNER_ID },
      idempotencyKey: id,
      payload,
    });
    if (command.kind !== "command" || !control) throw new Error("invalid command");
    const gateway = createProductionApprovalGateway({
      configuration,
      repository: f.repository,
      authority: () => SERVICE_AUTHORITY.product,
      executionAuthority: () => SERVICE_AUTHORITY.lease,
      clock: { now: () => T1 },
      access: { authorize: async () => ({ allowed, reasonCode: "TEST_OWNER" }) },
      recentAuthentication: {
        assertRecentAuthentication: async () => {
          throw new Error("unused");
        },
      },
      workspaceCopies: control,
    });
    const result = await gateway.request(
      {
        ownerId: OWNER_ID,
        subjectId: OWNER_ID,
        deviceId: "copy-test",
        authenticatedAt: T1,
        authenticationRef: "owner-copy",
      },
      command,
    );
    if (!("resultRef" in result)) throw new Error("expected command result");
    return result;
  };
  await writeFile(path.join(f.host.workspace, "input.txt"), "owner current input");
  const pathRef = await protect("copy-test:path", "input.txt");
  const created = await invoke(
    "workspace.copy.create",
    {
      grantId: f.fileBinding.grant.id,
      expectedGrantRevision: 1,
      inputPathRefs: [pathRef],
      allowedPathRefs: [pathRef],
      spaceBudgetBytes: 4096,
    },
    "create-copy",
  );
  const copy = await readJson(created.resultRef);
  expect(await readFile(path.join(copy.workspaceRef, "input.txt"), "utf8")).toBe(
    "owner current input",
  );
  const threadId = f.call.context?.threadId;
  allowed = false;
  await expect(
    invoke(
      "workspace.copy.select",
      { threadId, workspaceRef: created.resultRef, expectedRevision: null },
      "denied-copy",
    ),
  ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
  allowed = true;
  const selected = await invoke(
    "workspace.copy.select",
    { threadId, workspaceRef: created.resultRef, expectedRevision: null },
    "select-copy",
  );
  expect(await readJson(selected.resultRef)).toMatchObject({
    revision: 1,
    workspaceRef: created.resultRef,
  });
  control = await make();
  expect(
    await invoke(
      "workspace.copy.select",
      { threadId, workspaceRef: created.resultRef, expectedRevision: null },
      "select-copy",
    ),
  ).toMatchObject({ replayed: true, resultRef: selected.resultRef });
  const stored = await f.repository.readScopedState(
    OWNER_ID,
    AGENT_ID,
    `workspace-copy-selection:${threadId}`,
  );
  expect(stored?.value).toMatchObject({
    workspaceRef: created.resultRef,
    grantId: f.fileBinding.grant.id,
    root: { canonicalPath: copy.workspaceRef },
  });
  const routing = createProductionFileReadServices({
    configuration,
    repository: f.repository,
    authority: () => SERVICE_AUTHORITY,
    clock: { now: () => T1 },
    ids: { next: () => "copy-test-id" },
  });
  const bash = { ...f.call, capabilityRef: `${f.input.capabilityRef}.bash` };
  expect(await routing.binding(bash)).toMatchObject({
    workspaceCopy: { canonicalPath: copy.workspaceRef },
    grant: { id: f.fileBinding.grant.id },
  });
  expect(
    await routing.binding({ ...bash, capabilityRef: `${f.input.capabilityRef}.write` }),
  ).toBeUndefined();
  await writeFile(path.join(copy.workspaceRef, "input.txt"), "candidate result");
  const prepared = await invoke(
    "workspace.copy.prepare",
    { workspaceRef: created.resultRef, pathRefs: [pathRef], expiresAt: T2 },
    "prepare-copy",
  );
  expect((await readJson(prepared.resultRef)).operationRefs).toHaveLength(1);
  expect(await readFile(path.join(f.host.workspace, "input.txt"), "utf8")).toBe(
    "owner current input",
  );
  await expect(
    invoke(
      "workspace.copy.select",
      { threadId: "foreign-thread", workspaceRef: created.resultRef, expectedRevision: null },
      "foreign-copy",
    ),
  ).rejects.toThrow();
  await expect(
    invoke(
      "workspace.copy.select",
      { threadId, workspaceRef: created.resultRef, expectedRevision: null },
      "stale-copy",
    ),
  ).rejects.toThrow();
  await invoke(
    "workspace.copy.select",
    { threadId, workspaceRef: null, expectedRevision: 1 },
    "clear-copy",
  );
  expect(
    (await f.repository.readScopedState(OWNER_ID, AGENT_ID, `workspace-copy-selection:${threadId}`))
      ?.value,
  ).toEqual({ workspaceRef: null });
  expect((await routing.binding(bash))?.workspaceCopy).toBeUndefined();
  await revokeFixtureDirectoryGrant(f.repository, f.fileBinding.grant.id, T1);
  await expect(
    invoke(
      "workspace.copy.select",
      { threadId, workspaceRef: created.resultRef, expectedRevision: 2 },
      "revoked-copy",
    ),
  ).rejects.toThrow();
});

it("keeps source and copy metadata outside a foreground Pi Bash job", async () => {
  const runtimeRoot = path.resolve(
    process.env["HIMAWARI_QUALIFY_INSTALLED_RUNTIME"] ?? "dist/node-runtime",
  );
  if (LIVE_SANDBOX) {
    const shell = await lstat(path.join(runtimeRoot, "pi-tools/bin/bash")).catch(() => null);
    if (!shell?.isFile() || shell.isSymbolicLink() || !(shell.mode & 0o111))
      throw new Error("LIVE_COPY_BASH_TOOLCHAIN_REQUIRED");
  }
  const f = await productionSandboxScope(
    {
      operation: "bash",
      mode: "foreground",
      contract: { ref: "pi-coding-tool", version: "1", kind: "command" },
      backendRef: "srt",
      scopeSource: "grant_targets",
      directoryOperations: ["read", "create", "update"],
      network: "disabled",
    },
    undefined,
    {
      workspaceCopy: true,
      realFileIdentity: true,
      directoryOperations: ["read"],
      ...(LIVE_SANDBOX
        ? {
            piRuntimeRoot: runtimeRoot,
            ...(process.env["HIMAWARI_LIVE_HOST_PARENT"]
              ? { liveHostParent: process.env["HIMAWARI_LIVE_HOST_PARENT"] }
              : {}),
          }
        : {}),
      resourceCeiling: {
        maxWallTimeMs: 60000,
        maxCpuTimeMs: 10000,
        maxMemoryBytes: 268435456,
        maxOutputBytes: 4096,
        maxProgressEvents: 10,
      },
      piParameters: {
        command:
          "printf 'candidate result' > copy-input.txt; if /bin/sh -c '/bin/cat ../../../../live-workspace/copy-input.txt'; then exit 91; fi; printf 'source-read-denied\n'; if /bin/sh -c 'echo corrupt >> ../../../../live-workspace/copy-input.txt'; then printf 'shadow-write-succeeded\n'; else printf 'source-write-denied\n'; fi; if /bin/cat ../manifest.json; then exit 93; fi; printf 'metadata-read-denied\n'; /bin/sh -c 'echo corrupt >> ../manifest.json' || :; printf 'copy-isolated'",
      },
    },
  );
  cleanup.push(f.close);
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared) || !f.workspaceCopy) throw new Error("missing copy preparation");
  expect(prepared.workspaces).toHaveLength(1);
  expect(prepared.workspaces[0]).toMatchObject({
    canonicalRootId: f.workspaceCopy.root.canonicalRootId,
    access: "write",
  });
  expect(
    path.resolve(f.workspaceCopy.root.canonicalPath, "../../../../live-workspace/copy-input.txt"),
  ).toBe(path.join(f.host.workspace, "copy-input.txt"));
  if (!LIVE_SANDBOX) return;
  const manifestPath = path.join(f.workspaceCopy.root.canonicalPath, "../manifest.json");
  const manifestBefore = await readFile(manifestPath);
  await f.services.brokerV2.preparations.reserve({ ...prepared, invocation: f.input });
  const live = await queuedLiveWorker(f, SERVICE_AUTHORITY);
  cleanup.push(live.close);
  const plan = prepared.plan;
  const base = serviceRequest();
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
  const outcome = admission?.phase === "bound" ? admission.record.facts.result : null;
  const outputRef = outcome && "output" in outcome ? outcome.output.ref : null;
  const payload = outputRef
    ? await f.repository.payloadStore(OWNER_ID, AGENT_ID).get(outputRef)
    : undefined;
  const output = payload
    ? Buffer.from(
        await f.f.protector.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload }),
      ).toString()
    : null;
  console.info(
    JSON.stringify({
      event: "copy-live-result",
      result,
      phase: admission?.phase,
      facts: admission?.phase === "bound" ? admission.record.facts : null,
      output,
    }),
  );
  expect(
    await readFile(path.join(f.workspaceCopy.root.canonicalPath, "copy-input.txt"), "utf8"),
  ).toBe("candidate result");
  expect(await readFile(path.join(f.host.workspace, "copy-input.txt"), "utf8")).toBe(
    "current dirty input",
  );
  expect(await readFile(manifestPath)).toEqual(manifestBefore);
  expect(admission?.phase).toBe("bound");
  if (admission?.phase !== "bound") throw new Error("missing execution facts");
  expect(admission.record.facts.result).toMatchObject({
    kind: "result",
    completion: { type: "exit", exitCode: 0 },
  });
  expect(output).toContain("copy-isolated");
  expect(output).toContain("source-read-denied");
  expect(output).toContain("metadata-read-denied");
  expect(output).toMatch(/Operation not permitted|Permission denied|No such file or directory/);
  expect(result.outcome).not.toBe("failed");
  const evidence = process.env["HIMAWARI_P4_COPY_EVIDENCE"];
  if (evidence)
    await writeFile(
      evidence,
      JSON.stringify(
        {
          platform: process.platform,
          runtimeRoot,
          sourceReadOnly: true,
          sourceUnchanged: true,
          copyUpdated: true,
          originalContentHidden: true,
          manifestUnchanged: true,
          attemptedHostWrite: true,
          copyOnlyClaims: prepared.workspaces,
          result: admission.record.facts.result,
          resource: admission.record.facts.resource,
          output,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
}, 120000);
