import {
  ApplicationPortError,
  type PayloadRef,
  type RuntimeToolInvocation,
  ToolActionRegistry,
} from "@himawari-agent/application";
import {
  piFileRecoveryOperationKey,
  SANDBOX_TOOL_MEMORY_LIMIT_BYTES,
} from "@himawari-agent/execution-contracts";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ProductionHostReadOnlyInput,
  ProductionHostReadOnlyResult,
} from "../src/production-host-read.js";
import { ReminderInputError } from "../src/production-reminder-writer.js";
import { PRODUCTION_TOOL_ACTION_ROWS } from "../src/production-tool-actions.js";
import {
  type ProductionRuntimeSandbox,
  ProductionRuntimeTools,
  type ProductionRuntimeToolsOptions,
} from "../src/production-runtime-tools.js";
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
  it.each(["deadline", "revoked"] as const)(
    "stops waiting for a hung result verification after %s",
    async (mode) => {
      const f = fixture(mode === "deadline" ? 150 : 10_000);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const completeSandboxToolResult = vi.fn(async () => {
        await pending;
        return undefined;
      });
      const tool = new ProductionRuntimeTools({ ...f.options, completeSandboxToolResult });
      await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
      let outcome: Awaited<ReturnType<ProductionRuntimeTools["execute"]>> | undefined;
      const execution = tool.execute(invocation).then((value) => {
        outcome = value;
      });
      try {
        await vi.waitFor(() => expect(completeSandboxToolResult).toHaveBeenCalledOnce());
        if (mode === "revoked") f.revoke();
        await vi.waitFor(
          () => expect(outcome).toMatchObject({ outcome: "result_unknown", resultRef: null }),
          { timeout: 1000 },
        );
        expect(f.request.mock.calls.filter(([item]) => item.type === "work.execute")).toHaveLength(
          1,
        );
        expect(f.request.mock.calls.filter(([item]) => item.type === "work.cancel")).toHaveLength(
          mode === "revoked" ? 1 : 0,
        );
      } finally {
        release();
        await execution;
      }
    },
  );

  it("passes the active cancellation signal into preparation before Worker dispatch", async () => {
    const f = fixture();
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const unused = async (): Promise<never> => {
      throw new Error("unexpected admission");
    };
    const prepare = vi.fn<ProductionRuntimeSandbox["prepare"]>(
      async (_input, _call, _parent, signal): Promise<never> => {
        received = signal;
        controller.abort();
        signal?.throwIfAborted();
        throw new Error("preparation did not receive cancellation");
      },
    );
    const tool = new ProductionRuntimeTools({
      ...f.options,
      sandbox: {
        journal: { admit: unused },
        scopes: { read: unused },
        prepare,
      },
    });
    await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
    await tool.execute(invocation, { signal: controller.signal });
    expect(prepare).toHaveBeenCalledOnce();
    expect(received).toBe(controller.signal);
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["read", "write"])(
    "classifies pre-dispatch file version changes for %s and replays without dispatch",
    async (operation) => {
      const f = fixture();
      const unused = async (): Promise<never> => {
        throw new Error("unexpected admission");
      };
      const prepare = vi.fn(async (): Promise<never> => {
        throw new Error("SANDBOX_FILE_VERSION_CHANGED");
      });
      const tool = new ProductionRuntimeTools({
        ...f.options,
        capabilities: {
          ...f.options.capabilities,
          getExecutionHandle: async (ref) => {
            const handle = await f.options.capabilities.getExecutionHandle(ref);
            if (!handle) return undefined;
            return { ...handle, operation, operations: [operation] };
          },
        },
        sandbox: { journal: { admit: unused }, scopes: { read: unused }, prepare },
      });
      await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
      const result = await tool.execute(invocation);
      expect(result).toMatchObject({
        outcome: "failed",
        errorCode: operation === "write" ? "FILE_VERSION_CONFLICT" : "WORKER_NOT_DISPATCHED",
      });
      expect(result.modelContent.includes("重新读取")).toBe(operation === "write");
      expect(await tool.execute(invocation)).toEqual(result);
      expect(prepare).toHaveBeenCalledOnce();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("reports a tool refused by strict mode as not dispatched and unavailable in strict mode", async () => {
    const f = fixture();
    const unused = async (): Promise<never> => {
      throw new Error("unexpected admission");
    };
    const prepare = vi.fn(async (): Promise<never> => {
      throw new Error("SANDBOX_STRICT_MODE_UNAVAILABLE");
    });
    const tool = new ProductionRuntimeTools({
      ...f.options,
      sandbox: { journal: { admit: unused }, scopes: { read: unused }, prepare },
    });
    await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
    const result = await tool.execute(invocation);
    expect(result).toMatchObject({
      dispatchState: "not_sent",
      outcome: "failed",
      errorCode: "SANDBOX_STRICT_MODE_UNAVAILABLE",
    });
    expect(result.modelContent).toContain("严格模式");
    expect(result.modelContent).toContain("不要改用其他方式");
    expect(await tool.execute(invocation)).toEqual(result);
    expect(prepare).toHaveBeenCalledOnce();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("binds a protected recovery checkpoint before dispatch and preserves it on replay", async () => {
    const f = fixture();
    const call = {
      ...invocation,
      context: {
        threadId: null,
        modelRef: "model:test",
        continuationRef: "checkpoint:original",
        executionLease: {
          ...f.options.authority().product,
          executionLeaseId: "execution:test" as NonNullable<
            RuntimeToolInvocation["context"]
          >["executionLease"]["executionLeaseId"],
          authorityLeaseId: f.options.authority().lease.leaseId,
          authorityFencingToken: 1,
          expectedLeaseRevision: 1,
          consumerId: "consumer:test",
        },
      },
    };
    const original = f.request.getMockImplementation();
    if (!original) throw new Error("fixture");
    const readIntent = async () => {
      const artifact = [...f.artifacts.values()].find((value) =>
        value.operationKey.startsWith("runtime-tool-intent:"),
      );
      if (!artifact) throw new Error("intent missing");
      const payload = await f.options.payloads.get(artifact.payloadRef);
      if (!payload) throw new Error("payload missing");
      const bytes = await f.options.protector.unprotect({
        ownerId: artifact.ownerId,
        agentId: artifact.agentId,
        payload,
      });
      return JSON.parse(new TextDecoder().decode(bytes));
    };
    const recoveries: unknown[] = [];
    f.request.mockImplementation(async (message) => {
      recoveries.push((await readIntent()).recovery);
      expect(JSON.stringify(message)).not.toContain("checkpoint:original");
      return original(message);
    });
    const first = await (await exposed(f)).execute(call);
    expect(recoveries).toEqual(
      [0, 1].map(() => ({
        version: "tool-batch-recovery.v1",
        continuationRef: "checkpoint:original",
        toolCallId: invocation.toolCallId,
      })),
    );
    expect(first.outcome).toBe("succeeded");
    expect(JSON.stringify(first)).not.toContain("checkpoint:original");
    expect(
      await (await exposed(f)).execute({
        ...call,
        context: { ...call.context, continuationRef: "checkpoint:later" },
      }),
    ).toEqual(first);
    expect((await readIntent()).recovery.continuationRef).toBe("checkpoint:original");
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("reports admission refusal as not dispatched and retains a protected diagnostic", async () => {
    const f = fixture();
    vi.spyOn(f.options.invocations, "consume").mockRejectedValue(
      new ApplicationPortError("PORT_CONFLICT", "private host path must not appear"),
    );
    const revokeExecutionHandle = vi.fn(async () => {
      const handle = await f.options.capabilities.getExecutionHandle(
        invocation.capabilityHandleRef,
      );
      if (!handle) throw new Error("Fixture Handle missing");
      return handle;
    });
    const tool = new ProductionRuntimeTools({
      ...f.options,
      capabilities: { ...f.options.capabilities, revokeExecutionHandle },
    });
    await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
    const result = await tool.execute(invocation);
    expect(revokeExecutionHandle).toHaveBeenCalledWith(invocation.capabilityHandleRef, now);
    expect(result).toMatchObject({
      outcome: "failed",
      errorCode: "WORKER_ADMISSION_CONFLICT",
      modelContent: "操作尚未派发：资源或请求状态发生冲突。",
    });
    expect(JSON.stringify(result)).not.toContain("private host");
    expect(f.request).not.toHaveBeenCalled();
    expect([...f.artifacts.keys()].some((key) => key.startsWith("runtime-tool-diagnostic:"))).toBe(
      true,
    );
    expect(await (await exposed(f)).execute(invocation)).toEqual(result);
    expect(f.options.invocations.consume).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["PORT_HANDLE_REVOKED", "WORKER_AUTHORIZATION_DENIED"],
    ["PORT_NOT_AUTHORITATIVE", "WORKER_AUTHORITY_UNAVAILABLE"],
    ["PORT_NOT_FOUND", "WORKER_ADMISSION_RESOURCE_MISSING"],
  ] as const)("keeps a safe reason for pre-dispatch refusal (%s)", async (portCode, reasonCode) => {
    const f = fixture();
    vi.spyOn(f.options.invocations, "consume").mockRejectedValue(
      new ApplicationPortError(portCode, "private host path and token"),
    );
    const tool = await exposed(f);
    const result = await tool.execute(invocation);
    expect(result).toMatchObject({
      dispatchState: "not_sent",
      outcome: "failed",
      errorCode: reasonCode,
    });
    expect(JSON.stringify(result)).not.toContain("private host path");
    expect(f.request.mock.calls.some(([message]) => message.type === "work.execute")).toBe(false);
  });
  it("never sends a late execute after delegation outlives the caller deadline", async () => {
    const f = fixture(10);
    const original = f.request.getMockImplementation();
    if (!original) throw new Error("fixture");
    let resume: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.request.mockImplementation(async (message) => {
      if (message.type === "work.delegate") await gate;
      return original(message);
    });
    const result = await (await exposed(f)).execute(invocation);
    expect(result).toMatchObject({ outcome: "failed", errorCode: "WORKER_DEADLINE_EXCEEDED" });
    resume();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.request.mock.calls.map(([message]) => message.type)).toEqual(["work.delegate"]);
  });
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
  it("uses the smaller of the tool memory limit and the qualified binding memory ceiling", async () => {
    for (const [bound, expected] of [
      [SANDBOX_TOOL_MEMORY_LIMIT_BYTES / 2, SANDBOX_TOOL_MEMORY_LIMIT_BYTES / 2],
      [SANDBOX_TOOL_MEMORY_LIMIT_BYTES, SANDBOX_TOOL_MEMORY_LIMIT_BYTES],
      [SANDBOX_TOOL_MEMORY_LIMIT_BYTES * 2, SANDBOX_TOOL_MEMORY_LIMIT_BYTES],
    ] as const) {
      const f = fixture();
      const options = {
        ...f.options,
        ceiling: { ...f.options.ceiling, maxMemoryBytes: SANDBOX_TOOL_MEMORY_LIMIT_BYTES },
        maximumResourceCeiling: vi.fn(async () => ({
          ...f.options.ceiling,
          maxMemoryBytes: bound,
        })),
      };
      const tool = new ProductionRuntimeTools(options);
      await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
      expect((await tool.execute(invocation)).outcome).toBe("succeeded");
      const execute = f.request.mock.calls.find(
        ([message]) => message.type === "work.execute",
      )?.[0];
      expect(execute).toMatchObject({ payload: { resourceCeiling: { maxMemoryBytes: expected } } });
    }
  });
  it("reports a tightened Worker ceiling as a distinct pre-dispatch reason", async () => {
    const f = fixture();
    let reads = 0;
    const maximumResourceCeiling = vi.fn(async () => {
      reads += 1;
      return reads === 1
        ? f.options.ceiling
        : { ...f.options.ceiling, maxCpuTimeMs: f.options.ceiling.maxCpuTimeMs - 1 };
    });
    const tool = new ProductionRuntimeTools({ ...f.options, maximumResourceCeiling });
    await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
    const result = await tool.execute(invocation);
    expect(result).toMatchObject({
      dispatchState: "not_sent",
      outcome: "failed",
      errorCode: "WORKER_RESOURCE_CEILING_CHANGED",
    });
    expect(f.request.mock.calls.some(([message]) => message.type === "work.execute")).toBe(false);
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
  it("tells the model a failed command's workspace effect is unverified", async () => {
    const f = fixture();
    const completeSandboxToolResult = vi.fn<
      NonNullable<ProductionRuntimeToolsOptions["completeSandboxToolResult"]>
    >(async (_input, delivery) => {
      await delivery.assertDisclosure();
      const completion = {
        outcome: "failed" as const,
        outputRef: null,
        errorCode: "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
        externalActionId: null,
      };
      await delivery.saveReceipt(completion);
      return completion;
    });
    const tool = new ProductionRuntimeTools({ ...f.options, completeSandboxToolResult });
    await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);

    expect(await tool.execute(invocation)).toMatchObject({
      dispatchState: "accepted",
      outcome: "failed",
      errorCode: "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
      modelContent: expect.stringContaining("没有核验这条命令是否改动了工作区"),
    });
    expect(
      f.request.mock.calls.filter(([message]) => message.type === "work.execute"),
    ).toHaveLength(1);
  });
  it("[R2-T14] warns that a failed file write may have changed the file", async () => {
    const f = fixture();
    const completeSandboxToolResult = vi.fn<
      NonNullable<ProductionRuntimeToolsOptions["completeSandboxToolResult"]>
    >(async (_input, delivery) => {
      await delivery.assertDisclosure();
      const completion = {
        outcome: "failed" as const,
        outputRef: null,
        errorCode: "SANDBOX_WRITE_EFFECT_UNVERIFIED",
        externalActionId: null,
      };
      await delivery.saveReceipt(completion);
      return completion;
    });
    const tool = new ProductionRuntimeTools({ ...f.options, completeSandboxToolResult });
    await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);

    const result = await tool.execute(invocation);
    expect(result).toMatchObject({
      dispatchState: "accepted",
      outcome: "failed",
      errorCode: "SANDBOX_WRITE_EFFECT_UNVERIFIED",
      modelContent: expect.stringContaining("文件可能已被修改"),
    });
    expect(result.modelContent).not.toBe("操作未确认成功。");
  });
  it.each([
    ["SANDBOX_CPU_TIME_LIMIT", "CPU 时间"],
    ["SANDBOX_MEMORY_LIMIT", "内存"],
    ["SANDBOX_RESOURCE_LIMIT", "资源"],
  ] as const)(
    "[I-84] tells the model which resource limit stopped the command and what that limit is (%s)",
    async (errorCode, limitName) => {
      const f = fixture();
      const completeSandboxToolResult = vi.fn<
        NonNullable<ProductionRuntimeToolsOptions["completeSandboxToolResult"]>
      >(async (_input, delivery) => {
        await delivery.assertDisclosure();
        const completion = {
          outcome: "failed" as const,
          outputRef: null,
          errorCode,
          externalActionId: null,
        };
        await delivery.saveReceipt(completion);
        return completion;
      });
      const ceiling = { ...f.options.ceiling, maxCpuTimeMs: 12_500, maxMemoryBytes: 268_435_456 };
      const tool = new ProductionRuntimeTools({ ...f.options, ceiling, completeSandboxToolResult });
      await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);

      const result = await tool.execute(invocation);
      expect(result).toMatchObject({ dispatchState: "accepted", outcome: "failed", errorCode });
      expect(result.modelContent).toContain(limitName);
      expect(result.modelContent).toContain("CPU 时间 12.5 秒");
      expect(result.modelContent).toContain("内存 256 MB");
      expect(result.modelContent).not.toContain("1000 字节");
      expect(result.modelContent).toContain("执行已结束并完成清理");
      expect(result.modelContent).not.toContain("已终止");
      expect(result.modelContent).not.toContain("已被终止");
      expect(result.modelContent).not.toContain("在终止前");
      expect(result.modelContent).not.toBe("操作未确认成功。");
    },
  );
  it("[I-84] states the limit that stopped this command, not the limit in force now", async () => {
    const f = fixture();
    const completeSandboxToolResult = vi.fn<
      NonNullable<ProductionRuntimeToolsOptions["completeSandboxToolResult"]>
    >(async (_input, delivery) => {
      await delivery.assertDisclosure();
      const completion = {
        outcome: "failed" as const,
        outputRef: null,
        errorCode: "SANDBOX_CPU_TIME_LIMIT",
        externalActionId: null,
        resourceCeiling: { ...f.options.ceiling, maxCpuTimeMs: 7_500, maxMemoryBytes: 134_217_728 },
      };
      await delivery.saveReceipt(completion);
      return completion;
    });
    const ceiling = { ...f.options.ceiling, maxCpuTimeMs: 12_500, maxMemoryBytes: 268_435_456 };
    const tool = new ProductionRuntimeTools({ ...f.options, ceiling, completeSandboxToolResult });
    await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);

    const result = await tool.execute(invocation);
    expect(result).toMatchObject({ outcome: "failed", errorCode: "SANDBOX_CPU_TIME_LIMIT" });
    expect(result.modelContent).toContain("CPU 时间 7.5 秒");
    expect(result.modelContent).toContain("内存 128 MB");
    expect(result.modelContent).not.toContain("12.5 秒");
    expect(result.modelContent).not.toContain("256 MB");
  });
  it.each([
    [2_500_000, "输出 2.4 MB"],
    [32_768, "输出 32 KB"],
    [800, "输出 800 字节"],
  ] as const)(
    "[I-84] tells the model the output a command may produce and that what came back is cut short (%s)",
    async (maxOutputBytes, limit) => {
      const f = fixture();
      const completeSandboxToolResult = vi.fn<
        NonNullable<ProductionRuntimeToolsOptions["completeSandboxToolResult"]>
      >(async (_input, delivery) => {
        await delivery.assertDisclosure();
        const completion = {
          outcome: "failed" as const,
          outputRef: null,
          errorCode: "SANDBOX_OUTPUT_LIMIT",
          externalActionId: null,
          resourceCeiling: { ...f.options.ceiling, maxOutputBytes },
        };
        await delivery.saveReceipt(completion);
        return completion;
      });
      const ceiling = { ...f.options.ceiling, maxOutputBytes: 9_900_000 };
      const tool = new ProductionRuntimeTools({ ...f.options, ceiling, completeSandboxToolResult });
      await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);

      const result = await tool.execute(invocation);
      expect(result).toMatchObject({
        dispatchState: "accepted",
        outcome: "failed",
        errorCode: "SANDBOX_OUTPUT_LIMIT",
      });
      expect(result.modelContent).toContain(limit);
      expect(result.modelContent).toContain("可能已被截断");
      expect(result.modelContent).toContain("标准输出和标准错误合计");
      expect(result.modelContent).not.toContain("已终止");
      expect(result.modelContent).not.toContain("已被终止");
      expect(result.modelContent).not.toContain("在终止前");
      expect(result.modelContent).not.toContain("输出 9.4 MB");
      expect(result.modelContent).not.toContain("CPU 时间");
      expect(result.modelContent).not.toBe("操作未确认成功。");
    },
  );
  it.each([
    ["output:tools", { outcome: "failed", resultRef: "output:tools", modelContent: "已读取结果" }],
    ["output:unobserved", { outcome: "result_unknown", resultRef: null }],
  ] as const)(
    "gives the model a failed read's error output only when the Worker produced it (%s)",
    async (outputRef, expected) => {
      const f = fixture();
      const completeSandboxToolResult = vi.fn<
        NonNullable<ProductionRuntimeToolsOptions["completeSandboxToolResult"]>
      >(async (_input, delivery) => {
        await delivery.assertDisclosure();
        const completion = {
          outcome: "failed" as const,
          outputRef,
          errorCode: "SANDBOX_OPERATION_FAILED",
          externalActionId: null,
        };
        await delivery.saveReceipt(completion);
        return completion;
      });
      const tool = new ProductionRuntimeTools({ ...f.options, completeSandboxToolResult });
      await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);

      const result = await tool.execute(invocation);
      expect(result).toMatchObject(expected);
      if (expected.outcome !== "failed") expect(result.modelContent).not.toContain("已读取结果");
    },
  );
  it.each([true, false])(
    "uses worker end timing only for settled effects (%s)",
    async (settled) => {
      const f = fixture();
      const original = f.options.transport.events.bind(f.options.transport);
      vi.spyOn(f.options.transport, "events").mockImplementation(async function* (cursor) {
        for await (const event of original(cursor)) {
          if (event.type === "work.result") {
            yield {
              ...event,
              type: "work.progress",
              messageId: "start:tools",
              payload: {
                requestId: event.payload.requestId,
                cursor: "start",
                sequence: 0,
                stage: "worker.execution.started",
                progressPermille: 0,
                payloadRef: null,
                occurredAt: new Date(Date.parse(now) - 1200).toISOString(),
              },
            };
          }
          yield event;
        }
      });
      const tool = new ProductionRuntimeTools({
        ...f.options,
        ...(settled ? {} : { completeSandboxToolResult: async () => undefined }),
      });
      await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
      const result = await tool.execute(invocation);
      if (settled)
        expect(result).toMatchObject({
          executionTiming: {
            startedAt: new Date(Date.parse(now) - 1200).toISOString(),
            endedAt: now,
          },
        });
      else expect(result).not.toHaveProperty("executionTiming");
      expect(await (await exposed(f)).execute(invocation)).toEqual(result);
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
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
      expect(
        f.request.mock.calls.filter(([message]) => message.type === "work.execute"),
      ).toHaveLength(1);
      expect(
        f.request.mock.calls.filter(([message]) => message.type === "work.delegate"),
      ).toHaveLength(1);
      expect(
        f.request.mock.calls.filter(([message]) => message.type === "work.cancel"),
      ).toHaveLength(mode === "revoke" ? 1 : 0);
    },
  );
  it("writes the reason into the service log when a result cannot be settled", async () => {
    const f = fixture(25);
    f.setMode("hang");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      const result = await (await exposed(f)).execute(invocation);
      expect(result).toMatchObject({ outcome: "result_unknown" });
    } finally {
      spy.mockRestore();
    }
    const logged = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return {};
        }
      })
      .filter((entry) => entry["event"] === "tool.settlement_failed");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      runId: invocation.runId,
      stage: "possibly_sent",
      errorName: expect.any(String),
    });
    expect(typeof logged[0]?.["errorMessage"]).toBe("string");
  });
  it.each(["requested", "unconfirmed"])(
    "requests stop when authority is withdrawn during a hung event stream: %s",
    async (stopState) => {
      const f = fixture(250);
      const send = f.request.getMockImplementation();
      if (!send) throw new Error("missing transport");
      f.request.mockImplementation(async (message) => {
        if (message.type === "work.cancel" && stopState === "unconfirmed")
          throw new Error("private stop transport failure");
        return send(message);
      });
      vi.spyOn(f.options.transport, "events").mockImplementation(async function* () {
        f.revoke();
        await new Promise(() => {});
      });
      const tool = await exposed(f);
      const result = await tool.execute(invocation);
      expect(f.request.mock.calls.map(([message]) => message.type)).toEqual([
        "work.delegate",
        "work.execute",
        "work.cancel",
      ]);
      expect(f.request.mock.calls[2]?.[0]).toMatchObject({
        type: "work.cancel",
        payload: {
          targetRequestId: f.request.mock.calls[1]?.[0].messageId,
          reasonCode: "AUTHORITY_WITHDRAWN",
        },
      });
      expect(result).toMatchObject({ outcome: "result_unknown", resultRef: null });
      expect(result).not.toHaveProperty("executionTiming");
      expect(result).toMatchObject({ errorCode: "WORKER_AUTHORITY_WITHDRAWN" });
      expect(result.modelContent).not.toContain("private stop transport failure");
      const artifact = [...f.artifacts.values()].find((value) =>
        value.operationKey.startsWith("runtime-tool-diagnostic:"),
      );
      const protectedRecord = artifact && f.payloads.get(artifact.payloadRef);
      if (!protectedRecord) throw new Error("missing protected stop evidence");
      expect(JSON.parse(new TextDecoder().decode(protectedRecord.ciphertext))).toMatchObject({
        authorityWithdrawn: true,
        stopRequest: stopState,
      });
      expect(f.options.invocations.consume).toHaveBeenCalledOnce();
      await expect(tool.execute(invocation)).rejects.toThrow();
      expect(
        f.request.mock.calls.filter(([message]) => message.type === "work.execute"),
      ).toHaveLength(1);
    },
  );

  it("keeps an unverified cancellation unknown and never resends it", async () => {
    const f = fixture();
    f.setMode("cancelled");
    const result = await (await exposed(f)).execute(invocation);
    expect(result).toMatchObject({
      outcome: "result_unknown",
      errorCode: "WORKER_RESULT_RECONCILIATION_REQUIRED",
    });
    expect(await (await exposed(f)).execute(invocation)).toEqual(result);
    expect(f.request).toHaveBeenCalledTimes(2);
    const diagnostic = [...f.artifacts.values()].find((value) =>
      value.operationKey.startsWith("runtime-tool-diagnostic:"),
    );
    if (!diagnostic) throw new Error("Missing cancellation diagnostic");
    const payload = await f.options.payloads.get(diagnostic.payloadRef);
    if (!payload) throw new Error("Missing protected diagnostic");
    const bytes = await f.options.protector.unprotect({
      ownerId: diagnostic.ownerId,
      agentId: diagnostic.agentId,
      payload,
    });
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({
      stage: "accepted",
      reasonCode: "WORKER_CANCELLATION_OBSERVED",
      cancellationReason: "CANCELLED",
    });
    expect(result.modelContent).not.toContain("CANCELLED");
  });
  it.each(["succeeded", "failed", null, undefined] as const)(
    "verifies cancellation notifications before settling a tool: %s",
    async (verified) => {
      const f = fixture();
      f.setMode("cancelled");
      const original = f.options.transport.events.bind(f.options.transport);
      vi.spyOn(f.options.transport, "events").mockImplementation(async function* (cursor) {
        for await (const event of original(cursor)) {
          if (event.type === "work.cancelled")
            yield {
              ...event,
              type: "work.progress",
              messageId: "start:tools",
              payload: {
                requestId: event.payload.requestId,
                cursor: "start",
                sequence: 0,
                stage: "worker.execution.started",
                progressPermille: 0,
                payloadRef: null,
                occurredAt: new Date(Date.parse(now) - 1200).toISOString(),
              },
            };
          yield event;
        }
      });
      const completeSandboxToolResult = vi.fn<
        NonNullable<ProductionRuntimeToolsOptions["completeSandboxToolResult"]>
      >(async (_input, delivery) => {
        await delivery.assertDisclosure();
        if (verified === null || verified === undefined) return verified;
        const completion = {
          outcome: verified,
          outputRef: verified === "succeeded" ? "output:tools" : null,
          errorCode: verified === "failed" ? "COMMAND_FAILED" : null,
          externalActionId: null,
        };
        await delivery.saveReceipt(completion);
        return completion;
      });
      const tool = new ProductionRuntimeTools({ ...f.options, completeSandboxToolResult });
      await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
      const result = await tool.execute(invocation);
      expect(result.outcome).toBe(verified ?? "result_unknown");
      expect(completeSandboxToolResult).toHaveBeenCalledOnce();
      expect(result).not.toHaveProperty("executionTiming");
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
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

it("recovers a persisted sandbox handoff after interruption without executing again", async () => {
  const f = fixture();
  const completeSandboxToolResult = vi.fn(async (_input, delivery) => {
    await delivery.assertDisclosure();
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
  expect((await tool.execute(invocation)).outcome).toBe("succeeded");
  const resultKey = [...f.artifacts.keys()].find((key) => key.startsWith("runtime-tool-result:"));
  if (!resultKey) throw new Error("missing result fixture");
  f.artifacts.delete(resultKey);
  const resumed = new ProductionRuntimeTools({ ...f.options, completeSandboxToolResult });
  await resumed.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
  expect(await resumed.execute(invocation)).toMatchObject({
    outcome: "succeeded",
    modelContent: "已读取结果",
  });
  expect(f.request.mock.calls.filter(([request]) => request.type === "work.execute")).toHaveLength(
    1,
  );
  expect(completeSandboxToolResult).toHaveBeenCalledTimes(2);
});

it.each(["success", "cancelled"] as const)(
  "delivers a later verified result without resending an unknown operation (%s)",
  async (mode) => {
    const f = fixture();
    f.setMode(mode);
    let verified = false;
    const completeSandboxToolResult = vi.fn(async (_input, delivery) => {
      await delivery.assertDisclosure();
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
    expect((await tool.execute(invocation)).outcome).toBe("result_unknown");
    verified = true;
    const resumed = new ProductionRuntimeTools({ ...f.options, completeSandboxToolResult });
    await resumed.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
    expect((await resumed.execute(invocation)).outcome).toBe("succeeded");
    expect(
      f.request.mock.calls.filter(([request]) => request.type === "work.execute"),
    ).toHaveLength(1);
  },
);

it.each([true, false])(
  "binds a recovered file output to its verified delivery receipt (%s)",
  async (receiptAvailable) => {
    const f = fixture();
    let verified = false;
    const completeSandboxToolResult = vi.fn(async (input, delivery) => {
      if (!verified) return undefined;
      await delivery.assertDisclosure();
      const original = f.payloads.get("output:tools");
      if (!original) throw new Error("missing fixture output");
      const saved = await f.options.artifacts.commit({
        runId: invocation.runId,
        purpose: "trace",
        operationKey: piFileRecoveryOperationKey(input.invocationId),
        payload: { ...original, ref: "recovered:tools" },
      });
      const result = {
        outcome: "succeeded" as const,
        outputRef: saved.ref,
        errorCode: null,
        externalActionId: null,
      };
      if (receiptAvailable) await delivery.saveReceipt(result);
      return result;
    });
    const tool = new ProductionRuntimeTools({ ...f.options, completeSandboxToolResult });
    await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
    expect((await tool.execute(invocation)).outcome).toBe("result_unknown");
    verified = true;
    const resumed = new ProductionRuntimeTools({ ...f.options, completeSandboxToolResult });
    await resumed.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
    if (receiptAvailable) {
      expect(await resumed.execute(invocation)).toMatchObject({
        outcome: "succeeded",
        resultRef: "recovered:tools",
      });
      const replay = new ProductionRuntimeTools({ ...f.options, completeSandboxToolResult });
      await replay.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
      expect((await replay.execute(invocation)).outcome).toBe("succeeded");
    } else
      await expect(resumed.execute(invocation)).rejects.toThrow(
        "WORKER_OUTPUT_OBSERVATION_MISSING",
      );
    expect(
      f.request.mock.calls.filter(([request]) => request.type === "work.execute"),
    ).toHaveLength(1);
  },
);

const hostGrant: import("@himawari-agent/application").HostDirectoryGrant = {
  id: "directory:test",
  revision: 1,
  hostId: "host:test",
  canonicalRootId: "1:2",
  displayPath: "/workspace",
  operations: ["read"] as const,
  dataClassification: "private" as const,
  disclosure: "model" as const,
  pathPolicy: "same_filesystem_no_links" as const,
  mountPolicy: "fixed_device" as const,
  authorizationRef: "owner:test",
  revokedAt: null,
  expiresAt: "2026-09-06T01:00:00.000Z",
};

function hostCodingCall(): RuntimeToolInvocation {
  return {
    ...invocation,
    capabilityHandleRef: null,
    capabilityRef: "coding.read",
    arguments: { path: "notes.txt" },
    executionDeadlineAt: "2026-09-06T00:01:00.000Z",
    context: {
      threadId: "thread:test" as NonNullable<RuntimeToolInvocation["context"]>["threadId"],
      modelRef: "model:test",
      continuationRef: "payload:continuation" as PayloadRef,
      executionLease: {
        deploymentId: "deployment:test" as NonNullable<
          RuntimeToolInvocation["context"]
        >["executionLease"]["deploymentId"],
        authorityEpoch: 1,
        fencingToken: 1,
        authorityLeaseId: "authority-lease:test" as NonNullable<
          RuntimeToolInvocation["context"]
        >["executionLease"]["authorityLeaseId"],
        authorityFencingToken: 1,
        executionLeaseId: "execution:test" as NonNullable<
          RuntimeToolInvocation["context"]
        >["executionLease"]["executionLeaseId"],
        expectedLeaseRevision: 1,
        consumerId: "consumer:test",
      },
    },
  };
}

type HostExecute = (input: ProductionHostReadOnlyInput) => Promise<ProductionHostReadOnlyResult>;

function hostOptions(f: ReturnType<typeof fixture>, execute: HostExecute) {
  return {
    ...f.options,
    coding: {
      capabilityRef: "coding",
      capabilityVersion: "1.0.0",
      enabledTools: ["read"] as const,
      hostId: "host:test",
      workerInstanceId: "worker-instance",
      grantId: "directory:test",
      maximumBytes: 4096,
    },
    fileRead: {
      binding: async () => ({
        workerInstanceId: "worker-instance",
        revision: 1,
        hostId: "host:test",
        capabilityRef: "coding",
        capabilityVersion: "1.0.0",
        maximumBytes: 4096,
        threadId: "thread:test",
        modelRef: "model:test",
        modelIdentity: "model:openrouter:test",
        grant: hostGrant,
      }),
      authorize: vi.fn(async () => ({
        decision: "ALLOW" as const,
        basis: { type: "grant" as const, ref: "grant:test" },
        executionScope: {
          capabilityRef: "coding",
          operations: ["read"],
          exactResourceRef: null,
          resourcePrefixes: [],
          maxDataClassification: "private" as const,
          sideEffects: ["none" as const],
          maxCostMicrosPerUse: 0,
          maxFrequency: { count: 1, intervalMs: null },
        },
      })),
      issue: vi.fn(async () => {
        throw new Error("must not issue");
      }),
      hostReadOnly: { execute },
    },
    completeSandboxToolResult: vi.fn(async () => null),
  };
}

it("[R2-P1] recovers a saved host read result instead of rejecting it", async () => {
  const f = fixture();
  const execute = vi.fn(
    async (_input: ProductionHostReadOnlyInput): Promise<ProductionHostReadOnlyResult> => ({
      modelContent: "pi-result.v1",
      isError: false,
      errorCode: null,
    }),
  );
  const call = hostCodingCall();
  const tool = new ProductionRuntimeTools(hostOptions(f, execute));
  await tool.listAuthorized(call.runId, []);
  const first = await tool.execute(call);
  expect(first).toMatchObject({ outcome: "succeeded", dispatchState: "accepted" });
  expect(execute).toHaveBeenCalledTimes(1);
  const recovered = await tool.recoverResult(call, {
    toolCallId: call.toolCallId,
    capabilityRef: call.capabilityRef,
    invocationId: "runtime-tool:test",
    jobId: "job:test",
    continuationRef: call.context?.continuationRef ?? ("payload:continuation" as PayloadRef),
  });
  expect(recovered).toMatchObject({
    outcome: "succeeded",
    modelContent: "pi-result.v1",
    dispatchState: "accepted",
  });
});

describe("[R2-T14] failed command output for the model", () => {
  const envelope = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: "pi-result.v1",
    tool: "read",
    content: [{ type: "text", text: "R2T14-OUT\nR2T14-ERR\n\nCommand exited with code 7" }],
    details: {},
    fullOutput: null,
    isError: true,
    commandExitCode: 7,
    verifiedWrite: null,
    source: { tool: "read" },
    ...overrides,
  });

  async function failedCommand(text: string, processExitCode: number | undefined) {
    const f = fixture();
    const stored = f.payloads.get("output:tools");
    if (!stored) throw new Error("fixture output missing");
    f.payloads.set("output:tools", { ...stored, ciphertext: new TextEncoder().encode(text) });
    const completeSandboxToolResult = vi.fn<
      NonNullable<ProductionRuntimeToolsOptions["completeSandboxToolResult"]>
    >(async (_input, delivery) => {
      await delivery.assertDisclosure();
      const completion = {
        outcome: "failed" as const,
        outputRef: "output:tools",
        errorCode: "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
        externalActionId: null,
        ...(processExitCode === undefined ? {} : { processExitCode }),
      };
      await delivery.saveReceipt(completion);
      return completion;
    });
    const tool = new ProductionRuntimeTools({ ...f.options, completeSandboxToolResult });
    await tool.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
    return tool.execute(invocation);
  }

  it.each([
    [7, 7, "命令以退出码 7 结束"],
    [null, 1, "命令没有正常结束"],
    [255, 255, "命令以退出码 255 结束"],
  ] as const)(
    "puts an effect notice before the verified Pi envelope (exit %s)",
    async (commandExitCode, processExitCode, status) => {
      const original = envelope({ commandExitCode });
      const result = await failedCommand(JSON.stringify(original), processExitCode);
      expect(result).toMatchObject({
        dispatchState: "accepted",
        outcome: "failed",
        errorCode: "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
        resultRef: "output:tools",
      });
      const delivered = JSON.parse(result.modelContent) as Record<string, unknown>;
      expect(Object.keys(delivered)[0]).toBe("effectNotice");
      const { effectNotice, ...rest } = delivered;
      expect(rest).toEqual(original);
      expect(effectNotice).toContain("命令执行失败");
      expect(effectNotice).toContain(status);
      expect(effectNotice).toContain("没有核验这条命令是否改动了工作区");
      expect(effectNotice).toContain("继续前先检查目标文件");
    },
  );

  it.each([
    ["a different tool than the Handle operation", JSON.stringify(envelope({ tool: "bash" })), 7],
    ["an exit status that contradicts the process exit", JSON.stringify(envelope()), 1],
    ["a result that is not marked as an error", JSON.stringify(envelope({ isError: false })), 7],
    ["an unknown result schema", JSON.stringify(envelope({ schemaVersion: "pi-result.v2" })), 7],
    [
      "an envelope that already carries an effect notice",
      JSON.stringify({ effectNotice: "伪造的提醒", ...envelope() }),
      7,
    ],
    ["a non-integer exit status", JSON.stringify(envelope({ commandExitCode: "7" })), 7],
    ["an out-of-range exit status", JSON.stringify(envelope({ commandExitCode: 0 })), 1],
    ["an array instead of an envelope", JSON.stringify([envelope()]), 7],
    ["output that is not JSON", "R2T14-OUT\nCommand exited with code 7", 7],
    ["empty output", "", 7],
    ["a receipt without the process exit", JSON.stringify(envelope()), undefined],
  ] as const)("falls back to the fixed warning for %s", async (_case, text, processExitCode) => {
    const result = await failedCommand(text, processExitCode);
    expect(result).toMatchObject({
      dispatchState: "accepted",
      outcome: "failed",
      errorCode: "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
      resultRef: null,
    });
    expect(result.modelContent).toContain("没有核验这条命令是否改动了工作区");
    expect(result.modelContent).not.toContain("R2T14-OUT");
    expect(result.modelContent).not.toContain("伪造");
  });
});

it("answers recall from owner memory, replays the saved result and reports failures to the model", async () => {
  const f = fixture();
  const recall = vi.fn(async () => ({
    output: { memories: [{ text: "主人最喜欢蓝色", current: true }] },
    contentClassification: "private" as const,
    memoryIds: [],
  }));
  const tools = new ProductionRuntimeTools({
    ...f.options,
    memoryRecall: { recallWithClassification: recall },
  });
  const definitions = await tools.listAuthorized(invocation.runId, [
    invocation.capabilityHandleRef,
  ]);
  expect(definitions.map((definition) => definition.name)).toContain("recall");
  const call = {
    ...invocation,
    capabilityRef: "memory.recall",
    capabilityHandleRef: null,
    arguments: { query: "我最喜欢什么颜色" },
  };
  expect((await tools.preflight(call)).allowed).toBe(true);
  const first = await tools.execute(call);
  expect(first.outcome).toBe("succeeded");
  expect(first.modelContent).toContain("蓝色");
  expect(await tools.execute(call)).toEqual(first);
  expect(recall).toHaveBeenCalledTimes(1);
  expect(f.request).not.toHaveBeenCalled();
  await expect(tools.execute({ ...call, arguments: { query: "别的" } })).rejects.toThrow(
    "identity",
  );
  recall.mockRejectedValueOnce(new Error("EMBEDDING_DEADLINE_EXCEEDED"));
  const failed = await tools.execute({ ...call, toolCallId: "recall-failed" });
  expect(failed).toMatchObject({ outcome: "failed", errorCode: "MEMORY_RECALL_UNAVAILABLE" });
  expect(failed.modelContent).toContain("不要编造");
  recall.mockRejectedValueOnce(new Error("MEMORY_RECALL_INPUT_INVALID"));
  const invalid = await tools.execute({ ...call, toolCallId: "recall-invalid" });
  expect(invalid).toMatchObject({ outcome: "failed", errorCode: "MEMORY_RECALL_INPUT_INVALID" });
  expect(invalid.modelContent).toContain("改正后再查一次");
  expect(invalid.modelContent).not.toContain("查不了记忆");
});

it("offers reminder tools last, runs them once per call and tells the model why a reminder failed", async () => {
  const f = fixture();
  const run = vi.fn(async () => ({ created: true, reminderId: "reminder:a" }));
  const tools = new ProductionRuntimeTools({
    ...f.options,
    memoryRecall: {
      recallWithClassification: async () => ({
        output: {},
        contentClassification: "private",
        memoryIds: [],
      }),
    },
    reminders: { run },
    ownerScope: { authorize: async () => OWNER_SCOPE_ALLOW },
  });
  const names = (
    await tools.listAuthorized(invocation.runId, [invocation.capabilityHandleRef])
  ).map((definition) => definition.name);
  expect(names.slice(-4)).toEqual(["recall", "reminder_set", "reminder_list", "reminder_cancel"]);
  const again = await tools.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
  expect(JSON.stringify(again.slice(-3))).toBe(
    JSON.stringify(
      (await tools.listAuthorized(invocation.runId, [invocation.capabilityHandleRef])).slice(-3),
    ),
  );
  const call = {
    ...invocation,
    capabilityRef: "reminder.set",
    capabilityHandleRef: null,
    arguments: { text: "交周报", due: "2026-11-06T15:00" },
  };
  expect((await tools.preflight(call)).allowed).toBe(true);
  const first = await tools.execute(call);
  expect(first).toMatchObject({ outcome: "succeeded", errorCode: null });
  expect(await tools.execute(call)).toEqual(first);
  expect(run).toHaveBeenCalledTimes(1);
  await expect(
    tools.execute({ ...call, arguments: { text: "别的", due: "2026-11-06T15:00" } }),
  ).rejects.toThrow("identity");
  run.mockRejectedValueOnce(new ReminderInputError("REMINDER_TIME_INVALID"));
  const refused = await tools.execute({ ...call, toolCallId: "reminder-past" });
  expect(refused).toMatchObject({ outcome: "failed", errorCode: "REMINDER_TIME_INVALID" });
  expect(refused.modelContent).toContain("不要说已设好");
  run.mockRejectedValueOnce(new Error("SQLITE_BUSY"));
  const broken = await tools.execute({ ...call, toolCallId: "reminder-broken" });
  expect(broken).toMatchObject({ outcome: "failed", errorCode: "REMINDER_UNAVAILABLE" });
});

it("does not offer or allow reminder tools when reminders are not configured", async () => {
  const f = fixture();
  const tools = f.tool();
  const names = (
    await tools.listAuthorized(invocation.runId, [invocation.capabilityHandleRef])
  ).map((definition) => definition.name);
  expect(names.some((name) => name.startsWith("reminder_"))).toBe(false);
  for (const capabilityRef of ["reminder.set", "reminder.list", "reminder.cancel"])
    expect(
      (
        await tools.preflight({
          ...invocation,
          capabilityRef,
          capabilityHandleRef: null,
          arguments: {},
        })
      ).allowed,
    ).toBe(false);
});

it("does not offer recall when memory is not configured", async () => {
  const f = fixture();
  const tools = f.tool();
  const definitions = await tools.listAuthorized(invocation.runId, [
    invocation.capabilityHandleRef,
  ]);
  expect(definitions.map((definition) => definition.name)).not.toContain("recall");
  expect(
    (
      await tools.preflight({
        ...invocation,
        capabilityRef: "memory.recall",
        capabilityHandleRef: null,
        arguments: { query: "颜色" },
      })
    ).allowed,
  ).toBe(false);
});

it("[NL-1] marks only service-process read-only tools for parallel execution", async () => {
  const f = fixture();
  const execute = vi.fn(
    async (_input: ProductionHostReadOnlyInput): Promise<ProductionHostReadOnlyResult> => ({
      modelContent: "unused",
      isError: false,
      errorCode: null,
    }),
  );
  const base = hostOptions(f, execute);
  const route = {
    hostId: "host:test",
    workerInstanceId: "worker-instance",
    capabilityRef: "search",
    capabilityVersion: "1.0.0",
    maximumBytes: 4096,
    scopeSource: "private_temp" as const,
  };
  const modes = async (hostWeb: boolean) => {
    const descriptors = await new ProductionRuntimeTools({
      ...base,
      coding: { ...base.coding, enabledTools: ["read", "grep", "write", "bash"] as const },
      publicSearch: route,
      publicFetch: route,
      fileRead: {
        ...base.fileRead,
        ...(hostWeb
          ? { hostWeb: { execute: vi.fn(async () => ({ ok: true, code: null, output: "" })) } }
          : {}),
      },
    }).listAuthorized(invocation.runId, []);
    return descriptors.map((descriptor) => [
      descriptor.name,
      "executionMode" in descriptor ? descriptor.executionMode : undefined,
    ]);
  };
  expect(await modes(true)).toEqual([
    ["read", "parallel"],
    ["grep", "parallel"],
    ["write", undefined],
    ["bash", undefined],
    ["web_search", "parallel"],
    ["web_fetch", "parallel"],
  ]);
  expect(await modes(false)).toEqual([
    ["read", "parallel"],
    ["grep", "parallel"],
    ["write", undefined],
    ["bash", undefined],
    ["web_search", undefined],
    ["web_fetch", undefined],
  ]);
});

it("[NL-11] tells the model how to continue reading a long page with offset", async () => {
  const f = fixture();
  const base = hostOptions(
    f,
    vi.fn(async () => ({ modelContent: "unused", isError: false, errorCode: null })),
  );
  const route = {
    hostId: "host:test",
    workerInstanceId: "worker-instance",
    capabilityRef: "fetch",
    capabilityVersion: "1.0.0",
    maximumBytes: 100 * 1024,
    scopeSource: "private_temp" as const,
  };
  const descriptors = await new ProductionRuntimeTools({
    ...base,
    publicFetch: route,
  }).listAuthorized(invocation.runId, []);
  const fetch = descriptors.find((descriptor) => descriptor.name === "web_fetch");
  expect(fetch && "parameters" in fetch ? fetch.parameters : undefined).toMatchObject({
    properties: { url: { type: "string" }, offset: { type: "integer", minimum: 0 } },
    required: ["url"],
    additionalProperties: false,
  });
  expect(fetch && "description" in fetch ? fetch.description : "").toMatch(/nextOffset/);
});

it("exposes task management only when a task can start or bash can move to the background", async () => {
  const f = fixture();
  const execute = vi.fn(
    async (_input: ProductionHostReadOnlyInput): Promise<ProductionHostReadOnlyResult> => ({
      modelContent: "unused",
      isError: false,
      errorCode: null,
    }),
  );
  const base = hostOptions(f, execute);
  const managedTasks = { execute: vi.fn() };
  const names = async (options: ConstructorParameters<typeof ProductionRuntimeTools>[0]) =>
    (await new ProductionRuntimeTools(options).listAuthorized(invocation.runId, []))
      .map((descriptor) => descriptor.name)
      .filter((name) => name.startsWith("execution_task_"));
  expect(await names({ ...base, managedTasks, taskHandle: async () => false })).toEqual([]);
  expect(
    await names({
      ...base,
      managedTasks,
      backgroundCommands: { waitMs: 30_000, maximumMs: 60_000 },
    }),
  ).toEqual([]);
  const bash = {
    ...base,
    coding: { ...base.coding, enabledTools: ["read", "bash"] as const },
    backgroundCommands: { waitMs: 30_000, maximumMs: 60_000 },
  };
  expect(await names(bash)).toEqual([
    "execution_task_status",
    "execution_task_output",
    "execution_task_cancel",
  ]);
  const tools = new ProductionRuntimeTools(bash);
  await tools.listAuthorized(invocation.runId, []);
  const status = {
    ...invocation,
    capabilityRef: "execution.task.status",
    capabilityHandleRef: null,
    arguments: { resourceRef: "background-command:000000000000000000000000" },
  };
  expect((await tools.preflight(status)).allowed).toBe(true);
  expect(await tools.execute(status)).toMatchObject({
    outcome: "failed",
    errorCode: "BACKGROUND_COMMAND_NOT_FOUND",
  });
  expect(f.request).not.toHaveBeenCalled();
});

it("[PR-B] marks task tools that only a task handle brings, so they stay out of the conversation's frozen tools", async () => {
  const f = fixture();
  const base = hostOptions(
    f,
    vi.fn(async () => ({ modelContent: "unused", isError: false, errorCode: null })),
  );
  const managedTasks = { execute: vi.fn() };
  const bound = async (
    options: ConstructorParameters<typeof ProductionRuntimeTools>[0],
    refs: readonly string[],
  ) =>
    (await new ProductionRuntimeTools(options).listAuthorized(invocation.runId, refs))
      .filter(({ name }) => name.startsWith("execution_task_"))
      .map((descriptor) => [
        descriptor.name,
        "handleBound" in descriptor && descriptor.handleBound === true,
      ]);
  const withHandle = { ...f.options, managedTasks, taskHandle: async () => true };
  expect(await bound(withHandle, [invocation.capabilityHandleRef])).toEqual([
    ["execution_task_status", true],
    ["execution_task_output", true],
    ["execution_task_cancel", true],
    ["execution_task_start", true],
  ]);
  const bash = {
    ...base,
    managedTasks,
    taskHandle: async () => true,
    coding: { ...base.coding, enabledTools: ["read", "bash"] as const },
    backgroundCommands: { waitMs: 30_000, maximumMs: 60_000 },
  };
  expect(await bound(bash, [])).toEqual([
    ["execution_task_status", false],
    ["execution_task_output", false],
    ["execution_task_cancel", false],
  ]);
  expect(await bound(bash, [invocation.capabilityHandleRef])).toEqual([
    ["execution_task_status", false],
    ["execution_task_output", false],
    ["execution_task_cancel", false],
    ["execution_task_start", true],
  ]);
});

it("[BG-8] gives a bash command its own 30-minute limit instead of the 5-minute answer limit", async () => {
  const f = fixture();
  const base = hostOptions(
    f,
    vi.fn(async () => ({ modelContent: "unused", isError: false, errorCode: null })),
  );
  const issued: string[] = [];
  const options = {
    ...base,
    coding: { ...base.coding, enabledTools: ["read", "bash"] as const },
    backgroundCommands: { waitMs: 30_000, maximumMs: 1_800_000 },
    fileRead: {
      ...base.fileRead,
      binding: async () => ({
        ...(await base.fileRead.binding()),
        grant: { ...hostGrant, operations: ["read", "create", "update"] as const },
      }),
      authorize: vi.fn(async () => ({
        decision: "ALLOW" as const,
        basis: { type: "grant" as const, ref: "grant:test" },
        executionScope: {
          capabilityRef: "coding",
          operations: ["bash"],
          exactResourceRef: null,
          resourcePrefixes: [],
          maxDataClassification: "private" as const,
          sideEffects: ["none" as const],
          maxCostMicrosPerUse: 0,
          maxFrequency: { count: 1, intervalMs: null },
        },
      })),
      issue: vi.fn(async (input: { expiresAt: string }) => {
        issued.push(input.expiresAt);
        throw new Error("STOP_AFTER_HANDLE");
      }),
    },
  };
  const tools = new ProductionRuntimeTools(options);
  await tools.listAuthorized(invocation.runId, []);
  const bash = {
    ...hostCodingCall(),
    capabilityRef: "coding.bash",
    arguments: { command: "sleep 600" },
    executionDeadlineAt: "2026-09-06T00:05:00.000Z",
  };
  await tools.execute(bash).catch(() => undefined);
  await tools.execute(bash).catch(() => undefined);
  expect(issued).toEqual(["2026-09-06T00:30:00.000Z", "2026-09-06T00:30:00.000Z"]);
  const read = { ...hostCodingCall(), executionDeadlineAt: "2026-09-06T00:05:00.000Z" };
  await tools.execute(read).catch(() => undefined);
  expect(issued).toHaveLength(2);
});

const OWNER_SCOPE_ALLOW = {
  decision: "ALLOW" as const,
  basis: { type: "grant" as const, ref: "grant:owner-scope" },
  executionScope: {
    capabilityRef: "reminder.set",
    operations: ["set"],
    exactResourceRef: null,
    resourcePrefixes: [],
    maxDataClassification: "private" as const,
    sideEffects: ["reversible" as const],
    maxCostMicrosPerUse: 0,
    maxFrequency: { count: 1, intervalMs: null },
  },
};

function everyToolOptions(f: ReturnType<typeof fixture>) {
  const base = hostOptions(
    f,
    vi.fn(async () => ({ modelContent: "unused", isError: false, errorCode: null })),
  );
  const route = {
    hostId: "host:test",
    workerInstanceId: "worker-instance",
    capabilityRef: "web",
    capabilityVersion: "1.0.0",
    maximumBytes: 4096,
    scopeSource: "private_temp" as const,
  };
  return {
    ...base,
    coding: {
      ...base.coding,
      enabledTools: [
        "read",
        "write",
        "edit",
        "bash",
        "find",
        "grep",
        "ls",
        "move_directory",
        "save_copy",
      ] as const,
    },
    publicSearch: route,
    publicFetch: route,
    backgroundCommands: { waitMs: 1000, maximumMs: 1000 },
    managedTasks: { execute: vi.fn() },
    taskHandle: async () => true,
    memoryRecall: {
      recallWithClassification: async () => ({
        output: {},
        contentClassification: "private" as const,
        memoryIds: [],
      }),
    },
    reminders: { run: vi.fn(async () => ({})) },
    ownerRules: { run: vi.fn(async () => ({})) },
  } satisfies ProductionRuntimeToolsOptions;
}

it("[ADR-0257] offers every tool through the action registry with unchanged definitions and order", async () => {
  const f = fixture();
  const descriptors = await new ProductionRuntimeTools(everyToolOptions(f)).listAuthorized(
    invocation.runId,
    [invocation.capabilityHandleRef],
  );
  expect(descriptors.map(({ name }) => name)).toEqual(EVERY_TOOL_NAMES);
  expect(createHash("sha256").update(JSON.stringify(descriptors)).digest("hex")).toBe(
    EVERY_TOOL_DEFINITIONS_SHA256,
  );
  const withoutRegistry = new ToolActionRegistry(
    PRODUCTION_TOOL_ACTION_ROWS.filter(({ tool }) => tool !== "reminder_set"),
  );
  const fewer = await new ProductionRuntimeTools({
    ...everyToolOptions(f),
    toolActions: withoutRegistry,
  }).listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
  expect(fewer.map(({ name }) => name)).toEqual(
    EVERY_TOOL_NAMES.filter((name) => name !== "reminder_set"),
  );
});

it("[ADR-0257] refuses a tool with consequences when no authorization exit is wired, and still reads", async () => {
  const f = fixture();
  const run = vi.fn(async () => ({ reminders: [] }));
  const tools = new ProductionRuntimeTools({ ...f.options, reminders: { run } });
  await tools.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
  const set = {
    ...invocation,
    capabilityRef: "reminder.set",
    capabilityHandleRef: null,
    arguments: { text: "交周报", due: "2026-11-06T15:00" },
  };
  expect((await tools.preflight(set)).allowed).toBe(false);
  await expect(tools.execute(set)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  const list = { ...set, capabilityRef: "reminder.list", toolCallId: "list", arguments: {} };
  expect((await tools.preflight(list)).allowed).toBe(true);
  expect(await tools.execute(list)).toMatchObject({ outcome: "succeeded" });
  expect(run).toHaveBeenCalledTimes(1);
});

it("[ADR-0257] reports a failed check and does nothing when the authorization exit breaks, then works once it recovers", async () => {
  const f = fixture();
  const run = vi.fn(async () => ({ created: true }));
  const authorize = vi
    .fn()
    .mockRejectedValueOnce(new Error("state store unavailable"))
    .mockResolvedValue(OWNER_SCOPE_ALLOW);
  const tools = new ProductionRuntimeTools({
    ...f.options,
    reminders: { run },
    ownerScope: { authorize } as unknown as NonNullable<
      ProductionRuntimeToolsOptions["ownerScope"]
    >,
  });
  await tools.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
  const set = {
    ...invocation,
    capabilityRef: "reminder.set",
    capabilityHandleRef: null,
    arguments: { text: "交周报", due: "2026-11-13T15:00" },
  };
  const broken = await tools.execute(set);
  expect(broken).toMatchObject({
    outcome: "failed",
    errorCode: "authorization_component_error",
    dispatchState: "not_sent",
  });
  expect(broken.modelContent).not.toContain("state store unavailable");
  expect(run).not.toHaveBeenCalled();
  const diagnostics = () =>
    [...f.artifacts.keys()].filter((key) => key.startsWith("runtime-tool-diagnostic:"));
  expect(diagnostics()).toHaveLength(1);
  const artifacts = f.options.artifacts as { commit: typeof f.options.artifacts.commit };
  const commit = artifacts.commit;
  artifacts.commit = async (input) => {
    if (input.operationKey.startsWith("runtime-tool-diagnostic:")) throw new Error("disk full");
    return commit(input);
  };
  authorize.mockRejectedValueOnce(new TypeError("state store unavailable"));
  expect(await tools.execute({ ...set, toolCallId: "unrecorded" })).toMatchObject({
    outcome: "failed",
    errorCode: "authorization_component_error",
  });
  expect(diagnostics()).toHaveLength(1);
  artifacts.commit = commit;
  expect(await tools.execute(set)).toMatchObject({ outcome: "succeeded" });
  expect(run).toHaveBeenCalledTimes(1);
});

it("[ADR-0257] throws instead of reporting a failed check when the run has stopped or the call was cancelled while the exit broke", async () => {
  const f = fixture();
  const run = vi.fn(async () => ({ created: true }));
  const assertRunActive = vi.fn(async () => undefined);
  const authorize = vi.fn(async () => {
    throw new Error("state store unavailable");
  });
  const tools = new ProductionRuntimeTools({
    ...f.options,
    assertRunActive,
    reminders: { run },
    ownerScope: { authorize } as unknown as NonNullable<
      ProductionRuntimeToolsOptions["ownerScope"]
    >,
  });
  await tools.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
  const set = {
    ...invocation,
    capabilityRef: "reminder.set",
    capabilityHandleRef: null,
    arguments: { text: "交周报", due: "2026-11-13T15:00" },
  };
  const controller = new AbortController();
  authorize.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error("state store unavailable");
  });
  await expect(
    tools.execute({ ...set, toolCallId: "cancelled" }, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  authorize.mockImplementationOnce(async () => {
    assertRunActive.mockRejectedValue(new Error("RUN_STOPPED"));
    throw new Error("state store unavailable");
  });
  await expect(tools.execute({ ...set, toolCallId: "stopped" })).rejects.toThrow("RUN_STOPPED");
  expect(run).not.toHaveBeenCalled();
  expect(
    [...f.artifacts.keys()].filter((key) => key.startsWith("runtime-tool-diagnostic:")),
  ).toEqual([]);
});

it("[ADR-0257] only the three listing and recall tools skip the authorization exit among the built-in tools", () => {
  const builtin = PRODUCTION_TOOL_ACTION_ROWS.filter(({ family }) => family === "builtin");
  expect(
    builtin.filter(({ authorization }) => authorization === "read").map(({ tool }) => tool),
  ).toEqual(["recall", "reminder_list", "rule_list"]);
  expect(
    builtin
      .filter(({ authorization }) => authorization === "owner_scope")
      .map(({ tool }) => tool)
      .sort(),
  ).toEqual(["reminder_cancel", "reminder_set", "rule_set", "rule_undo"]);
  expect(builtin).toHaveLength(7);
});

it("[ADR-0257] runs a tool with consequences only after the exit allows it, and never asks the exit for a read", async () => {
  const f = fixture();
  const run = vi.fn(async () => ({ created: true }));
  const decisions: unknown[] = [
    { decision: "DENY", reasonCode: "action_rule_refused", alternativesAllowed: true },
    {
      decision: "ASK",
      approvalRequest: { id: "approval:1", semanticSnapshotHash: "hash", expiresAt: now },
    },
    OWNER_SCOPE_ALLOW,
  ];
  const authorize = vi.fn(async () => decisions.shift());
  const tools = new ProductionRuntimeTools({
    ...f.options,
    reminders: { run },
    ownerRules: { run },
    ownerScope: { authorize } as unknown as NonNullable<
      ProductionRuntimeToolsOptions["ownerScope"]
    >,
  });
  await tools.listAuthorized(invocation.runId, [invocation.capabilityHandleRef]);
  const call = {
    ...invocation,
    capabilityRef: "rule.set",
    capabilityHandleRef: null,
    arguments: { text: "以后账单邮件都提醒我" },
  };
  expect(await tools.execute(call)).toMatchObject({
    outcome: "failed",
    errorCode: "action_rule_refused",
    dispatchState: "not_sent",
  });
  expect(await tools.execute(call)).toMatchObject({
    outcome: "awaiting_approval",
    approval: { approvalRequestId: "approval:1" },
  });
  expect(run).not.toHaveBeenCalled();
  const done = await tools.execute(call);
  expect(done).toMatchObject({ outcome: "succeeded" });
  expect(await tools.execute(call)).toEqual(done);
  expect(run).toHaveBeenCalledTimes(1);
  expect(authorize).toHaveBeenCalledTimes(3);
  expect(
    (authorize.mock.calls as unknown as readonly (readonly unknown[])[])[0]?.[1],
  ).toMatchObject({ tool: "rule_set", standingRuleChange: true });
  await tools.execute({ ...call, capabilityRef: "rule.list", toolCallId: "list", arguments: {} });
  expect(authorize).toHaveBeenCalledTimes(3);
});

const EVERY_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "find",
  "grep",
  "ls",
  "move_directory",
  "save_copy",
  "web_search",
  "web_fetch",
  "authorized_945a82d2850afbce529963f7",
  "execution_task_status",
  "execution_task_output",
  "execution_task_cancel",
  "execution_task_start",
  "recall",
  "reminder_set",
  "reminder_list",
  "reminder_cancel",
  "rule_set",
  "rule_list",
  "rule_undo",
];
const EVERY_TOOL_DEFINITIONS_SHA256 =
  "dcd8b2fa91a7a49f343bbbe54143739053a1329d1fb5754e6114220336109770";
