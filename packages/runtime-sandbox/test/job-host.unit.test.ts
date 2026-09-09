import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type JobHostRequest,
  parseJobHostRequest,
  quoteJobArgument,
} from "../src/job-host-protocol.ts";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork }));

import { prepareSandboxJobHost } from "../src/job-host.ts";

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
    deadlineAt: new Date(Date.now() + 10000).toISOString(),
    maxOutputBytes: 16,
    cleanupTimeoutMs: 10,
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
  const startedAt = new Date().toISOString();
  return Object.assign(process, {
    emitMessage(message: Record<string, unknown>) {
      process.emit("message", {
        protocolVersion: "job-host.v2",
        sessionId: process.send.mock.calls[0]?.[0].sessionId,
        bootId: "11111111-1111-1111-1111-111111111111",
        processId: process.pid,
        processIdentityRef: "job-host-process:11111111-1111-1111-1111-111111111111",
        processStartedAt: startedAt,
        observedAt: new Date().toISOString(),
        sequence: ++sequence,
        ...message,
      });
    },
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("Job Host admission and observation", () => {
  it("separates task acknowledgement from preparation and reads bounded output without restarting", async () => {
    const process = child();
    const input = request();
    const host = prepareSandboxJobHost(input);
    process.emitMessage({
      type: "ready",
      jobId: "job",
      attemptId: "attempt",
      policyDigest: input.policyDigest,
    });
    await host.ready;
    let acknowledged = false;
    void host.started.then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    host.start();
    process.emitMessage({
      type: "started",
      pid: 4321,
      taskIdentityRef: "sandbox-process:22222222-2222-2222-2222-222222222222",
      taskStartedAt: new Date().toISOString(),
    });
    expect((await host.started).processId).toBe(4321);
    process.emitMessage({
      type: "output",
      channel: "stdout",
      bytes: Buffer.from("abc").toString("base64"),
    });
    process.emitMessage({
      type: "output",
      channel: "stderr",
      bytes: Buffer.from("DEF").toString("base64"),
    });
    expect(Buffer.from(host.readOutput(2, 3).bytes).toString()).toBe("cDE");
    const first = host.readOutput(0, 2);
    first.bytes.fill(0);
    expect(Buffer.from(host.readOutput(0, 2).bytes).toString()).toBe("ab");
    expect(host.readOutput(6, 1)).toMatchObject({ nextOffset: 6, end: false });
    expect(() => host.readOutput(7, 1)).toThrow("CURSOR_INVALID");
    expect(() => host.readOutput(0, 1_048_577)).toThrow("CURSOR_INVALID");
    process.emit("close");
    await host.result;
    expect(host.readOutput(2, 10)).toMatchObject({ nextOffset: 6, end: true });
    expect(Buffer.from(host.readOutput(2, 10).bytes).toString()).toBe("cDEF");
    expect(process.send.mock.calls.filter(([m]) => m.type === "start")).toHaveLength(1);
  });
  it("does not invent a task acknowledgement when the start reply is lost", async () => {
    const process = child();
    const host = prepareSandboxJobHost(request());
    process.emitMessage({
      type: "ready",
      jobId: "job",
      attemptId: "attempt",
      policyDigest: "a".repeat(64),
    });
    await host.ready;
    host.start();
    process.emit("close");
    await expect(host.started).rejects.toThrow("START_UNCONFIRMED");
    expect((await host.result).taskStarted).toBeNull();
    expect(host.readOutput(0, 1).end).toBe(true);
  });
  it("freezes caller input and rejects malformed inputs before forking", () => {
    const input = request();
    const frozen = parseJobHostRequest(input);
    (input.args as string[]).push("later");
    expect(frozen.args).toEqual(["value"]);
    expect(() => parseJobHostRequest({ ...input, policy: null })).toThrow("POLICY_INVALID");
    expect(() => parseJobHostRequest({ ...input, executable: "echo" })).toThrow(
      "EXECUTABLE_INVALID",
    );
    expect(() => parseJobHostRequest({ ...input, args: ["\0"] })).toThrow("ARGS_INVALID");
    expect(() => parseJobHostRequest({ ...input, unexpected: true })).toThrow("INPUT_INVALID");
  });
  it("quotes apostrophes and shell metacharacters as literal argv", () => {
    expect(quoteJobArgument("a'$(id)*")).toBe("'a'\"'\"'$(id)*'");
  });
  it("requires ready and explicit start without inheriting host environment", async () => {
    const process = child();
    const input = request();
    const host = prepareSandboxJobHost(input);
    expect(() => host.start()).toThrow("START_NOT_ALLOWED");
    expect(process.send.mock.calls[0]?.[0]).toMatchObject({
      type: "prepare",
      request: input,
      protocolVersion: "job-host.v2",
    });
    const options = fork.mock.calls.at(-1)?.[2];
    expect(Object.keys(options.env).sort()).toEqual([
      "CLAUDE_CODE_TMPDIR",
      "HOME",
      "PATH",
      "TMPDIR",
    ]);
    expect(options.execArgv).toEqual([]);
    process.emitMessage({
      type: "ready",
      jobId: input.jobId,
      attemptId: input.attemptId,
      policyDigest: input.policyDigest,
    });
    await host.ready;
    expect(process.send).toHaveBeenCalledTimes(1);
    host.start();
    expect(() => host.start()).toThrow("START_NOT_ALLOWED");
    process.emit("close");
    expect((await host.result).taskStarted).toBeNull();
    expect((await host.result).taskTreeCleanup).toBe("unknown");
    expect(() => host.start()).toThrow("START_NOT_ALLOWED");
  });
  it("rejects changed policy identity and never starts on readiness failure", async () => {
    const process = child();
    const host = prepareSandboxJobHost(request());
    process.emitMessage({
      type: "ready",
      jobId: "job",
      attemptId: "attempt",
      policyDigest: "b".repeat(64),
    });
    process.emit("close");
    await expect(host.ready).rejects.toThrow("NOT_READY");
    expect((await host.result).taskStarted).toBe(false);
    expect(process.send.mock.calls.some(([m]) => m.type === "start")).toBe(false);
  });
  it("discards oversized output and keeps cleanup unknown after start intent", async () => {
    const process = child();
    const input = request();
    const host = prepareSandboxJobHost(input);
    process.emitMessage({
      type: "ready",
      jobId: "job",
      attemptId: "attempt",
      policyDigest: input.policyDigest,
    });
    await host.ready;
    host.start();
    process.emitMessage({
      type: "output",
      channel: "stdout",
      bytes: Buffer.alloc(17).toString("base64"),
    });
    process.emit("close");
    const result = await host.result;
    expect(result.stdout.byteLength).toBe(0);
    expect(result.taskTreeCleanup).toBe("unknown");
  });
});

it("bounds stdin and keeps binary input out of argv and the host environment", async () => {
  const bytes = Buffer.from([0, 255, 10, 39, 36]);
  const input = { ...request(), stdinBase64: bytes.toString("base64") };
  expect(parseJobHostRequest(input).stdinBase64).toBe(bytes.toString("base64"));
  for (const stdinBase64 of [
    "bad base64",
    "Zg",
    "Zh==",
    Buffer.alloc(49153).toString("base64"),
    undefined,
  ]) {
    expect(() => parseJobHostRequest({ ...input, stdinBase64 })).toThrow("STDIN_INVALID");
  }
  expect(
    parseJobHostRequest({ ...input, stdinBase64: Buffer.alloc(49152).toString("base64") }),
  ).toBeDefined();
  const process = child();
  const host = prepareSandboxJobHost(input);
  const options = fork.mock.calls.at(-1)?.[2];
  expect(JSON.stringify(options.env)).not.toContain(input.stdinBase64);
  expect(fork.mock.calls.at(-1)?.[1]).toEqual([]);
  expect(process.send.mock.calls[0]?.[0].request.stdinBase64).toBe(input.stdinBase64);
  process.emit("close");
  await host.result;
});

it("returns observed resource usage without converting it into cleanup confirmation", async () => {
  const process = child();
  const input = { ...request(), resourceLimits: { maxCpuTimeMs: 100, maxMemoryBytes: 1024 } };
  const host = prepareSandboxJobHost(input);
  process.emitMessage({
    type: "ready",
    jobId: "job",
    attemptId: "attempt",
    policyDigest: input.policyDigest,
  });
  await host.ready;
  host.start();
  const resources = { samples: 2, observedCpuTimeMs: 120, peakObservedMemoryBytes: 512 };
  process.emitMessage({
    type: "result",
    reason: "resource_limit",
    resources,
    taskStarted: true,
    taskProcessExited: true,
    stdioClosed: true,
    srtReset: true,
  });
  process.emit("close");
  expect(await host.result).toMatchObject({
    reason: "resource_limit",
    resources,
    taskTreeCleanup: "unknown",
  });
});

it("expires supervision and rejects replaced boot identities without granting a new start", async () => {
  vi.useFakeTimers();
  const process = child();
  const input = request();
  const host = prepareSandboxJobHost(input);
  process.emitMessage({
    type: "ready",
    jobId: input.jobId,
    attemptId: input.attemptId,
    policyDigest: input.policyDigest,
  });
  await host.ready;
  expect(host.inspect()).toMatchObject({ state: "alive", taskTreeGuarantee: "unverified" });
  process.emitMessage({ type: "heartbeat", bootId: "22222222-2222-2222-2222-222222222222" });
  expect(host.inspect()?.state).toBe("lost");
  expect(() => host.start()).toThrow();
  process.emit("close");
  await host.result;
});
it("requests stop when the owned IPC observation window expires", async () => {
  vi.useFakeTimers();
  const process = child();
  const input = request();
  const host = prepareSandboxJobHost(input);
  process.emitMessage({
    type: "ready",
    jobId: input.jobId,
    attemptId: input.attemptId,
    policyDigest: input.policyDigest,
  });
  await host.ready;
  host.start();
  await vi.advanceTimersByTimeAsync(2000);
  expect(
    process.send.mock.calls.some(
      ([message]) => message.type === "cancel" && message.reason === "host_failure",
    ),
  ).toBe(true);
  expect(host.inspect()?.state).toBe("lost");
  process.emit("close");
  expect((await host.result).taskTreeCleanup).toBe("unknown");
});

it("does not signal a reaped process id when its old pipes close", async () => {
  const process = child();
  const host = prepareSandboxJobHost(request());
  process.emit("exit", 0, null);
  process.emit("close", 0, null);
  await host.result;
  expect(globalThis.process.kill).not.toHaveBeenCalled();
});

it("renews the Worker lease while attached and stops renewing after completion", async () => {
  vi.useFakeTimers();
  const process = child();
  const host = prepareSandboxJobHost(request());
  await vi.advanceTimersByTimeAsync(500);
  const heartbeats = process.send.mock.calls.filter(([message]) => message.type === "heartbeat");
  expect(heartbeats.length).toBe(2);
  expect(heartbeats[1]?.[0].sequence).toBeGreaterThan(heartbeats[0]?.[0].sequence);
  process.emit("close");
  await host.result;
  const sent = process.send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(process.send.mock.calls.length).toBe(sent);
});

it("does not renew supervision from a delayed message", async () => {
  const process = child();
  const host = prepareSandboxJobHost(request());
  process.emitMessage({
    type: "ready",
    jobId: "job",
    attemptId: "attempt",
    policyDigest: "a".repeat(64),
  });
  await host.ready;
  process.emitMessage({ type: "heartbeat", observedAt: new Date(Date.now() - 2000).toISOString() });
  expect(host.inspect()?.state).toBe("lost");
  expect(() => host.start()).toThrow();
  process.emit("close");
  await host.result;
});
