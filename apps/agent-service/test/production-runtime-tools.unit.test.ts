import type { RuntimeToolInvocation } from "@himawari-agent/application";
import { describe, expect, it, vi } from "vitest";
import { ProductionRuntimeTools } from "../src/production-runtime-tools.js";
import {
  runtimeToolFixture as fixture,
  identities,
  invocation,
  now,
} from "./runtime-tools.fixture.js";

async function exposed(f: ReturnType<typeof fixture>) {
  const tool = f.tool();
  await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
  return tool;
}

describe("ProductionRuntimeTools", () => {
  it("intersects configured resources with the qualified capability before dispatch", async () => {
    const f = fixture();
    const qualified = { ...f.options.ceiling, maxCpuTimeMs: 30, maxOutputBytes: 10000 };
    const maximumResourceCeiling = vi.fn(async () => qualified);
    const tool = new ProductionRuntimeTools({ ...f.options, maximumResourceCeiling });
    await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
    expect((await tool.execute(invocation)).outcome).toBe("succeeded");
    const execute = f.request.mock.calls.find(([message]) => message.type === "work.execute")?.[0];
    expect(execute).toMatchObject({
      payload: {
        resourceCeiling: {
          ...f.options.ceiling,
          maxCpuTimeMs: 30,
        },
      },
    });
    expect(maximumResourceCeiling).toHaveBeenCalledWith(invocation.capabilityRef, "1.0.0");
  });
  it("offers a path request without a Handle and never dispatches it before authorization exists", async () => {
    const f = fixture();
    const tool = f.tool();
    const descriptors = await tool.listAuthorized(invocation.runId, []);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      name: "read",
      definition: "builtin-read",
      capabilityHandleRef: null,
    });
    const call: RuntimeToolInvocation = {
      ...invocation,
      capabilityRef: "host.file.read",
      capabilityHandleRef: null,
      arguments: { path: "/test/中文.txt", offset: 1, limit: 10 },
    };
    expect(await tool.preflight(call)).toMatchObject({
      allowed: false,
      reasonCode: "FILE_READ_AUTHORIZATION_UNAVAILABLE",
    });
    // Calling execute directly must not bypass preflight.
    await expect(tool.execute(call)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.artifacts.size).toBe(0);
    expect(await f.tool().preflight(call)).toMatchObject({
      allowed: false,
      reasonCode: "FILE_READ_REQUEST_INVALID",
    });
    expect(
      await tool.preflight({ ...call, capabilityHandleRef: invocation.capabilityHandleRef }),
    ).toMatchObject({
      allowed: false,
      reasonCode: "GOVERNED_HANDLE_INVALID",
    });
  });

  it("does not mistake model-provided approval fields for execution authority", async () => {
    const f = fixture();
    const tool = await exposed(f);
    const call = {
      ...invocation,
      capabilityRef: "host.file.read",
      capabilityHandleRef: null,
      arguments: { path: "/test.txt", approved: true, capabilityHandleRef: "forged" },
    };
    expect(await tool.preflight(call)).toMatchObject({
      allowed: false,
      reasonCode: "FILE_READ_AUTHORIZATION_UNAVAILABLE",
    });
    await expect(tool.execute(call)).rejects.toThrow();
    expect(await tool.preflight({ ...call, capabilityRef: "shell" })).toMatchObject({
      allowed: false,
      reasonCode: "FILE_READ_REQUEST_INVALID",
    });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("caps Worker execution at the parent Run deadline and rejects expired calls", async () => {
    const f = fixture();
    const tool = await exposed(f);
    await expect(tool.execute({ ...invocation, executionDeadlineAt: now })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    const deadline = new Date(Date.parse(now) + 500).toISOString();
    expect((await tool.execute({ ...invocation, executionDeadlineAt: deadline })).outcome).toBe(
      "succeeded",
    );
    const execute = f.request.mock.calls.find(([message]) => message.type === "work.execute")?.[0];
    expect(execute).toMatchObject({ type: "work.execute", payload: { deadlineAt: deadline } });
  });

  it("uses the delegated Worker and reads only an observed result; restart replays without dispatch", async () => {
    const f = fixture();
    const tool = await exposed(f);
    expect(await tool.preflight(invocation)).toMatchObject({ allowed: true });
    const result = await tool.execute(invocation);
    expect(result).toMatchObject({
      outcome: "succeeded",
      modelContent: "已读取结果",
      resultRef: "output:tools",
    });
    expect(f.request.mock.calls.map(([message]) => message.type)).toEqual([
      "work.delegate",
      "work.execute",
    ]);
    expect(await (await exposed(f)).execute(invocation)).toEqual(result);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("rejects expanded input, cross-Run and revoked handles without dispatch", async () => {
    const f = fixture();
    const tool = await exposed(f);
    for (const changed of [
      { ...invocation, arguments: { inputRef: "other" } },
      { ...invocation, runId: identities.runs.monitoring.id },
    ]) {
      expect(await tool.preflight(changed)).toMatchObject({ allowed: false });
      await expect(tool.execute(changed)).rejects.toThrow();
    }
    f.revoke();
    await expect(tool.execute(invocation)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it("admits at most one dispatch when independent executors race", async () => {
    const f = fixture();
    const first = await exposed(f);
    const second = await exposed(f);
    const results = await Promise.all([first.execute(invocation), second.execute(invocation)]);
    expect(results.some((result) => result.outcome === "succeeded")).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each(["unobserved", "wrong-scope", "hang", "revoke"] as const)(
    "never discloses an untrusted result (%s) or resends uncertain work",
    async (mode) => {
      const f = fixture(25);
      f.setMode(mode);
      const tool = await exposed(f);
      expect(await tool.execute(invocation)).toMatchObject({
        outcome: "result_unknown",
        resultRef: null,
      });
      f.setMode("success");
      if (mode === "revoke") await expect(exposed(f)).rejects.toThrow();
      else
        expect(await (await exposed(f)).execute(invocation)).toMatchObject({
          outcome: "result_unknown",
        });
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
  it("records a cancellation as failed", async () => {
    const f = fixture();
    f.setMode("cancelled");
    expect(await (await exposed(f)).execute(invocation)).toMatchObject({
      outcome: "failed",
      errorCode: "CANCELLED",
    });
  });
  it("denies disclosure of a previously successful result after revocation", async () => {
    const f = fixture();
    const tool = await exposed(f);
    await tool.execute(invocation);
    f.revoke();
    await expect(tool.execute(invocation)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("rechecks the live receipt before replaying a saved successful result", async () => {
    const f = fixture();
    const tool = await exposed(f);
    expect((await tool.execute(invocation)).outcome).toBe("succeeded");
    vi.spyOn(f.options.invocations, "read").mockResolvedValue(undefined);
    await expect(tool.execute(invocation)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("does not disclose output when the Handle is revoked during decryption", async () => {
    const f = fixture();
    const tool = await exposed(f);
    const original = f.options.protector.unprotect;
    vi.spyOn(f.options.protector, "unprotect").mockImplementation(async (input) => {
      const bytes = await original(input);
      if (input.payload.ref === "output:tools") f.revoke();
      return bytes;
    });
    expect(await tool.execute(invocation)).toMatchObject({
      outcome: "result_unknown",
      resultRef: null,
    });
  });
  it("rejects reuse of a call identity with changed arguments", async () => {
    const f = fixture();
    const tool = await exposed(f);
    await tool.execute(invocation);
    await expect(tool.execute({ ...invocation, dataClassification: "public" })).rejects.toThrow(
      "Tool call identity changed",
    );
    expect(f.request).toHaveBeenCalledTimes(2);
  });
});

it("exposes management as Pi extension definitions and sends no Worker request for status", async () => {
  const f = fixture();
  const execute = vi.fn(async () => ({
    outcome: "succeeded" as const,
    resultRef: "saved",
    errorCode: null,
    externalActionId: null,
    modelContent: "running",
  }));
  const tools = new ProductionRuntimeTools({
    ...f.options,
    managedTasks: { execute },
    taskHandle: async () => true,
  });
  const definitions = await tools.listAuthorized(invocation.runId, [
    invocation.capabilityHandleRef,
  ]);
  expect(definitions.map((definition) => definition.name)).toEqual(
    expect.arrayContaining([
      "execution_task_start",
      "execution_task_status",
      "execution_task_output",
      "execution_task_cancel",
    ]),
  );
  const call = {
    ...invocation,
    capabilityRef: "execution.task.status",
    capabilityHandleRef: null,
    arguments: { resourceRef: "task" },
  };
  expect((await tools.preflight(call)).allowed).toBe(true);
  expect((await tools.execute(call)).modelContent).toBe("running");
  expect(execute).toHaveBeenCalledWith(call);
  expect(f.request).not.toHaveBeenCalled();
  await expect(tools.execute(invocation)).rejects.toThrow("identity changed");
  expect(f.request).not.toHaveBeenCalled();
});

it.each([true, false, null])(
  "uses Agent verification for Worker result notification: %s",
  async (verified) => {
    const f = fixture();
    const completeSandboxToolResult = vi.fn(async (_input, delivery) => {
      await delivery.assertDisclosure();
      if (verified === null) return null;
      if (!verified) return undefined;
      const result = {
        outcome: "succeeded" as const,
        outputRef: "output:tools",
        errorCode: null,
        externalActionId: null,
      };
      await delivery.saveReceipt(result);
      return result;
    });
    const tool = new ProductionRuntimeTools({ ...f.options, completeSandboxToolResult });
    await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
    const result = await tool.execute(invocation);
    expect(result.outcome).toBe(verified === false ? "result_unknown" : "succeeded");
    expect(completeSandboxToolResult).toHaveBeenCalledTimes(1);
    expect(completeSandboxToolResult.mock.calls[0]?.[0]).toMatchObject({ runId: invocation.runId });
    expect([...f.artifacts.keys()].some((key) => key.startsWith("runtime-sandbox-delivery:"))).toBe(
      verified === true,
    );
  },
);

describe("runtime tool exposure and live authority", () => {
  it("rejects duplicate exposure references before looking up capabilities", async () => {
    const f = fixture();
    const read = vi.spyOn(f.options.capabilities, "getExecutionHandle");
    await expect(
      f
        .tool()
        .listAuthorized(invocation.runId, [
          invocation.capabilityHandleRef,
          invocation.capabilityHandleRef,
        ]),
    ).rejects.toThrow("not authorized");
    expect(read).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([
    ["ownerId", "other"],
    ["agentId", "other"],
    ["runId", "other"],
    ["revokedAt", now],
    ["workerEndedAt", now],
    ["expiresAt", "invalid"],
    ["issuedAt", "invalid"],
    ["issuedAt", "2999-01-01T00:00:00.000Z"],
    ["expiresAt", now],
    ["authorityFence", 2],
    ["capabilityVersion", "other"],
    ["handleVersion", "capability-handle.v1"],
  ])("withdraws exposure when live handle %s changes", async (key, value) => {
    const f = fixture();
    const tool = await exposed(f);
    const handle = await f.options.capabilities.getExecutionHandle(invocation.capabilityHandleRef);
    if (!handle) throw new Error("Missing handle fixture");
    vi.spyOn(f.options.capabilities, "getExecutionHandle").mockResolvedValue({
      ...handle,
      [key as string]: value,
    });
    expect(await tool.preflight(invocation)).toMatchObject({
      allowed: false,
      reasonCode: "GOVERNED_HANDLE_INVALID",
    });
    await expect(tool.execute(invocation)).rejects.toThrow("not authorized");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.artifacts.size).toBe(0);
  });
  it("withdraws exposure when the declaration is missing", async () => {
    const f = fixture();
    const tool = await exposed(f);
    vi.spyOn(f.options.capabilities, "get").mockResolvedValue(undefined);
    expect(await tool.preflight(invocation)).toMatchObject({ allowed: false });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(["invalid", now])(
    "rejects invalid or elapsed execution deadline %s",
    async (executionDeadlineAt) => {
      const f = fixture();
      const tool = await exposed(f);
      expect(await tool.preflight({ ...invocation, executionDeadlineAt })).toMatchObject({
        allowed: false,
        reasonCode: "GOVERNED_HANDLE_INVALID",
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it.each([{ inputRef: 3 }, { inputRef: "other" }, { inputRef: "input:tools", extra: true }, {}])(
    "does not broaden input authority %j",
    async (argumentsValue) => {
      const f = fixture();
      const tool = await exposed(f);
      expect(await tool.preflight({ ...invocation, arguments: argumentsValue })).toMatchObject({
        allowed: false,
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("rejects a higher data classification without creating execution artifacts", async () => {
    const f = fixture();
    const tool = await exposed(f);
    await expect(tool.execute({ ...invocation, dataClassification: "restricted" })).rejects.toThrow(
      "not authorized",
    );
    expect(f.request).not.toHaveBeenCalled();
    expect(f.artifacts.size).toBe(0);
  });
  it("does not turn authority storage failures into an ordinary permission refusal", async () => {
    const f = fixture();
    const tool = await exposed(f);
    vi.spyOn(f.options.capabilities, "getExecutionHandle").mockRejectedValue(
      new Error("storage-unavailable"),
    );
    await expect(tool.preflight(invocation)).rejects.toThrow("storage-unavailable");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("hides the built-in file reader when disabled", async () => {
    const f = fixture();
    const tool = new ProductionRuntimeTools({ ...f.options, fileReadEnabled: false });
    expect(await tool.listAuthorized(invocation.runId, [])).toEqual([]);
    expect(
      await tool.preflight({
        ...invocation,
        capabilityRef: "host.file.read",
        capabilityHandleRef: null,
        arguments: { path: "/test" },
      }),
    ).toMatchObject({ allowed: false, reasonCode: "FILE_READ_REQUEST_INVALID" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { capabilityHandleRef: "handle:tools" },
    { capabilityHandleRef: "handle:tools", inputRef: 3 },
    { capabilityHandleRef: "unexposed", inputRef: "input:tools" },
    { capabilityHandleRef: "handle:tools", inputRef: "input:tools", extra: true },
  ])("refuses task launch with malformed or unexposed authority %j", async (argumentsValue) => {
    const f = fixture();
    const tool = await exposed(f);
    const call = {
      ...invocation,
      capabilityRef: "execution.task.start",
      capabilityHandleRef: null,
      arguments: argumentsValue,
    };
    await expect(tool.preflight(call)).rejects.toThrow("not authorized");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.artifacts.size).toBe(0);
  });
  it("refuses to promote a foreground Handle into a managed task", async () => {
    const f = fixture();
    const tool = new ProductionRuntimeTools({ ...f.options, taskHandle: async () => false });
    await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
    await expect(
      tool.preflight({
        ...invocation,
        capabilityRef: "execution.task.start",
        capabilityHandleRef: null,
        arguments: { capabilityHandleRef: invocation.capabilityHandleRef, inputRef: "input:tools" },
      }),
    ).rejects.toThrow("not authorized");
    expect(f.request).not.toHaveBeenCalled();
  });
});
