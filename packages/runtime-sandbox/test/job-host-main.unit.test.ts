import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobHostRequest } from "../src/job-host-protocol.ts";

// Model only OS, IPC and SRT boundaries. The real entrypoint owns admission,
// ordering, output limits, namespace acknowledgement and cleanup decisions.
const boundary = vi.hoisted(() => ({
  process: {},
  spawn: vi.fn(),
  realpath: vi.fn(),
  compile: vi.fn(),
  control: vi.fn(),
  namespace: vi.fn(),
  egress: vi.fn(),
  readiness: vi.fn(),
  observe: vi.fn(),
  snapshot: vi.fn(),
  manager: {
    checkDependenciesAsync: vi.fn(),
    isSupportedPlatform: vi.fn(),
    initialize: vi.fn(),
    wrapWithSandboxArgv: vi.fn(),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn(),
  },
}));
vi.mock("node:process", () => ({ default: boundary.process }));
vi.mock("node:child_process", () => ({ spawn: boundary.spawn }));
vi.mock("node:fs/promises", () => ({ realpath: boundary.realpath }));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: boundary.manager }));
vi.mock("../src/policy.ts", () => ({ compileSandboxPolicy: boundary.compile }));
vi.mock("../src/job-host-control.ts", () => ({ openJobHostControl: boundary.control }));
vi.mock("../src/linux-namespace.ts", () => ({ captureLinuxNamespace: boundary.namespace }));
vi.mock("../src/network-egress.ts", () => ({ openNetworkEgress: boundary.egress }));
vi.mock("../src/readiness-probe.ts", () => ({ startReadinessProbe: boundary.readiness }));
vi.mock("../src/resource-observer.ts", () => ({
  observeTaskResources: boundary.observe,
  readProcessSnapshot: boundary.snapshot,
}));

const SESSION = "11111111-1111-1111-1111-111111111111";
const DIGEST = "a".repeat(64);
let listeners: Map<string, (...args: unknown[]) => void>;
let sent: Record<string, unknown>[];
let sequence: number;
let processBoundary: {
  env: Record<string, string>;
  platform: string;
  connected: boolean;
  send: ReturnType<typeof vi.fn> | undefined;
  disconnect: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  stderr: { write: ReturnType<typeof vi.fn> };
  exitCode?: number;
};
let task: EventEmitter & {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: string | null;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};
let network: {
  close: ReturnType<typeof vi.fn>;
  observation: ReturnType<typeof vi.fn>;
  parentProxy: string;
};
let control: { finish: ReturnType<typeof vi.fn> };
let resource: { stop: ReturnType<typeof vi.fn>; current: ReturnType<typeof vi.fn> };
const request = (): JobHostRequest => ({
  jobId: "job-entry",
  attemptId: "attempt-entry",
  policy: {
    workspace: "/workspace",
    privateDirectory: "/private-job",
    writable: true,
    readOnlyToolchainPaths: [],
    protectedPaths: [],
    allowedDomains: [],
  },
  policyDigest: DIGEST,
  executable: "/bin/echo",
  args: ["task input"],
  deadlineAt: new Date(Date.now() + 10000).toISOString(),
  maxOutputBytes: 16,
  cleanupTimeoutMs: 100,
});
const result = () => sent.findLast((item) => item["type"] === "result");
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}
async function load() {
  await import("../src/job-host-main.ts");
}
async function receive(type: string, fields: Record<string, unknown> = {}) {
  listeners.get("message")?.({
    protocolVersion: "job-host.v2",
    sessionId: SESSION,
    sequence: ++sequence,
    observedAt: new Date().toISOString(),
    type,
    ...fields,
  });
  await settle();
}
async function prepare(input = request(), extra: Record<string, unknown> = {}) {
  await load();
  await receive("prepare", { request: input, ...extra });
}
async function startLinux() {
  await receive("start");
  const command = boundary.manager.wrapWithSandboxArgv.mock.calls[0]?.[0] as string;
  const token = command.match(/printf '([a-f0-9-]+):/)?.[1];
  if (!token) throw new Error("Missing namespace handshake in actual command");
  task.stderr.write(Buffer.from(`${token}:1:pid:[9001]\n`));
  await settle();
}
async function closeTask(code = 0) {
  task.exitCode = code;
  task.emit("exit", code, null);
  task.emit("close", code, null);
  await settle();
}
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
  listeners = new Map();
  sent = [];
  sequence = 0;
  processBoundary = {
    env: { HOME: "/private-job", TMPDIR: "/private-job", CLAUDE_CODE_TMPDIR: "/private-job" },
    platform: "linux",
    connected: true,
    send: vi.fn((message, callback) => {
      sent.push(message);
      callback(null);
    }),
    disconnect: vi.fn(() => {
      processBoundary.connected = false;
      Object.assign(boundary.process, { connected: false });
    }),
    kill: vi.fn(),
    exit: vi.fn(),
    stderr: { write: vi.fn() },
  };
  for (const key of Object.keys(boundary.process)) Reflect.deleteProperty(boundary.process, key);
  Object.assign(boundary.process, processBoundary, {
    pid: 6000,
    chdir: vi.fn(),
    on: (name: string, listener: (...args: unknown[]) => void) => listeners.set(name, listener),
  });
  task = Object.assign(new EventEmitter(), {
    pid: 7000 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  network = {
    close: vi.fn(async () => {}),
    observation: vi.fn(() => ({ blocked: 0 })),
    parentProxy: "http://127.0.0.1:9999",
  };
  control = { finish: vi.fn(async () => {}) };
  resource = { stop: vi.fn(), current: vi.fn(() => ({ cpuTimeMs: 12, memoryBytes: 1024 })) };
  boundary.spawn.mockReturnValue(task);
  boundary.realpath.mockImplementation(async (value) => value);
  boundary.compile.mockResolvedValue({
    policyDigest: DIGEST,
    policyJson: JSON.stringify({ network: { allowedDomains: [] } }),
  });
  boundary.control.mockResolvedValue(control);
  boundary.namespace.mockResolvedValue({ ref: "namespace-owned" });
  boundary.egress.mockResolvedValue(network);
  boundary.snapshot.mockResolvedValue([]);
  boundary.observe.mockReturnValue(resource);
  boundary.readiness.mockReturnValue({ cancel: vi.fn(), result: Promise.resolve(true) });
  boundary.manager.checkDependenciesAsync.mockResolvedValue({ errors: [], warnings: [] });
  boundary.manager.isSupportedPlatform.mockReturnValue(true);
  boundary.manager.initialize.mockResolvedValue(undefined);
  boundary.manager.wrapWithSandboxArgv.mockResolvedValue({
    argv: ["/bin/bash", "-c", "wrapped"],
    env: { FIXTURE: "1" },
  });
  boundary.manager.reset.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  task.stdin.destroy();
  task.stdout.destroy();
  task.stderr.destroy();
  vi.useRealTimers();
});

describe("Job Host entrypoint protocol and lifecycle", () => {
  it("prepares without starting user code, binds namespace before stdin and returns truthful completion", async () => {
    await prepare({
      ...request(),
      stdinBase64: Buffer.from("private input").toString("base64"),
      resourceLimits: { maxCpuTimeMs: 1000, maxMemoryBytes: 10000 },
    });
    expect(sent[0]).toMatchObject({
      type: "ready",
      sessionId: SESSION,
      jobId: "job-entry",
      sequence: 1,
    });
    expect(boundary.spawn).not.toHaveBeenCalled();
    expect(boundary.manager.initialize.mock.calls[0]?.[0].network.parentProxy).toBe(
      network.parentProxy,
    );
    let input = "";
    task.stdin.on("data", (chunk) => {
      input += chunk.toString();
    });
    await startLinux();
    expect(boundary.namespace).toHaveBeenCalledWith(7000, 1, "pid:[9001]");
    expect(sent.find((item) => item["type"] === "started")).toMatchObject({ pid: 7000 });
    expect(input).toMatch(/^[a-f0-9-]{36}\nprivate input$/);
    task.stdout.write("answer");
    task.stderr.write("warning");
    expect(
      sent
        .filter((item) => item["type"] === "output")
        .map((item) => Buffer.from(String(item["bytes"]), "base64").toString()),
    ).toEqual(["answer", "warning"]);
    await closeTask();
    expect(result()).toMatchObject({
      reason: "exited",
      taskStarted: true,
      taskProcessExited: true,
      stdioClosed: true,
      srtReset: true,
      exitCode: 0,
    });
    expect(boundary.manager.reset).toHaveBeenCalledOnce();
    expect(control.finish).not.toHaveBeenCalled();
    expect(processBoundary.kill).not.toHaveBeenCalled();
    expect(resource.stop).toHaveBeenCalled();
    expect(processBoundary.disconnect).toHaveBeenCalledOnce();
  });
  it("starts a Mac task on spawn with only its supplied input and preserves cleanup failure", async () => {
    Object.assign(boundary.process, { platform: "darwin" });
    await prepare();
    await receive("start");
    task.emit("spawn");
    await settle();
    expect(boundary.namespace).not.toHaveBeenCalled();
    expect(sent.some((item) => item["type"] === "started")).toBe(true);
    boundary.manager.reset.mockRejectedValue(new Error("reset failed"));
    await closeTask(4);
    expect(result()).toMatchObject({ reason: "host_failure", srtReset: false, exitCode: 4 });
    expect((boundary.process as { exitCode: number }).exitCode).toBe(1);
  });
  it.each([
    ["null", null, "JOB_HOST_MESSAGE_INVALID"],
    ["missing type", {}, "JOB_HOST_MESSAGE_INVALID"],
    ["missing session", { type: "prepare" }, "JOB_HOST_SESSION_INVALID"],
    ["protocol", { protocolVersion: "wrong" }, "JOB_HOST_SESSION_INVALID"],
    ["sequence gap", { sequence: 9 }, "JOB_HOST_WORKER_LEASE_INVALID"],
    ["expired", { observedAt: "2026-09-13T00:00:00Z" }, "JOB_HOST_WORKER_LEASE_INVALID"],
    ["future", { observedAt: "2026-09-15T00:00:00Z" }, "JOB_HOST_WORKER_LEASE_INVALID"],
    ["invalid timestamp", { observedAt: "not-a-date" }, "JOB_HOST_WORKER_LEASE_INVALID"],
  ] as const)("rejects %s IPC at the intended validation boundary", async (kind, fields, code) => {
    await load();
    const value = ["null", "missing type", "missing session"].includes(kind)
      ? fields
      : {
          protocolVersion: "job-host.v2",
          sessionId: SESSION,
          sequence: 1,
          observedAt: new Date().toISOString(),
          type: "prepare",
          request: request(),
          ...fields,
        };
    listeners.get("message")?.(value);
    await settle();
    expect(result()).toMatchObject({ reason: "host_failure", taskStarted: false });
    expect(processBoundary.stderr.write).toHaveBeenCalledWith(`${code}\n`);
    expect(boundary.spawn).not.toHaveBeenCalled();
  });
  it.each([
    "environment",
    "policy",
    "unsupported",
    "errors",
    "warnings",
    "control-session",
    "control-overlap",
    "control-parent",
  ])("refuses unsafe preparation: %s", async (kind) => {
    const extra: Record<string, unknown> = {};
    if (kind === "environment") processBoundary.env["TMPDIR"] = "/wrong";
    if (kind === "policy") boundary.compile.mockResolvedValue({ policyDigest: "b".repeat(64) });
    if (kind === "unsupported") boundary.manager.isSupportedPlatform.mockReturnValue(false);
    if (kind === "errors" || kind === "warnings")
      boundary.manager.checkDependenciesAsync.mockResolvedValue({
        errors: [],
        warnings: [],
        [kind]: ["missing dependency"],
      });
    if (kind.startsWith("control"))
      extra["control"] = {
        sessionId: kind === "control-session" ? "other" : SESSION,
        jobId: "job-entry",
        attemptId: "attempt-entry",
        directory: kind === "control-parent" ? "/" : "/workspace/control",
      };
    await prepare(request(), extra);
    expect(result()).toMatchObject({ reason: "host_failure", taskStarted: false });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });
  it("binds control observations and readiness to the owned job, then finishes its control socket", async () => {
    const input = {
      ...request(),
      readiness: {
        kind: "unix_http" as const,
        ref: "ready",
        socketName: "ready.sock",
        path: "/health",
        expectedStatus: 200,
        timeoutMs: 1000,
      },
    };
    input.policy = { ...input.policy, allowedUnixSockets: ["/private-job/ready.sock"] };
    await prepare(input, {
      control: {
        sessionId: SESSION,
        jobId: input.jobId,
        attemptId: input.attemptId,
        directory: "/control",
      },
    });
    expect(boundary.control).toHaveBeenCalledOnce();
    const observe = boundary.control.mock.calls[0]?.[1];
    expect(observe()).toMatchObject({
      phase: "ready",
      taskStarted: false,
      srtReset: false,
      readiness: { ref: "ready", readyAt: null },
    });
    await startLinux();
    expect(observe()).toMatchObject({
      phase: "running",
      taskStarted: true,
      readiness: { readyAt: expect.any(String) },
    });
    const probe = boundary.readiness.mock.calls[0]?.[0];
    expect(probe.active()).toBe(true);
    await probe.wrap("probe");
    await closeTask();
    expect(control.finish).toHaveBeenCalledOnce();
    expect(probe.active()).toBe(false);
    expect(observe()).toMatchObject({ phase: "finished", srtReset: true });
  });
  it.each([
    "output",
    "namespace-invalid",
    "namespace-oversize",
    "namespace-error",
    "spawn-error",
    "stdin-error",
    "readiness-false",
    "readiness-reject",
  ])("stops unsafe running task: %s", async (kind) => {
    let input = request();
    if (kind.startsWith("readiness")) {
      input = {
        ...input,
        policy: { ...input.policy, allowedUnixSockets: ["/private-job/ready.sock"] },
        readiness: {
          kind: "unix_http",
          ref: "ready",
          socketName: "ready.sock",
          path: "/health",
          expectedStatus: 200,
          timeoutMs: 1000,
        },
      };
      boundary.readiness.mockImplementation(() => ({
        cancel: vi.fn(),
        result:
          kind === "readiness-false"
            ? Promise.resolve(false)
            : Promise.reject(new Error("probe failed")),
      }));
    }
    await prepare(input);
    if (kind === "namespace-error")
      boundary.namespace.mockRejectedValue(new Error("namespace unavailable"));
    if (kind === "namespace-invalid" || kind === "namespace-oversize") {
      await receive("start");
      task.stderr.write(kind === "namespace-invalid" ? "wrong\n" : "x".repeat(1025));
    } else await startLinux();
    if (kind === "output") task.stdout.write("x".repeat(20));
    if (kind === "spawn-error") task.emit("error", new Error("spawn unavailable"));
    if (kind === "stdin-error") task.stdin.emit("error", new Error("pipe closed"));
    await settle();
    expect(processBoundary.kill).toHaveBeenCalledWith(-7000, "SIGKILL");
    await closeTask();
    expect(result()).toMatchObject({ reason: kind === "output" ? "output_limit" : "host_failure" });
    if (kind === "output")
      expect(
        Buffer.from(String(sent.find((item) => item["type"] === "output")?.["bytes"]), "base64"),
      ).toHaveLength(16);
  });
  it.each(["deadline", "lease", "disconnect", "SIGTERM", "cancel", "send-error"])(
    "cleans a prepared task without starting it on %s",
    async (kind) => {
      await prepare({
        ...request(),
        deadlineAt: new Date(Date.now() + (kind === "lease" ? 10000 : 1000)).toISOString(),
      });
      if (kind === "deadline" || kind === "lease") {
        if (kind === "lease") await receive("heartbeat");
        await vi.advanceTimersByTimeAsync(kind === "lease" ? 1750 : 1100);
      } else if (kind === "cancel") await receive("cancel", { reason: "untrusted reason" });
      else if (kind === "send-error") {
        processBoundary.send?.mockImplementation((_message, callback) =>
          callback(new Error("IPC unavailable")),
        );
        await vi.advanceTimersByTimeAsync(250);
      } else {
        listeners.get(kind)?.();
        await settle();
      }
      expect(boundary.spawn).not.toHaveBeenCalled();
      expect(boundary.manager.reset).toHaveBeenCalledOnce();
      if (kind !== "send-error")
        expect(result()).toMatchObject({
          reason:
            kind === "lease" ? "host_failure" : kind === "deadline" ? "deadline" : "cancelled",
          taskStarted: false,
        });
    },
  );
  it("does not reset SRT while initialization is still running", async () => {
    let release!: () => void;
    boundary.manager.initialize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await prepare();
    await receive("cancel");
    expect(boundary.manager.reset).not.toHaveBeenCalled();
    release();
    await settle();
    expect(boundary.manager.reset).toHaveBeenCalledOnce();
    expect(sent.some((item) => item["type"] === "ready")).toBe(false);
  });
  it("reports only machine error codes when preparation throws sensitive text", async () => {
    boundary.manager.initialize.mockRejectedValue(
      Object.assign(new Error("private credential material"), { code: "EACCES" }),
    );
    await prepare();
    const stderr = processBoundary.stderr.write.mock.calls.flat().join("");
    expect(stderr).toContain("JOB_HOST_SYSTEM_EACCES");
    expect(stderr).toContain("JOB_HOST_PREPARATION_FAILED");
    expect(stderr).not.toContain("private credential");
  });
  it("rejects execution without its IPC parent", async () => {
    Reflect.deleteProperty(boundary.process, "send");
    await load();
    expect(processBoundary.stderr.write).toHaveBeenCalledWith("JOB_HOST_IPC_REQUIRED\n");
    expect((boundary.process as { exitCode: number }).exitCode).toBe(1);
  });
});
