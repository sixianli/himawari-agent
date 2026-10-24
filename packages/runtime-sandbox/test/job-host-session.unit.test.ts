import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobHostRequest } from "../src/job-host-protocol.ts";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork }));

import { JobHostPreparationError, prepareSandboxJobSession } from "../src/job-host-session.ts";

function request(): JobHostRequest {
  return {
    jobId: "job",
    attemptId: "attempt",
    policy: {
      workspace: "/workspace",
      privateDirectory: "/private-job",
      writable: true,
      readOnlyToolchainPaths: [],
      protectedPaths: [],
      allowedDomains: [],
    },
    policyDigest: "a".repeat(64),
    executable: "/bin/echo",
    args: ["value"],
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    maxOutputBytes: 4096,
    cleanupTimeoutMs: 10,
  };
}

function runInput(attemptId: string, overrides: Record<string, unknown> = {}) {
  return {
    attemptId,
    policyDigest: "a".repeat(64),
    deadlineAt: new Date(Date.now() + 5000).toISOString(),
    maxOutputBytes: 512,
    inputBase64: Buffer.from("input").toString("base64"),
    resourceLimits: { maxCpuTimeMs: 1000, maxMemoryBytes: 10000 },
    ...overrides,
  };
}

function child() {
  const process = Object.assign(new EventEmitter(), {
    connected: true,
    pid: 12345,
    stderr: new PassThrough(),
    send: vi.fn(),
  });
  vi.spyOn(globalThis.process, "kill").mockImplementation(() => true);
  fork.mockReturnValue(process);
  let sequence = 0;
  return Object.assign(process, {
    emitMessage(message: Record<string, unknown>) {
      process.emit("message", {
        protocolVersion: "job-host.v2",
        sessionId: process.send.mock.calls[0]?.[0].sessionId,
        bootId: "11111111-1111-1111-1111-111111111111",
        processId: process.pid,
        processIdentityRef: "job-host-process:11111111-1111-1111-1111-111111111111",
        processStartedAt: "2026-09-14T00:00:00.000Z",
        observedAt: new Date().toISOString(),
        sequence: ++sequence,
        ...message,
      });
    },
  });
}

type FakeChild = ReturnType<typeof child>;

function ready(process: FakeChild) {
  process.emitMessage({
    type: "ready",
    jobId: "job",
    attemptId: "attempt",
    policyDigest: "a".repeat(64),
    residentProcessId: 4321,
  });
}

function started(process: FakeChild, attemptId: string, pid = 4321) {
  process.emitMessage({
    type: "started",
    attemptId,
    pid,
    taskIdentityRef: "sandbox-process:22222222-2222-2222-2222-222222222222",
    taskStartedAt: new Date().toISOString(),
  });
}

function commandResult(
  process: FakeChild,
  attemptId: string,
  sequence: number,
  overrides: Record<string, unknown> = {},
) {
  process.emitMessage({
    type: "command_result",
    attemptId,
    runSequence: sequence,
    reason: "exited",
    exitCode: 0,
    resources: null,
    taskStarted: true,
    taskProcessExited: true,
    stdioClosed: true,
    processGroupGone: true,
    namespace: "resident_intact",
    namespaceSwept: false,
    cleanedUp: true,
    ...overrides,
  });
}

const cancelled = (process: FakeChild) =>
  process.send.mock.calls.some(
    ([message]) => message.type === "cancel" && message.reason === "host_failure",
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("[R2-P2] Worker-side Job Host session client", () => {
  it("[R2-P2] prepares a session without a control binding and refuses an early run", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    expect(process.send.mock.calls[0]?.[0]).toMatchObject({ type: "prepare", session: true });
    expect(process.send.mock.calls[0]?.[0]).not.toHaveProperty("control");
    expect(() => session.run(runInput("one"), async () => {})).toThrow("JOB_HOST_RUN_NOT_ALLOWED");
    process.emit("close");
    await session.ready.catch(() => {});
    await session.result;
  });

  it("hands the host's latest preparation steps to the caller once ready", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    const steps = [
      { stage: "dependencies", startedMs: 3, elapsedMs: 40 },
      { stage: "launch", startedMs: 43, elapsedMs: null },
    ];
    process.emitMessage({ type: "heartbeat", steps });
    ready(process);
    expect(await session.ready).toEqual({ residentProcessId: 4321, hostSteps: steps });
    process.emit("close");
    await session.result;
  });

  it("[R2-P2] runs two commands in order with their own output and settled results", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    const authorize = vi.fn(async () => {});
    const first = session.run(runInput("one"), authorize);
    expect(process.send.mock.calls.at(-1)?.[0].run).toMatchObject({
      attemptId: "one",
      sequence: 1,
    });
    started(process, "one");
    process.emitMessage({
      type: "output",
      attemptId: "one",
      channel: "stdout",
      bytes: Buffer.from("first").toString("base64"),
    });
    expect(Buffer.from(first.readOutput(0, 5).bytes).toString()).toBe("first");
    commandResult(process, "one", 1);
    expect(await first.result).toMatchObject({
      attemptId: "one",
      sequence: 1,
      reason: "exited",
      exitCode: 0,
      taskStarted: true,
      taskProcessExited: true,
      stdioClosed: true,
      processGroupGone: true,
      namespace: "resident_intact",
      namespaceSwept: false,
      cleanedUp: true,
      settled: true,
      stdout: expect.any(Uint8Array),
      stderr: expect.any(Uint8Array),
    });
    const second = session.run(runInput("two"), authorize);
    expect(process.send.mock.calls.at(-1)?.[0].run).toMatchObject({
      attemptId: "two",
      sequence: 2,
    });
    started(process, "two");
    process.emitMessage({
      type: "output",
      attemptId: "two",
      channel: "stdout",
      bytes: Buffer.from("second").toString("base64"),
    });
    expect(Buffer.from(second.readOutput(0, 6).bytes).toString()).toBe("second");
    commandResult(process, "two", 2);
    expect(await second.result).toMatchObject({ attemptId: "two", sequence: 2, settled: true });
    process.emit("close");
    await session.result;
  });

  it("[R2-P2] refuses a second command while the first has no result", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    session.run(runInput("one"), async () => {});
    expect(() => session.run(runInput("two"), async () => {})).toThrow("JOB_HOST_RUN_NOT_ALLOWED");
    process.emit("close");
    await session.result;
  });

  it.each(["attemptId", "sequence", "output"])(
    "[R2-P2] closes the session on a %s violation",
    async (kind) => {
      const process = child();
      const session = prepareSandboxJobSession(request());
      ready(process);
      await session.ready;
      const run = session.run(runInput("one"), async () => {});
      started(process, "one");
      if (kind === "attemptId")
        process.emitMessage({
          type: "output",
          attemptId: "other",
          channel: "stdout",
          bytes: Buffer.from("x").toString("base64"),
        });
      else if (kind === "sequence") commandResult(process, "one", 2);
      else
        process.emitMessage({
          type: "output",
          attemptId: "one",
          channel: "stdout",
          bytes: Buffer.alloc(513).toString("base64"),
        });
      expect(cancelled(process)).toBe(true);
      expect(await run.result).toMatchObject({ settled: false });
      process.emit("close");
      await session.result;
    },
  );

  it("[R2-P2] closes the session when a result claims a start that never happened", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    const run = session.run(runInput("one"), async () => {});
    commandResult(process, "one", 1);
    expect(cancelled(process)).toBe(true);
    expect(await run.result).toMatchObject({ settled: false });
    process.emit("close");
    await session.result;
  });

  it.each([
    ["missing", {}],
    ["fractional", { residentProcessId: 1.5 }],
    ["the reserved init pid", { residentProcessId: 1 }],
  ])(
    "[R2-P2] closes the session when ready omits a usable resident process id (%s)",
    async (_kind, override) => {
      const process = child();
      const session = prepareSandboxJobSession(request());
      process.emitMessage({
        type: "ready",
        jobId: "job",
        attemptId: "attempt",
        policyDigest: "a".repeat(64),
        ...override,
      });
      expect(cancelled(process)).toBe(true);
      process.emit("close");
      await expect(session.ready).rejects.toThrow("JOB_HOST_NOT_READY");
      await session.result;
    },
  );

  it("[R2-P2] rejects readiness with the host's preparation diagnostic when the host closes before ready", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    process.emitMessage({ type: "diagnostic", stage: "sdk_initialize", systemCode: "EIO" });
    process.emit("close");
    const failure = await session.ready.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobHostPreparationError);
    expect(failure).toMatchObject({
      message: "JOB_HOST_NOT_READY",
      diagnostic: { stage: "sdk_initialize", systemCode: "EIO" },
    });
    expect(failure).not.toHaveProperty("code");
    expect((await session.result).diagnostic).toEqual({
      stage: "sdk_initialize",
      systemCode: "EIO",
    });
  });

  it("[R2-P2] rejects readiness without a diagnostic when the host closes silently", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    process.emit("close");
    const failure = await session.ready.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobHostPreparationError);
    expect(failure).toMatchObject({ message: "JOB_HOST_NOT_READY", diagnostic: undefined });
    await session.result;
  });

  it("[R2-D23] waits for a slow session host before supervising it", async () => {
    vi.useFakeTimers();
    const process = child();
    const session = prepareSandboxJobSession(request());
    await vi.advanceTimersByTimeAsync(5000);
    expect(process.send.mock.calls.map(([message]) => message.type)).toEqual(["prepare"]);
    ready(process);
    await session.ready;
    expect(session.inspect()?.state).toBe("alive");
    process.emit("close");
    await session.result;
  });

  it("[R2-D23] ends a session host that never reports within the startup window", async () => {
    vi.useFakeTimers();
    const process = child();
    const session = prepareSandboxJobSession(request());
    await vi.advanceTimersByTimeAsync(9900);
    expect(cancelled(process)).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(cancelled(process)).toBe(true);
    process.emit("close");
    await expect(session.ready).rejects.toThrow("JOB_HOST_NOT_READY");
    expect(await session.result).toMatchObject({ reason: "host_failure" });
  });

  it("[R2-D23] keeps the original lease once the session host has reported", async () => {
    vi.useFakeTimers();
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    await vi.advanceTimersByTimeAsync(1750);
    expect(cancelled(process)).toBe(true);
    process.emit("close");
    await session.result;
  });

  it("[R2-P2] closes the session when a start names a process other than the resident one", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    const run = session.run(runInput("one"), async () => {});
    started(process, "one", 4322);
    expect(cancelled(process)).toBe(true);
    expect(await run.result).toMatchObject({ settled: false });
    process.emit("close");
    await session.result;
  });

  it("passes on a namespace-wide sweep reported with a gone command tree", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    const run = session.run(runInput("one"), async () => {});
    started(process, "one");
    commandResult(process, "one", 1, { namespaceSwept: true });
    expect(await run.result).toMatchObject({ settled: true, namespaceSwept: true });
    process.emit("close");
    await session.result;
  });

  it.each([
    ["missing", { namespaceSwept: undefined }],
    ["claimed while the command tree remains", { namespaceSwept: true, processGroupGone: false }],
  ])("closes the session when the namespace sweep flag is %s", async (_label, overrides) => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    const run = session.run(runInput("one"), async () => {});
    started(process, "one");
    commandResult(process, "one", 1, overrides);
    expect(cancelled(process)).toBe(true);
    expect(await run.result).toMatchObject({ settled: false, namespaceSwept: false });
    process.emit("close");
    await session.result;
  });

  it("[R2-P2] closes the session when a command reports the retired released namespace", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    const run = session.run(runInput("one"), async () => {});
    started(process, "one");
    commandResult(process, "one", 1, { namespace: "released" });
    expect(cancelled(process)).toBe(true);
    expect(await run.result).toMatchObject({ settled: false });
    process.emit("close");
    await session.result;
  });

  it.each(["deadline", "output_limit", "resource_limit", "cancelled"] as const)(
    "[R2-P2] closes the session when a %s command reports an exit code",
    async (reason) => {
      const process = child();
      const session = prepareSandboxJobSession(request());
      ready(process);
      await session.ready;
      const run = session.run(runInput("one"), async () => {});
      started(process, "one");
      commandResult(process, "one", 1, { reason, exitCode: 137 });
      expect(cancelled(process)).toBe(true);
      expect(await run.result).toMatchObject({ settled: false });
      process.emit("close");
      await session.result;
    },
  );

  it("[R2-P2] settles a command that reports a non-exit reason without an exit code", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    const run = session.run(runInput("one"), async () => {});
    started(process, "one");
    commandResult(process, "one", 1, { reason: "deadline", exitCode: null });
    expect(await run.result).toMatchObject({
      settled: true,
      reason: "deadline",
      exitCode: null,
    });
    expect(cancelled(process)).toBe(false);
    process.emit("close");
    await session.result;
  });

  it("[R2-P2] marks an alive namespace as unsettled without closing the session", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    const run = session.run(runInput("one"), async () => {});
    started(process, "one");
    commandResult(process, "one", 1, {
      reason: "host_failure",
      exitCode: null,
      namespace: "alive",
    });
    expect(await run.result).toMatchObject({ settled: false, namespace: "alive" });
    expect(process.send.mock.calls.some(([message]) => message.type === "cancel")).toBe(false);
    process.emit("close");
    await session.result;
  });

  it("[R2-P2] answers an authority check from the running command", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    const authorize = vi.fn(async () => {});
    session.run(runInput("one"), authorize);
    started(process, "one");
    process.emitMessage({ type: "authority_check", checkId: 1 });
    await vi.waitFor(() =>
      expect(process.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "authority_result", checkId: 1, allowed: true }),
        expect.any(Function),
      ),
    );
    expect(authorize).toHaveBeenCalledOnce();
    process.emit("close");
    await session.result;
  });

  it("[R2-P2] denies an authority check whose authorize throws", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    session.run(runInput("one"), async () => {
      throw new Error("revoked");
    });
    started(process, "one");
    process.emitMessage({ type: "authority_check", checkId: 1 });
    await vi.waitFor(() =>
      expect(process.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "authority_result", checkId: 1, allowed: false }),
        expect.any(Function),
      ),
    );
    process.emit("close");
    await session.result;
  });

  it("[R2-P2] closes the session on an authority check without a running command", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    process.emitMessage({ type: "authority_check", checkId: 1 });
    expect(cancelled(process)).toBe(true);
    process.emit("close");
    await session.result;
  });

  it("[R2-P2] cancels its own overdue command and then the session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    const run = session.run(
      runInput("one", { deadlineAt: new Date(Date.now() + 1000).toISOString() }),
      async () => {},
    );
    started(process, "one");
    for (let elapsed = 0; elapsed < 4200; elapsed += 200) {
      process.emitMessage({ type: "heartbeat", steps: [] });
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(
      process.send.mock.calls.some(
        ([message]) =>
          message.type === "run_cancel" &&
          message.attemptId === "one" &&
          message.reason === "deadline",
      ),
    ).toBe(true);
    expect(cancelled(process)).toBe(true);
    expect(await run.result).toMatchObject({ settled: false });
    process.emit("close");
    await session.result;
  });

  it("[R2-P2] ends a running command when the child closes", async () => {
    const process = child();
    const session = prepareSandboxJobSession(request());
    ready(process);
    await session.ready;
    const run = session.run(runInput("one"), async () => {});
    started(process, "one");
    process.emit("close");
    expect(await run.result).toMatchObject({ settled: false });
    expect(await session.result).toMatchObject({ reason: "host_failure" });
  });

  it.each(["sequence", "bootId", "processId"])(
    "[R2-P2] closes the session on a %s envelope violation",
    async (kind) => {
      const process = child();
      const session = prepareSandboxJobSession(request());
      ready(process);
      await session.ready;
      const overrides =
        kind === "sequence"
          ? { sequence: 9 }
          : kind === "bootId"
            ? { bootId: "22222222-2222-2222-2222-222222222222" }
            : { processId: 999 };
      process.emitMessage({ type: "heartbeat", steps: [], ...overrides });
      expect(cancelled(process)).toBe(true);
      process.emit("close");
      await session.result;
    },
  );
});
