import type {
  RuntimeBackgroundCommandNotice,
  RuntimeToolExecutionResult,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_COMMAND_REF_PREFIX,
  backgroundCommandLimits,
  ProductionBackgroundCommands,
} from "../src/production-background-commands.js";

const bash = {
  runId: "run-background",
  toolCallId: "call-tests",
  capabilityRef: "project.coding.bash",
  capabilityHandleRef: null,
  arguments: { command: "npm test" },
  dataClassification: "private",
  executionDeadlineAt: "2099-01-01T00:00:00.000Z",
} as unknown as RuntimeToolInvocation;

function finished(modelContent: string): RuntimeToolExecutionResult {
  return {
    outcome: "succeeded",
    resultRef: "payload-result",
    errorCode: null,
    externalActionId: null,
    modelContent,
  };
}

function controlled() {
  let resolve: (value: RuntimeToolExecutionResult) => void = () => undefined;
  let received: AbortSignal | undefined;
  const result = new Promise<RuntimeToolExecutionResult>((done) => {
    resolve = done;
  });
  const execute = vi.fn((signal: AbortSignal) => {
    received = signal;
    signal.addEventListener("abort", () =>
      resolve({
        outcome: "result_unknown",
        resultRef: null,
        errorCode: "WORKER_AUTHORITY_WITHDRAWN",
        externalActionId: null,
        modelContent: "执行许可已失效，已请求停止。",
      }),
    );
    return result;
  });
  return { execute, resolve, signal: () => received };
}

function commands(waitMs = 20) {
  const receipts: unknown[] = [];
  const background = new ProductionBackgroundCommands({
    limits: { waitMs, maximumMs: 60_000 },
    now: () => new Date().toISOString(),
  });
  const receipt = async (value: unknown) => {
    receipts.push(value);
    return { ref: `receipt-${receipts.length}` };
  };
  return { background, receipt, receipts };
}

function manage(action: string, resourceRef: string, extra: Record<string, unknown> = {}) {
  return {
    ...bash,
    toolCallId: `manage-${action}-${Math.random()}`,
    capabilityRef: `execution.task.${action}`,
    arguments: { resourceRef, ...extra },
  } as RuntimeToolInvocation;
}

function taskRefOf(result: RuntimeToolExecutionResult): string {
  const match = result.modelContent.match(/background-command:[0-9a-f]{24}/);
  if (!match) throw new Error("task ref missing");
  return match[0];
}

describe("ProductionBackgroundCommands", () => {
  it("returns a command that finishes inside the wait window unchanged", async () => {
    const { background, receipt, receipts } = commands();
    const result = await background.run(bash, undefined, async () => finished("exit 0"), receipt);
    expect(result.modelContent).toBe("exit 0");
    expect(receipts).toHaveLength(0);
    expect(background.running(bash.runId)).toBe(0);
  });

  it("moves a slow command to the background and notifies once with its result", async () => {
    const { background, receipt } = commands();
    const command = controlled();
    const notices: RuntimeBackgroundCommandNotice[] = [];
    background.subscribe(bash.runId, (notice) => {
      notices.push(notice);
      return true;
    });
    const moved = await background.run(bash, undefined, command.execute, receipt);
    expect(moved).toMatchObject({ outcome: "succeeded", resultRef: "receipt-1" });
    expect(moved.modelContent).toContain("已转入后台继续运行，没有被停止");
    expect(moved.modelContent).toContain("不需要反复查询状态");
    expect(command.signal()?.aborted).toBe(false);
    expect(background.running(bash.runId)).toBe(1);
    command.resolve(finished("Tests 42 passed"));
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]?.taskRef).toBe(taskRefOf(moved));
    expect(notices[0]?.modelContent).toContain("Tests 42 passed");
    expect(notices[0]?.modelContent).toContain("命令：npm test");
    expect(background.running(bash.runId)).toBe(0);
  });

  it("keeps a notice that arrives before anyone listens", async () => {
    const { background, receipt } = commands();
    const command = controlled();
    await background.run(bash, undefined, command.execute, receipt);
    command.resolve(finished("done early"));
    await vi.waitFor(() => expect(background.running(bash.runId)).toBe(0));
    const notices: RuntimeBackgroundCommandNotice[] = [];
    background.subscribe(bash.runId, (notice) => {
      notices.push(notice);
      return true;
    });
    expect(notices.map((notice) => notice.modelContent).join("")).toContain("done early");
  });

  it("reports status, withholds output while running and pages it after the end", async () => {
    const { background, receipt } = commands();
    const command = controlled();
    const ref = taskRefOf(await background.run(bash, undefined, command.execute, receipt));
    const running = JSON.parse(
      (await background.manage(manage("status", ref), receipt)).modelContent,
    );
    expect(running).toMatchObject({ resourceRef: ref, status: "running", outcome: null });
    const early = JSON.parse(
      (await background.manage(manage("output", ref), receipt)).modelContent,
    );
    expect(early).toMatchObject({ status: "running", text: "", end: false });
    command.resolve(finished("abcdefghij"));
    await vi.waitFor(() => expect(background.running(bash.runId)).toBe(0));
    const first = JSON.parse(
      (await background.manage(manage("output", ref, { limit: 4 }), receipt)).modelContent,
    );
    expect(first).toMatchObject({ text: "abcd", nextCursor: "4", end: false });
    const rest = JSON.parse(
      (await background.manage(manage("output", ref, { cursor: "4", limit: 100 }), receipt))
        .modelContent,
    );
    expect(rest).toMatchObject({ text: "efghij", nextCursor: null, end: true });
  });

  it("stops a command on request and says so in the notice", async () => {
    const { background, receipt } = commands();
    const command = controlled();
    const notices: RuntimeBackgroundCommandNotice[] = [];
    background.subscribe(bash.runId, (notice) => {
      notices.push(notice);
      return true;
    });
    const ref = taskRefOf(await background.run(bash, undefined, command.execute, receipt));
    const stopped = JSON.parse(
      (await background.manage(manage("cancel", ref), receipt)).modelContent,
    );
    expect(command.signal()?.aborted).toBe(true);
    expect(stopped).toMatchObject({ status: "stopped" });
    expect(notices[0]?.modelContent).toContain("已按要求停止");
  });

  it("stops every command of a Run when the Run ends without sending a notice", async () => {
    const { background, receipt } = commands();
    const command = controlled();
    const notices: RuntimeBackgroundCommandNotice[] = [];
    background.subscribe(bash.runId, (notice) => {
      notices.push(notice);
      return true;
    });
    await background.run(bash, undefined, command.execute, receipt);
    await background.stopRun(bash.runId);
    expect(command.signal()?.aborted).toBe(true);
    expect(notices).toHaveLength(0);
    expect(background.running(bash.runId)).toBe(0);
    expect(background.held(bash.runId)).toEqual([]);
  });

  it("[BG-2] keeps running after the caller's signal ends once the command is in the background", async () => {
    const { background, receipt } = commands();
    const command = controlled();
    const caller = new AbortController();
    await background.run(bash, caller.signal, command.execute, receipt);
    caller.abort();
    expect(command.signal()?.aborted).toBe(false);
    expect(background.held(bash.runId)).toHaveLength(1);
  });

  it("[BG-2] stops a command whose caller gives up inside the wait window", async () => {
    const { background, receipt } = commands(200);
    const command = controlled();
    const caller = new AbortController();
    const result = background.run(bash, caller.signal, command.execute, receipt);
    caller.abort();
    expect((await result).outcome).toBe("result_unknown");
    expect(background.held(bash.runId)).toEqual([]);
  });

  it("[BG-2] holds a finished result nobody received and reports it once settled", async () => {
    const { background, receipt } = commands();
    const command = controlled();
    const ref = taskRefOf(await background.run(bash, undefined, command.execute, receipt));
    background.subscribe(bash.runId, () => false)();
    const settled = background.settled(bash.runId);
    command.resolve(finished("Tests 42 passed"));
    expect(await settled).toEqual([
      expect.objectContaining({ taskRef: ref, outcome: "completed", delivered: false }),
    ]);
    expect(background.held(bash.runId).map((hold) => hold.taskRef)).toEqual([ref]);
  });

  it("keeps only the command's own output lines for the web, not the tool envelope", async () => {
    const { background, receipt } = commands();
    const command = controlled();
    await background.run(bash, undefined, command.execute, receipt);
    const settled = background.settled(bash.runId);
    command.resolve(
      finished(
        JSON.stringify({
          schemaVersion: "pi-result.v1",
          tool: "bash",
          isError: false,
          content: [{ type: "text", text: "Test Files  3 passed\nTests  42 passed\n" }],
          details: {},
          fullOutput: null,
          commandExitCode: 0,
          source: { toolCallId: "call-tests" },
        }),
      ),
    );
    expect((await settled)[0]?.output).toBe("Test Files  3 passed\nTests  42 passed");
  });

  it("[BG-2] marks a requested stop and lets another Run of the same thread read it", async () => {
    const { background, receipt } = commands();
    const command = controlled();
    const threaded = {
      ...bash,
      context: { threadId: "thread-background" },
    } as unknown as RuntimeToolInvocation;
    const ref = taskRefOf(await background.run(threaded, undefined, command.execute, receipt));
    await background.cancelRun(bash.runId);
    expect(await background.settled(bash.runId)).toEqual([
      expect.objectContaining({ taskRef: ref, outcome: "stopped" }),
    ]);
    const later = {
      ...manage("status", ref),
      runId: "run-later",
      context: { threadId: "thread-background" },
    } as unknown as RuntimeToolInvocation;
    expect(JSON.parse((await background.manage(later, receipt)).modelContent)).toMatchObject({
      status: "stopped",
    });
  });

  it("refuses to manage a command that belongs to another Run", async () => {
    const { background, receipt } = commands();
    const command = controlled();
    const ref = taskRefOf(await background.run(bash, undefined, command.execute, receipt));
    expect(
      await background.manage(
        { ...manage("cancel", ref), runId: "another-run" } as RuntimeToolInvocation,
        receipt,
      ),
    ).toMatchObject({ outcome: "failed", errorCode: "BACKGROUND_COMMAND_NOT_FOUND" });
    expect(command.signal()?.aborted).toBe(false);
    expect(background.manages(manage("status", ref))).toBe(true);
    expect(background.manages(manage("status", "task-resource"))).toBe(false);
    expect(ref.startsWith(BACKGROUND_COMMAND_REF_PREFIX)).toBe(true);
  });

  it("caps the wait window at the configured maximum", () => {
    expect(backgroundCommandLimits({})).toEqual({ waitMs: 30_000, maximumMs: 1_800_000 });
    expect(backgroundCommandLimits({ commandWaitMs: 60_000, backgroundCommandMs: 10_000 })).toEqual(
      { waitMs: 10_000, maximumMs: 10_000 },
    );
  });
});
