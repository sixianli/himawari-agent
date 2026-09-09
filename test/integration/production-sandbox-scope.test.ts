import { appendFile, mkdir, rename } from "node:fs/promises";
import type { SandboxOperationBinding } from "@himawari-agent/execution-contracts";
import { afterEach, expect, it } from "vitest";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
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
    const send = await f.connect(admitted.admission.plan.identity);
    const scope = (await send({ kind: "resolve" })).resolvedScope;
    if (!scope) throw new Error("scope missing");
    expect(scope.allowedDomains).toEqual(["example.com"]);
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
