import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseJobHostRequest,
  quoteJobArgument,
  type JobHostRequest,
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
    pid: undefined,
    stderr: new PassThrough(),
    send: vi.fn(),
  });
  fork.mockReturnValue(process);
  return process;
}
afterEach(() => vi.restoreAllMocks());
describe("Job Host admission and observation", () => {
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
    expect(process.send.mock.calls[0]?.[0]).toEqual({ type: "prepare", request: input });
    const options = fork.mock.calls.at(-1)?.[2];
    expect(Object.keys(options.env).sort()).toEqual([
      "CLAUDE_CODE_TMPDIR",
      "HOME",
      "PATH",
      "TMPDIR",
    ]);
    expect(options.execArgv).toEqual([]);
    process.emit("message", {
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
    process.emit("message", {
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
    process.emit("message", {
      type: "ready",
      jobId: "job",
      attemptId: "attempt",
      policyDigest: input.policyDigest,
    });
    await host.ready;
    host.start();
    process.emit("message", {
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
