import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { PI_RESIDENT_FRAME_LIMIT_BYTES } from "@himawari-agent/execution-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JOB_HOST_NAMESPACE_GATE_WINDOW_MS,
  type JobHostRequest,
} from "../src/job-host-protocol.ts";

const boundary = vi.hoisted(() => ({
  process: {},
  spawn: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  control: vi.fn(),
  namespace: vi.fn(),
  namespaceState: vi.fn(),
  egress: vi.fn(),
  readiness: vi.fn(),
  observe: vi.fn(),
  snapshot: vi.fn(),
  startToken: vi.fn(),
  guardian: vi.fn(),
  sdk: vi.fn(),
  manager: {
    compileSandboxPolicy: vi.fn(),
    checkDependenciesAsync: vi.fn(),
    isSupportedPlatform: vi.fn(),
    initialize: vi.fn(),
    wrapWithSandboxArgv: vi.fn(),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn(),
  },
}));
vi.mock("node:process", () => ({ default: boundary.process }));
vi.mock("node:child_process", () => ({
  spawn: boundary.spawn,
  execFile: vi.fn(() => {
    throw new Error("JOB_HOST_TEST_EXECFILE_NOT_STUBBED");
  }),
}));
vi.mock("node:fs/promises", () => ({ realpath: boundary.realpath, stat: boundary.stat }));
vi.mock("../src/sandbox-sdk.ts", () => ({ createSandboxSdk: boundary.sdk }));
vi.mock("../src/job-host-control.ts", () => ({ openJobHostControl: boundary.control }));
vi.mock("../src/linux-namespace.ts", () => ({
  captureLinuxNamespace: boundary.namespace,
  readLinuxNamespaceState: boundary.namespaceState,
}));
vi.mock("../src/network-egress.ts", () => ({ openNetworkEgress: boundary.egress }));
vi.mock("../src/readiness-probe.ts", () => ({ startReadinessProbe: boundary.readiness }));
vi.mock("../src/process-identity.ts", () => ({ readProcessStartToken: boundary.startToken }));
vi.mock("../src/linux-host-guardian.ts", () => ({ startLinuxHostGuardian: boundary.guardian }));
vi.mock("../src/resource-observer.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/resource-observer.ts")>()),
  observeTaskResources: boundary.observe,
  readProcessSnapshot: boundary.snapshot,
}));

const resident = vi.hoisted(() => ({
  table: [] as Array<{ pid: number; parent: number; start: string }>,
  identities: new Map<number, { pid: number; parent: number; start: string }>(),
  identity: vi.fn(),
}));
vi.mock("../src/resident-process-tree.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/resident-process-tree.ts")>();
  return {
    ...actual,
    captureResidentInfrastructure: (root: number) =>
      actual.captureResidentInfrastructure(root, async () => resident.table),
    sweepResidentCommand: (
      root: number,
      infrastructure: ReadonlyMap<number, string>,
      options: Parameters<typeof actual.sweepResidentCommand>[2],
    ) =>
      actual.sweepResidentCommand(root, infrastructure, {
        ...options,
        table: async () => resident.table,
        identity: resident.identity,
      }),
  };
});

const SESSION = "11111111-1111-1111-1111-111111111111";
const POLICY_JSON = JSON.stringify({ network: { allowedDomains: [] } });
const DIGEST = createHash("sha256").update(POLICY_JSON).digest("hex");
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
let control: { finish: ReturnType<typeof vi.fn>; recordStart: ReturnType<typeof vi.fn> };
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
  await vi.dynamicImportSettled();
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
    kill: vi.fn((pid: number, signal: string | number) => {
      if (pid < 0 && signal === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (signal === "SIGKILL")
        resident.table = resident.table.filter((process) => process.pid !== pid);
    }),
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
  control = { finish: vi.fn(async () => {}), recordStart: vi.fn(async () => {}) };
  resource = { stop: vi.fn(), current: vi.fn(() => ({ cpuTimeMs: 12, memoryBytes: 1024 })) };
  boundary.spawn.mockReturnValue(task);
  boundary.realpath.mockImplementation(async (value) => value);
  boundary.stat.mockResolvedValue({ isFile: () => true });
  boundary.manager.compileSandboxPolicy.mockResolvedValue({ policyJson: POLICY_JSON });
  boundary.control.mockResolvedValue(control);
  boundary.namespace.mockResolvedValue({ ref: "namespace-owned" });
  boundary.namespaceState.mockResolvedValue("released");
  boundary.egress.mockResolvedValue(network);
  boundary.snapshot.mockResolvedValue([]);
  boundary.startToken.mockImplementation(async (pid: number) => `start-of-${pid}`);
  boundary.guardian.mockResolvedValue(undefined);
  boundary.observe.mockReturnValue(resource);
  boundary.readiness.mockReturnValue({ cancel: vi.fn(), result: Promise.resolve(true) });
  boundary.manager.checkDependenciesAsync.mockResolvedValue({ errors: [], warnings: [] });
  boundary.manager.isSupportedPlatform.mockReturnValue(true);
  boundary.manager.initialize.mockResolvedValue(undefined);
  boundary.manager.wrapWithSandboxArgv.mockResolvedValue({
    argv: ["/bin/bash", "-c", "bwrap --new-session --die-with-parent -- /bin/bash -c true"],
    env: { FIXTURE: "1" },
  });
  boundary.manager.reset.mockResolvedValue(undefined);
  boundary.sdk.mockResolvedValue(boundary.manager);
  resident.table = [{ pid: 7000, parent: 1, start: "7000" }];
  resident.identities = new Map();
  resident.identity.mockImplementation(async (pid: number) => resident.identities.get(pid) ?? null);
});
afterEach(() => {
  vi.clearAllTimers();
  task.stdin.destroy();
  task.stdout.destroy();
  task.stderr.destroy();
  vi.useRealTimers();
});

describe("Job Host entrypoint protocol and lifecycle", () => {
  it("[R2-L7] prepares without loading the policy module on the Job Host thread", async () => {
    vi.doMock("../src/policy.ts", () => {
      throw Object.assign(new Error("JOB_HOST_TEST_POLICY_IMPORT_FAILURE"), { code: "EIO" });
    });
    try {
      await prepare();
      expect(boundary.manager.compileSandboxPolicy).toHaveBeenCalledWith(request().policy);
      expect(sent.some((message) => message["type"] === "ready")).toBe(true);
      expect(result()).toBeUndefined();
    } finally {
      vi.doUnmock("../src/policy.ts");
    }
  });
  it("[R2-L7] resets the SDK thread when policy compilation fails there", async () => {
    boundary.manager.compileSandboxPolicy.mockRejectedValue(
      Object.assign(new Error("UNKNOWN"), { code: "EIO" }),
    );
    await prepare();
    expect(boundary.manager.initialize).not.toHaveBeenCalled();
    expect(boundary.manager.cleanupAfterCommand).toHaveBeenCalledOnce();
    expect(boundary.manager.reset).toHaveBeenCalledOnce();
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "diagnostic", stage: "policy", systemCode: "EIO" }),
    );
    expect(result()).toMatchObject({ reason: "host_failure", taskStarted: false, srtReset: true });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });
  it("fails without a reset claim if its SDK thread exits while ready", async () => {
    await prepare();
    boundary.manager.reset.mockRejectedValue(new Error("JOB_HOST_PREPARATION_FAILED"));
    const failed = boundary.sdk.mock.calls[0]?.[0] as () => void;
    failed();
    await settle();
    expect(result()).toMatchObject({ reason: "host_failure", taskStarted: false, srtReset: false });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });
  it("waits for its Linux group guardian before SRT can create a bridge", async () => {
    let ready!: () => void;
    boundary.guardian.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    await prepare();
    expect(boundary.guardian).toHaveBeenCalledOnce();
    expect(boundary.manager.initialize).not.toHaveBeenCalled();
    expect(sent.some((message) => message["type"] === "ready")).toBe(false);
    ready();
    await settle();
    expect(boundary.manager.initialize).toHaveBeenCalledOnce();
    expect(sent.some((message) => message["type"] === "ready")).toBe(true);
  });
  it("refuses bridge initialization if the Linux group guardian cannot start", async () => {
    boundary.guardian.mockRejectedValue(new Error("JOB_HOST_GUARDIAN_UNAVAILABLE"));
    await prepare();
    expect(boundary.manager.initialize).not.toHaveBeenCalled();
    expect(result()).toMatchObject({ reason: "host_failure", taskStarted: false });
  });
  it("stops the task if its Linux group guardian exits while the Host is alive", async () => {
    await prepare();
    await startLinux();
    const failed = boundary.guardian.mock.calls[0]?.[1] as () => void;
    expect(failed).toBeTypeOf("function");
    failed();
    await closeTask();
    expect(result()).toMatchObject({ reason: "host_failure" });
    expect(processBoundary.kill).toHaveBeenCalledWith(-7000, "SIGKILL");
  });
  it("reports completed stdout before waiting for reset and keeps final cleanup separate", async () => {
    let release!: () => void;
    boundary.manager.reset.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await prepare();
    await startLinux();
    task.stdout.write("original");
    await closeTask(0);
    expect(sent.find((message) => message["type"] === "completed")).toMatchObject({
      exitCode: 0,
      reason: "exited",
      taskProcessExited: true,
      stdioClosed: true,
    });
    expect(result()).toBeUndefined();
    expect(control.finish).not.toHaveBeenCalled();
    release();
    await settle();
    expect(result()).toMatchObject({ exitCode: 0, reason: "exited", srtReset: true });
  });
  it("reports incomplete stdio when the task exits but its pipes outlive bounded cleanup", async () => {
    await prepare(
      { ...request(), cleanupTimeoutMs: 1000 },
      {
        control: {
          sessionId: SESSION,
          jobId: "job-entry",
          attemptId: "attempt-entry",
          directory: "/control",
        },
      },
    );
    await startLinux();
    task.stdout.write("prefix");
    task.exitCode = 0;
    task.emit("exit", 0, null);
    for (let index = 0; index < 5; index++) {
      await receive("heartbeat");
      await vi.advanceTimersByTimeAsync(200);
    }
    await settle();
    expect(sent.some((message) => message["type"] === "completed")).toBe(false);
    expect(result()).toMatchObject({
      reason: "exited",
      exitCode: 0,
      taskProcessExited: true,
      stdioClosed: false,
      srtReset: true,
      taskProcessGroupGone: true,
    });
    expect(control.finish).toHaveBeenCalledOnce();
    expect(processBoundary.disconnect).toHaveBeenCalledOnce();
  });
  it("routes egress checks through authenticated IPC and closes egress on a denied answer", async () => {
    await prepare();
    await startLinux();
    const check = boundary.egress.mock.calls[0]?.[1] as () => Promise<void>;
    expect(check).toBeTypeOf("function");
    const first = check();
    expect(sent.at(-1)).toMatchObject({ type: "authority_check", checkId: 1, sessionId: SESSION });
    await receive("authority_result", { checkId: 1, allowed: true });
    await first;
    expect(network.close).not.toHaveBeenCalled();
    const denied = expect(check()).rejects.toThrow("AUTHORITY_REJECTED");
    await receive("authority_result", { checkId: 2, allowed: false });
    await denied;
    expect(network.close).toHaveBeenCalled();
    expect(processBoundary.kill).toHaveBeenCalled();
    await closeTask();
    expect(result()).toMatchObject({ reason: "cancelled" });
  });

  it("accepts bounded shell diagnostics before the authenticated namespace frame", async () => {
    await prepare({ ...request(), maxOutputBytes: 1024 });
    await receive("start");
    const command = boundary.manager.wrapWithSandboxArgv.mock.calls[0]?.[0] as string;
    const token = command.match(/printf '([a-f0-9-]+):/)?.[1];
    if (!token) throw new Error("Missing namespace handshake");
    task.stderr.write("/bin/bash: private/.bashrc: Permission denied\n");
    await settle();
    expect(boundary.namespace).not.toHaveBeenCalled();
    expect(sent.some((item) => item["type"] === "started")).toBe(false);
    task.stderr.write(`${token}:1:pid:[9001]\n`);
    await settle();
    expect(boundary.namespace).toHaveBeenCalledWith(7000, 1, "pid:[9001]");
    expect(sent.some((item) => item["type"] === "started")).toBe(true);
    await closeTask();
  });
  it("never treats diagnostic lines as proof or extends the namespace deadline", async () => {
    await prepare({ ...request(), deadlineAt: new Date(Date.now() + 60000).toISOString() });
    await receive("start");
    task.stderr.write("wrong-token:1:pid:[9001]\n");
    const beforeWindowEnd = JOB_HOST_NAMESPACE_GATE_WINDOW_MS - 100;
    for (let elapsed = 0; elapsed < beforeWindowEnd; elapsed += 1000) {
      await vi.advanceTimersByTimeAsync(Math.min(1000, beforeWindowEnd - elapsed));
      await receive("heartbeat");
    }
    expect(processBoundary.kill).not.toHaveBeenCalled();
    expect(boundary.namespace).not.toHaveBeenCalled();
    expect(sent.some((item) => item["type"] === "started")).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(processBoundary.kill).toHaveBeenCalledWith(-7000, "SIGKILL");
    await closeTask();
    expect(result()).toMatchObject({ reason: "host_failure", taskStarted: false });
  });
  it("prepares without starting user code, binds namespace before stdin and returns truthful completion", async () => {
    await prepare({
      ...request(),
      stdinBase64: Buffer.from("private input").toString("base64"),
      resourceLimits: { maxCpuTimeMs: 1000, maxMemoryBytes: 10000 },
    });
    expect(sent[0]).toMatchObject({
      type: "heartbeat",
      sessionId: SESSION,
      sequence: 1,
      steps: [],
    });
    const ready = sent.findIndex((item) => item["type"] === "ready");
    expect(sent[ready]).toMatchObject({
      type: "ready",
      sessionId: SESSION,
      jobId: "job-entry",
      sequence: ready + 1,
    });
    expect(sent.slice(1, ready).every((item) => item["type"] === "heartbeat")).toBe(true);
    const steps = sent[ready - 1]?.["steps"] as Array<{
      stage: string;
      startedMs: number;
      elapsedMs: number | null;
    }>;
    expect(steps.map((step) => step.stage)).toEqual([
      "dependencies",
      "policy",
      "resource_snapshot",
      "dependencies",
      "network",
      "sdk_initialize",
      "launch",
    ]);
    expect(steps.slice(0, -1).every((step) => Number.isSafeInteger(step.elapsedMs))).toBe(true);
    expect(steps.at(-1)?.elapsedMs).toBeNull();
    expect(
      steps.every(
        (step, index) => index === 0 || step.startedMs >= (steps[index - 1]?.startedMs ?? 0),
      ),
    ).toBe(true);
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
      taskProcessGroupGone: true,
      exitCode: 0,
    });
    expect(boundary.manager.reset).toHaveBeenCalledOnce();
    expect(control.finish).not.toHaveBeenCalled();
    expect(processBoundary.kill.mock.calls).toEqual([[-7000, 0]]);
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
    if (kind === "policy")
      boundary.manager.compileSandboxPolicy.mockResolvedValue({
        policyJson: JSON.stringify({ network: { allowedDomains: ["changed.example"] } }),
      });
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
    expect(observe()).toMatchObject({
      phase: "finished",
      srtReset: true,
      taskProcessGroupGone: true,
    });
  });
  it.each(["linux", "darwin"])(
    "records the host and task group start identities once the %s task starts",
    async (platform) => {
      Object.assign(boundary.process, { platform });
      await prepare(request(), {
        control: {
          sessionId: SESSION,
          jobId: "job-entry",
          attemptId: "attempt-entry",
          directory: "/control",
        },
      });
      const observe = boundary.control.mock.calls[0]?.[1];
      expect(observe()).not.toHaveProperty("taskProcessGroup");
      if (platform === "linux") await startLinux();
      else {
        await receive("start");
        task.emit("spawn");
        await settle();
      }
      expect(control.recordStart).toHaveBeenCalledOnce();
      expect(boundary.startToken.mock.calls.map(([pid]) => pid).sort()).toEqual([6000, 7000]);
      expect(observe()).toMatchObject({
        taskStarted: true,
        processStartToken: "start-of-6000",
        taskProcessGroup: { processGroupId: 7000, startToken: "start-of-7000" },
        linuxNamespace: platform === "linux" ? { ref: "namespace-owned" } : null,
      });
    },
  );
  it.each([
    ["leader already gone", async (): Promise<string | null> => null],
    [
      "identity unreadable",
      async (): Promise<string | null> => {
        throw new Error("PROCESS_START_TOKEN_UNAVAILABLE");
      },
    ],
  ] as const)("keeps running without a start record when the %s", async (_kind, token) => {
    boundary.startToken.mockImplementation(async (pid: number) =>
      pid === 7000 ? token() : `start-of-${pid}`,
    );
    await prepare(request(), {
      control: {
        sessionId: SESSION,
        jobId: "job-entry",
        attemptId: "attempt-entry",
        directory: "/control",
      },
    });
    await startLinux();
    const observe = boundary.control.mock.calls[0]?.[1];
    expect(control.recordStart).not.toHaveBeenCalled();
    expect(observe()).toMatchObject({ phase: "running", taskStarted: true });
    expect(observe()).not.toHaveProperty("taskProcessGroup");
    await closeTask();
    expect(result()).toMatchObject({ reason: "exited", taskStarted: true });
  });
  it("keeps running when writing the start record fails", async () => {
    control.recordStart.mockRejectedValue(new Error("disk full"));
    await prepare(request(), {
      control: {
        sessionId: SESSION,
        jobId: "job-entry",
        attemptId: "attempt-entry",
        directory: "/control",
      },
    });
    await startLinux();
    expect(control.recordStart).toHaveBeenCalledOnce();
    await closeTask();
    expect(result()).toMatchObject({ reason: "exited", taskStarted: true });
  });
  it("ends same-group survivors after the task exits and reports the group gone", async () => {
    let probes = 0;
    processBoundary.kill.mockImplementation((pid: number, signal: string | number) => {
      if (pid === -7000 && signal === 0 && ++probes > 1)
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    await prepare();
    await startLinux();
    await closeTask();
    await vi.advanceTimersByTimeAsync(100);
    expect(processBoundary.kill.mock.calls).toEqual([
      [-7000, 0],
      [-7000, "SIGKILL"],
      [-7000, 0],
    ]);
    expect(result()).toMatchObject({ reason: "exited", taskProcessGroupGone: true });
  });
  it.each([
    ["still-present", () => {}],
    [
      "not-permitted",
      () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    ],
  ] as const)("keeps the stop unconfirmed when the task group is %s", async (_kind, signal) => {
    processBoundary.kill.mockImplementation(signal);
    await prepare();
    await startLinux();
    await closeTask();
    await vi.advanceTimersByTimeAsync(2000);
    expect(result()).toMatchObject({ reason: "exited", taskProcessGroupGone: false });
  });
  it("never probes a task group that did not start", async () => {
    await prepare();
    listeners.get("disconnect")?.();
    await vi.advanceTimersByTimeAsync(200);
    expect(result()).toMatchObject({ taskStarted: false, taskProcessGroupGone: false });
    expect(processBoundary.kill).not.toHaveBeenCalled();
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
      const command = boundary.manager.wrapWithSandboxArgv.mock.calls[0]?.[0] as string;
      const token = command.match(/printf '([a-f0-9-]+):/)?.[1];
      if (!token) throw new Error("Missing namespace handshake");
      task.stderr.write(kind === "namespace-invalid" ? `${token}:invalid\n` : "x".repeat(1025));
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
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "diagnostic",
        stage: "sdk_initialize",
        systemCode: "EACCES",
      }),
    );
    expect(stderr).toBe("");
    expect(stderr).not.toContain("private credential");
  });
  it("acknowledges liveness before preparation can occupy the event loop", async () => {
    let messagesAtInitialization: Record<string, unknown>[] = [];
    boundary.manager.initialize.mockImplementation(async () => {
      messagesAtInitialization = [...sent];
    });
    await prepare();
    expect(messagesAtInitialization).toContainEqual(
      expect.objectContaining({ type: "heartbeat", sessionId: SESSION }),
    );
    expect(boundary.spawn).not.toHaveBeenCalled();
  });
  it("[R2-D23] accepts a first prepare that waited for a slow Job Host start", async () => {
    await prepare(request(), { observedAt: new Date(Date.now() - 2000).toISOString() });
    expect(sent).toContainEqual(expect.objectContaining({ type: "ready", sessionId: SESSION }));
    expect(sent.some((message) => message["type"] === "diagnostic")).toBe(false);
    expect(processBoundary.stderr.write).not.toHaveBeenCalled();
  });
  it("[R2-D23] rejects a first prepare older than the startup window", async () => {
    await prepare(request(), { observedAt: new Date(Date.now() - 10_001).toISOString() });
    expect(result()).toMatchObject({ reason: "host_failure", taskStarted: false });
    expect(processBoundary.stderr.write).toHaveBeenCalledWith("JOB_HOST_WORKER_LEASE_INVALID\n");
    expect(sent.some((message) => message["type"] === "ready")).toBe(false);
  });
  it("identifies a stale Worker message after ready without exposing its payload", async () => {
    await prepare();
    await receive("heartbeat", { observedAt: new Date(Date.now() - 1501).toISOString() });
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "diagnostic",
        detail: expect.objectContaining({
          code: "JOB_HOST_WORKER_LEASE_INVALID",
          command: "heartbeat",
          phase: "ready",
          messageAgeMs: 1501,
          deadlineRemainingMs: 10000,
          expectedSequence: 2,
          receivedSequence: 2,
        }),
      }),
    );
    expect(boundary.spawn).not.toHaveBeenCalled();
    expect(processBoundary.stderr.write).not.toHaveBeenCalled();
  });
  it("keeps SDK errors opaque while retaining bounded diagnostic timing", async () => {
    boundary.manager.initialize.mockRejectedValue(
      Object.assign(new Error("JOB_HOST_private_input"), {
        code: "EIO",
        syscall: "/private/input",
      }),
    );
    await prepare();
    const diagnostic = sent.find((item) => item["type"] === "diagnostic");
    expect(diagnostic).toMatchObject({
      detail: {
        code: "UNKNOWN",
        command: "prepare",
        phase: "preparing",
        elapsedMs: expect.any(Number),
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private_input");
    expect(JSON.stringify(diagnostic)).not.toContain("/private/input");
  });
  it("rejects execution without its IPC parent", async () => {
    Reflect.deleteProperty(boundary.process, "send");
    await load();
    expect(processBoundary.stderr.write).toHaveBeenCalledWith("JOB_HOST_IPC_REQUIRED\n");
    expect((boundary.process as { exitCode: number }).exitCode).toBe(1);
  });
  it("forces exit within the cleanup deadline after disconnect while readiness never settles", async () => {
    const cancelReadiness = vi.fn();
    let finishReadiness!: (ready: boolean) => void;
    boundary.readiness.mockReturnValue({
      cancel: cancelReadiness,
      result: new Promise<boolean>((resolve) => {
        finishReadiness = resolve;
      }),
    });
    const input = {
      ...request(),
      policy: { ...request().policy, allowedUnixSockets: ["/private-job/ready.sock"] },
      readiness: {
        kind: "unix_http" as const,
        ref: "ready",
        socketName: "ready.sock",
        path: "/health",
        expectedStatus: 200,
        timeoutMs: 1000,
      },
    };
    await prepare(input);
    await startLinux();
    processBoundary.connected = false;
    Object.assign(boundary.process, { connected: false });
    listeners.get("disconnect")?.();
    try {
      await closeTask();
      expect(cancelReadiness).toHaveBeenCalledOnce();
      expect(processBoundary.kill).toHaveBeenCalledWith(-7000, "SIGKILL");
      expect(result()).toBeUndefined();
      expect(boundary.manager.reset).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(input.cleanupTimeoutMs - 1);
      expect(processBoundary.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(processBoundary.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(result()).toBeUndefined();
      expect(boundary.manager.reset).not.toHaveBeenCalled();
    } finally {
      finishReadiness(false);
      await settle();
    }
  });
  it.each(["reset", "control-finish"] as const)(
    "keeps the Worker informed during slow cleanup: %s",
    async (stage) => {
      let resume = () => {};
      const pending = new Promise<void>((resolve) => {
        resume = resolve;
      });
      if (stage === "reset") boundary.manager.reset.mockReturnValue(pending);
      else control.finish.mockReturnValue(pending);
      await prepare(
        { ...request(), cleanupTimeoutMs: 5000 },
        {
          control: {
            sessionId: SESSION,
            jobId: "job-entry",
            attemptId: "attempt-entry",
            directory: "/control",
          },
        },
      );
      await startLinux();
      await closeTask();
      const before = sent.filter((item) => item["type"] === "heartbeat").length;
      try {
        for (let i = 0; i < 8; i++) {
          await receive("heartbeat");
          await vi.advanceTimersByTimeAsync(250);
        }
        expect(result()).toBeUndefined();
        expect(processBoundary.exit).not.toHaveBeenCalled();
        expect(sent.filter((item) => item["type"] === "heartbeat").length - before).toBe(8);
      } finally {
        resume();
        await settle();
      }
      expect(result()).toMatchObject({
        reason: "exited",
        srtReset: true,
        taskProcessExited: true,
        taskProcessGroupGone: true,
      });
      expect(processBoundary.disconnect).toHaveBeenCalledOnce();
      const finishedMessages = sent.length;
      await vi.advanceTimersByTimeAsync(250);
      expect(sent).toHaveLength(finishedMessages);
    },
  );

  it.each(["reset", "control-finish"] as const)(
    "keeps the cleanup exit deadline despite continuing heartbeats: %s",
    async (stage) => {
      let resume = () => {};
      const pending = new Promise<void>((resolve) => {
        resume = resolve;
      });
      if (stage === "reset") boundary.manager.reset.mockReturnValue(pending);
      else control.finish.mockReturnValue(pending);
      await prepare(
        { ...request(), cleanupTimeoutMs: 5000 },
        {
          control: {
            sessionId: SESSION,
            jobId: "job-entry",
            attemptId: "attempt-entry",
            directory: "/control",
          },
        },
      );
      await startLinux();
      await closeTask();
      try {
        for (let i = 0; i < 20; i++) {
          await receive("heartbeat");
          await vi.advanceTimersByTimeAsync(250);
        }
        expect(result()).toBeUndefined();
        expect(processBoundary.exit).toHaveBeenCalledExactlyOnceWith(1);
      } finally {
        resume();
        await settle();
      }
    },
  );

  const readOnlyTmpfsCommand =
    "bwrap --dev /dev --proc /proc --tmpfs /tmp --tmpfs /var -- /bin/bash -c true";
  const readOnlyTmpfsRewritten =
    "bwrap --dev /dev --proc /proc --tmpfs /tmp --tmpfs /var --remount-ro /tmp --remount-ro /var -- /bin/bash -c true";

  it("[R2-T5] rewrites a Linux launch so each tmpfs is remounted read-only before the separator", async () => {
    boundary.manager.wrapWithSandboxArgv.mockResolvedValue({
      argv: ["/bin/bash", "-c", readOnlyTmpfsCommand],
      env: { FIXTURE: "1" },
    });
    await prepare();
    await startLinux();
    expect(boundary.spawn).toHaveBeenCalledWith(
      "/bin/bash",
      ["-c", readOnlyTmpfsRewritten],
      expect.objectContaining({ shell: false, detached: true }),
    );
  });

  it("[R2-D31] reports the observer failure code before stopping a running task", async () => {
    await prepare({ ...request(), resourceLimits: { maxCpuTimeMs: 1000, maxMemoryBytes: 10000 } });
    await startLinux();
    const observe = boundary.observe.mock.calls[0];
    expect(observe?.[0]).toBe(7000);
    (observe?.[2] as (reason: string, failure?: string, detail?: string) => void)(
      "host_failure",
      "RESOURCE_OBSERVATION_UNAVAILABLE",
      "signal=SIGTERM killed=true",
    );
    await settle();
    expect(processBoundary.kill).toHaveBeenCalledWith(-7000, "SIGKILL");
    const diagnosticIndex = sent.findIndex((item) => item["type"] === "diagnostic");
    expect(sent[diagnosticIndex]).toMatchObject({
      type: "diagnostic",
      stage: "launch",
      systemCode: "UNKNOWN",
      detail: {
        code: "JOB_HOST_RESOURCE_OBSERVATION_FAILED",
        command: "start",
        phase: "running",
        text: "RESOURCE_OBSERVATION_UNAVAILABLE signal=SIGTERM killed=true",
      },
    });
    const killIndex = processBoundary.kill.mock.calls.findIndex(
      ([pid, signal]) => pid === -7000 && signal === "SIGKILL",
    );
    const sendOrder = processBoundary.send?.mock.invocationCallOrder[diagnosticIndex] ?? Infinity;
    const killOrder = processBoundary.kill.mock.invocationCallOrder[killIndex] ?? 0;
    expect(sendOrder).toBeLessThan(killOrder);
    expect(resource.stop).toHaveBeenCalled();
    await closeTask();
    expect(result()).toMatchObject({ reason: "host_failure", taskStarted: true });
  });

  it("[R2-D31] sends no observer diagnostic once the task is already being cancelled", async () => {
    await prepare({ ...request(), resourceLimits: { maxCpuTimeMs: 1000, maxMemoryBytes: 10000 } });
    await startLinux();
    const observe = boundary.observe.mock.calls[0];
    await receive("cancel");
    expect(resource.stop).toHaveBeenCalled();
    (observe?.[2] as (reason: string, failure?: string, detail?: string) => void)(
      "host_failure",
      "RESOURCE_OBSERVATION_UNAVAILABLE",
      "signal=SIGTERM killed=true",
    );
    await settle();
    expect(sent.some((item) => item["type"] === "diagnostic")).toBe(false);
    await closeTask();
    expect(result()).toMatchObject({ reason: "cancelled", taskStarted: true });
  });

  it("[R2-T5] does not spawn when the Linux launch argv is not the expected bwrap command", async () => {
    boundary.manager.wrapWithSandboxArgv.mockResolvedValue({
      argv: ["/bin/bash", "-c", "echo hello"],
      env: { FIXTURE: "1" },
    });
    await prepare();
    await receive("start");
    expect(boundary.spawn).not.toHaveBeenCalled();
    expect(sent.find((item) => item["type"] === "diagnostic")).toMatchObject({
      detail: { code: "JOB_HOST_LAUNCH_ARGV_UNEXPECTED" },
    });
    expect(result()).toMatchObject({ reason: "host_failure", taskStarted: false });
  });

  it("[R2-T5] returns rewritten argv from the Linux readiness wrap callback", async () => {
    boundary.manager.wrapWithSandboxArgv.mockResolvedValue({
      argv: ["/bin/bash", "-c", readOnlyTmpfsCommand],
      env: { FIXTURE: "1" },
    });
    const input = request();
    await prepare(
      {
        ...input,
        policy: { ...input.policy, allowedUnixSockets: ["/private-job/ready.sock"] },
        readiness: {
          kind: "unix_http" as const,
          ref: "ready",
          socketName: "ready.sock",
          path: "/health",
          expectedStatus: 200,
          timeoutMs: 1000,
        },
      },
      {
        control: {
          sessionId: SESSION,
          jobId: input.jobId,
          attemptId: input.attemptId,
          directory: "/control",
        },
      },
    );
    await startLinux();
    const probe = boundary.readiness.mock.calls[0]?.[0];
    await expect(probe.wrap("probe")).resolves.toMatchObject({
      argv: ["/bin/bash", "-c", readOnlyTmpfsRewritten],
    });
  });

  it("[R2-T5] leaves a Darwin launch argv unchanged", async () => {
    Object.assign(boundary.process, { platform: "darwin" });
    const argv = ["/bin/bash", "-c", readOnlyTmpfsCommand];
    boundary.manager.wrapWithSandboxArgv.mockResolvedValue({
      argv,
      env: { FIXTURE: "1" },
    });
    await prepare();
    await receive("start");
    task.emit("spawn");
    await settle();
    expect(boundary.spawn).toHaveBeenCalledWith(
      "/bin/bash",
      ["-c", readOnlyTmpfsCommand],
      expect.objectContaining({ shell: false, detached: true }),
    );
  });
});

describe("[R2-P2] Job Host session mode", () => {
  const runInput = (
    attemptId: string,
    sequence: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    attemptId,
    sequence,
    policyDigest: DIGEST,
    deadlineAt: new Date(Date.now() + 5000).toISOString(),
    maxOutputBytes: 512,
    inputBase64: Buffer.from("input").toString("base64"),
    resourceLimits: { maxCpuTimeMs: 1000, maxMemoryBytes: 10000 },
    ...overrides,
  });
  const sessionRequest = (overrides: Partial<JobHostRequest> = {}): JobHostRequest => ({
    ...request(),
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    maxOutputBytes: 4096,
    ...overrides,
  });
  const commandResults = () => sent.filter((item) => item["type"] === "command_result");
  const lastCommand = () => commandResults().at(-1);
  const readyMessage = () => sent.find((item) => item["type"] === "ready");
  const outputMessages = () => sent.filter((item) => item["type"] === "output");
  let stdinLines: string[];
  let stdinPending: string;
  const runFrames = () =>
    stdinLines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  async function flush() {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(50);
  }
  async function drain() {
    for (let step = 0; step < 4; step++) await flush();
  }
  function captureStdin() {
    stdinLines = [];
    stdinPending = "";
    task.stdin.on("data", (chunk: Buffer) => {
      stdinPending += chunk.toString("utf8");
      for (let index = stdinPending.indexOf("\n"); index >= 0; index = stdinPending.indexOf("\n")) {
        stdinLines.push(stdinPending.slice(0, index));
        stdinPending = stdinPending.slice(index + 1);
      }
    });
  }
  async function openSession(input = sessionRequest()) {
    captureStdin();
    await load();
    await receive("prepare", { request: input, session: true });
    await flush();
    const command = boundary.manager.wrapWithSandboxArgv.mock.calls.at(-1)?.[0] as
      | string
      | undefined;
    const token = command?.match(/printf '([a-f0-9-]+):/)?.[1];
    if (!token) throw new Error("Missing namespace handshake in the resident launch");
    task.stderr.write(Buffer.from(`${token}:1:pid:[9001]\n`));
    await flush();
  }
  async function runnerFrame(frame: unknown) {
    task.stdout.write(Buffer.from(`${JSON.stringify(frame)}\n`));
    await flush();
  }
  async function readyRunner() {
    await runnerFrame({ type: "ready" });
  }
  async function command(
    attemptId: string,
    sequence: number,
    overrides: Record<string, unknown> = {},
  ) {
    await receive("run", { run: runInput(attemptId, sequence, overrides) });
    await flush();
  }
  async function outputFrame(sequence: number, channel: string, bytes: Buffer) {
    await runnerFrame({ type: "output", seq: sequence, channel, bytes: bytes.toString("base64") });
  }
  async function resultFrame(sequence: number, exitCode = 0) {
    await runnerFrame({ type: "result", seq: sequence, exitCode });
  }
  async function advance(ms: number, step = 250) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      await receive("heartbeat");
      await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed));
    }
  }

  it("[R2-P2] reuses one prepared host and one resident runner across three commands", async () => {
    await openSession();
    await readyRunner();
    expect(boundary.sdk).toHaveBeenCalledOnce();
    expect(boundary.manager.initialize).toHaveBeenCalledOnce();
    expect(boundary.guardian).toHaveBeenCalledOnce();
    expect(boundary.egress).toHaveBeenCalledOnce();
    expect(boundary.control).not.toHaveBeenCalled();
    for (const [index, attemptId] of ["attempt-a", "attempt-b", "attempt-c"].entries()) {
      await command(attemptId, index + 1);
      await outputFrame(index + 1, "stdout", Buffer.from("chunk"));
      await resultFrame(index + 1, 0);
      expect(lastCommand()).toMatchObject({
        attemptId,
        runSequence: index + 1,
        exitCode: 0,
        reason: "exited",
      });
    }
    expect(boundary.manager.wrapWithSandboxArgv).toHaveBeenCalledOnce();
    expect(boundary.spawn).toHaveBeenCalledOnce();
    expect(boundary.manager.cleanupAfterCommand).not.toHaveBeenCalled();
    expect(boundary.manager.reset).not.toHaveBeenCalled();
    expect(runFrames().map((frame) => frame["seq"])).toEqual([1, 2, 3]);
    expect(runFrames().map((frame) => frame["inputBase64"])).toEqual([
      Buffer.from("input").toString("base64"),
      Buffer.from("input").toString("base64"),
      Buffer.from("input").toString("base64"),
    ]);
    expect(result()).toBeUndefined();
  });

  it("[R2-P2] announces ready only after the runner reports itself ready", async () => {
    await openSession();
    expect(readyMessage()).toBeUndefined();
    await readyRunner();
    expect(readyMessage()).toMatchObject({
      jobId: "job-entry",
      attemptId: "attempt-entry",
      residentProcessId: 7000,
    });
  });

  it("[R2-P2] fails preparation when the runner exits before announcing ready", async () => {
    await openSession();
    task.emit("exit", 1, null);
    task.emit("close", 1, null);
    await drain();
    expect(readyMessage()).toBeUndefined();
    expect(result()).toMatchObject({ reason: "host_failure" });
  });

  it("[R2-P2] labels every command with the resident process and forwards its output", async () => {
    await openSession();
    await readyRunner();
    await command("attempt-a", 1);
    expect(sent.find((item) => item["type"] === "started")).toMatchObject({
      attemptId: "attempt-a",
      pid: 7000,
    });
    await outputFrame(1, "stdout", Buffer.from("answer"));
    expect(outputMessages().at(-1)).toMatchObject({ attemptId: "attempt-a", channel: "stdout" });
    expect(Buffer.from(String(outputMessages().at(-1)?.["bytes"]), "base64").toString()).toBe(
      "answer",
    );
    await resultFrame(1, 0);
    expect(lastCommand()).toMatchObject({
      attemptId: "attempt-a",
      reason: "exited",
      exitCode: 0,
      namespace: "resident_intact",
      processGroupGone: true,
      cleanedUp: true,
    });
    expect(sent.some((item) => item["type"] === "completed")).toBe(false);
  });

  it("[R2-P2] fails the session when the runner exits between two commands", async () => {
    await openSession();
    await readyRunner();
    await command("attempt-a", 1);
    await resultFrame(1, 0);
    expect(lastCommand()).toMatchObject({ attemptId: "attempt-a", exitCode: 0 });
    task.emit("exit", 0, null);
    task.emit("close", 0, null);
    await drain();
    expect(result()).toMatchObject({ reason: "host_failure" });
    const before = runFrames().length;
    await command("attempt-b", 2);
    expect(runFrames()).toHaveLength(before);
    expect(
      sent.some((item) => item["type"] === "started" && item["attemptId"] === "attempt-b"),
    ).toBe(false);
  });

  it("[R2-P2] fails the session and leaves the command unsettled when the runner exits mid-command", async () => {
    await openSession();
    await readyRunner();
    await command("attempt-a", 1);
    task.emit("exit", 1, null);
    task.emit("close", 1, null);
    await drain();
    expect(lastCommand()).toMatchObject({
      attemptId: "attempt-a",
      reason: "host_failure",
      taskProcessExited: false,
      stdioClosed: false,
      namespace: "unknown",
    });
    expect(result()).toMatchObject({ reason: "host_failure" });
  });

  it.each([
    ["a non-JSON line", () => "not json\n"],
    [
      "an output frame with an extra key",
      () =>
        `${JSON.stringify({
          type: "output",
          seq: 1,
          channel: "stdout",
          bytes: "",
          extra: true,
        })}\n`,
    ],
    [
      "an output frame with a missing key",
      () => `${JSON.stringify({ type: "output", seq: 1, channel: "stdout" })}\n`,
    ],
    [
      "an output frame with the wrong sequence",
      () => `${JSON.stringify({ type: "output", seq: 2, channel: "stdout", bytes: "" })}\n`,
    ],
    [
      "an output frame with an unknown channel",
      () => `${JSON.stringify({ type: "output", seq: 1, channel: "other", bytes: "" })}\n`,
    ],
    [
      "an output frame with malformed base64",
      () => `${JSON.stringify({ type: "output", seq: 1, channel: "stdout", bytes: "!!" })}\n`,
    ],
    ["a frame line over the limit", () => `${"x".repeat(PI_RESIDENT_FRAME_LIMIT_BYTES + 1)}\n`],
    [
      "a result with an out-of-range exit code",
      () => `${JSON.stringify({ type: "result", seq: 1, exitCode: 300 })}\n`,
    ],
  ])("[R2-P2] fails the session on %s", async (_kind, line) => {
    await openSession();
    await readyRunner();
    await command("attempt-a", 1);
    task.stdout.write(Buffer.from((line as () => string)()));
    await drain();
    expect(result()).toMatchObject({ reason: "host_failure" });
  });

  it("[R2-P2] fails the session on an output frame while no command runs", async () => {
    await openSession();
    await readyRunner();
    task.stdout.write(
      Buffer.from(`${JSON.stringify({ type: "output", seq: 1, channel: "stdout", bytes: "" })}\n`),
    );
    await drain();
    expect(result()).toMatchObject({ reason: "host_failure" });
  });

  it("[R2-P2] fails the session on a second ready frame", async () => {
    await openSession();
    await readyRunner();
    await readyRunner();
    await drain();
    expect(result()).toMatchObject({ reason: "host_failure" });
  });

  it("[R2-P2] ends only the command that exceeds its own output limit", async () => {
    await openSession();
    await readyRunner();
    await command("attempt-a", 1, { maxOutputBytes: 4 });
    await outputFrame(1, "stdout", Buffer.from("0123456789"));
    expect(Buffer.from(String(outputMessages().at(-1)?.["bytes"]), "base64").toString()).toBe(
      "0123",
    );
    await resultFrame(1, 0);
    expect(lastCommand()).toMatchObject({
      attemptId: "attempt-a",
      reason: "output_limit",
      exitCode: null,
    });
    expect(result()).toBeUndefined();
    await command("attempt-b", 2);
    await resultFrame(2, 0);
    expect(lastCommand()).toMatchObject({ attemptId: "attempt-b", exitCode: 0, reason: "exited" });
  });

  it("[R2-P2] stops the session after a command misses its own deadline", async () => {
    await openSession();
    await readyRunner();
    await command("attempt-a", 1, { deadlineAt: new Date(Date.now() + 1000).toISOString() });
    await advance(1400);
    await drain();
    expect(lastCommand()).toMatchObject({ attemptId: "attempt-a", reason: "deadline" });
    expect(result()).toMatchObject({ reason: "host_failure" });
  });

  it("[R2-P2] ends only the command that reaches its own deadline and keeps the session", async () => {
    await openSession();
    await readyRunner();
    const leftover = { pid: 8000, parent: 7000, start: "8000" };
    resident.table = [{ pid: 7000, parent: 1, start: "7000" }, leftover];
    resident.identities.set(leftover.pid, leftover);
    await command("attempt-a", 1, { deadlineAt: new Date(Date.now() + 300).toISOString() });
    for (
      let elapsed = 0;
      elapsed < 5000 && resident.identity.mock.calls.length === 0;
      elapsed += 10
    ) {
      await receive("heartbeat");
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(resident.identity).toHaveBeenCalledWith(leftover.pid);
    expect(processBoundary.kill).toHaveBeenCalledWith(leftover.pid, "SIGKILL");
    expect(processBoundary.kill).not.toHaveBeenCalledWith(7000, "SIGKILL");
    await resultFrame(1, 137);
    expect(lastCommand()).toMatchObject({
      attemptId: "attempt-a",
      reason: "deadline",
      exitCode: null,
      namespace: "resident_intact",
      processGroupGone: true,
      cleanedUp: true,
    });
    expect(result()).toBeUndefined();
    expect(boundary.manager.reset).not.toHaveBeenCalled();
    await command("attempt-b", 2);
    await resultFrame(2, 0);
    expect(lastCommand()).toMatchObject({ attemptId: "attempt-b", exitCode: 0, reason: "exited" });
    expect(boundary.manager.wrapWithSandboxArgv).toHaveBeenCalledOnce();
    expect(boundary.spawn).toHaveBeenCalledOnce();
  });

  it("[R2-P2] fails the session when a captured base process is missing", async () => {
    await openSession();
    await readyRunner();
    resident.table = [];
    await command("attempt-a", 1);
    await resultFrame(1, 0);
    await drain();
    expect(lastCommand()).toMatchObject({ attemptId: "attempt-a", namespace: "unknown" });
    expect(result()).toMatchObject({ reason: "host_failure" });
  });

  it("[R2-P2] kills only the command's leftover after re-reading its identity", async () => {
    await openSession();
    await readyRunner();
    const leftover = { pid: 8000, parent: 7000, start: "8000" };
    resident.table = [{ pid: 7000, parent: 1, start: "7000" }, leftover];
    resident.identities.set(leftover.pid, leftover);
    await command("attempt-a", 1);
    await resultFrame(1, 0);
    expect(resident.identity).toHaveBeenCalledWith(leftover.pid);
    expect(processBoundary.kill).toHaveBeenCalledWith(leftover.pid, "SIGKILL");
    expect(processBoundary.kill).not.toHaveBeenCalledWith(7000, "SIGKILL");
    expect(lastCommand()).toMatchObject({
      attemptId: "attempt-a",
      namespace: "resident_intact",
      processGroupGone: true,
      cleanedUp: true,
    });
  });

  it("[R2-P2] fails the session when a second command arrives while one runs", async () => {
    await openSession();
    await readyRunner();
    await command("attempt-a", 1);
    expect(
      sent.some((item) => item["type"] === "started" && item["attemptId"] === "attempt-a"),
    ).toBe(true);
    const before = runFrames().length;
    await command("attempt-b", 2);
    await drain();
    expect(runFrames()).toHaveLength(before);
    expect(result()).toMatchObject({ reason: "host_failure" });
    expect(boundary.manager.wrapWithSandboxArgv).toHaveBeenCalledOnce();
  });

  it.each(["before ready", "without a session"])(
    "[R2-P2] fails the host when a command arrives %s",
    async (kind) => {
      if (kind === "before ready") {
        let release!: () => void;
        boundary.manager.initialize.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
        await load();
        await receive("prepare", { request: sessionRequest(), session: true });
        await flush();
        await receive("run", { run: runInput("attempt-a", 1) });
        release();
        await drain();
      } else {
        await prepare();
        await receive("run", { run: runInput("attempt-a", 1) });
      }
      expect(result()).toMatchObject({ reason: "host_failure", taskStarted: false });
      expect(boundary.spawn).not.toHaveBeenCalled();
      expect(sent.find((item) => item["type"] === "diagnostic")).toMatchObject({
        detail: { code: "JOB_HOST_RUN_NOT_ALLOWED" },
      });
    },
  );

  it("[R2-P2] refuses a session that arrives with a control binding", async () => {
    await load();
    await receive("prepare", {
      request: sessionRequest(),
      session: true,
      control: {
        sessionId: SESSION,
        jobId: "job-entry",
        attemptId: "attempt-entry",
        directory: "/control",
      },
    });
    expect(boundary.manager.initialize).not.toHaveBeenCalled();
    expect(boundary.control).not.toHaveBeenCalled();
    expect(result()).toMatchObject({ reason: "host_failure", taskStarted: false });
  });

  it("[R2-P2] refuses a session whose request carries per-command fields", async () => {
    await load();
    await receive("prepare", {
      request: { ...sessionRequest(), stdinBase64: Buffer.from("input").toString("base64") },
      session: true,
    });
    expect(boundary.manager.initialize).not.toHaveBeenCalled();
    expect(boundary.spawn).not.toHaveBeenCalled();
    expect(result()).toMatchObject({ reason: "host_failure", taskStarted: false });
  });

  it("[R2-P2] cancels the running command and ignores a repeat for the reported one", async () => {
    await openSession();
    await readyRunner();
    await command("attempt-a", 1);
    await receive("run_cancel", { attemptId: "attempt-a", reason: "cancelled" });
    await flush();
    await resultFrame(1, 0);
    expect(lastCommand()).toMatchObject({
      attemptId: "attempt-a",
      reason: "cancelled",
      exitCode: null,
    });
    await receive("run_cancel", { attemptId: "attempt-a", reason: "cancelled" });
    expect(result()).toBeUndefined();
    await command("attempt-b", 2);
    await resultFrame(2, 0);
    expect(lastCommand()).toMatchObject({ attemptId: "attempt-b", exitCode: 0 });
  });

  it("[R2-P2] fails the session when a run_cancel names another command", async () => {
    await openSession();
    await readyRunner();
    await command("attempt-a", 1);
    await resultFrame(1, 0);
    expect(lastCommand()).toMatchObject({ attemptId: "attempt-a", exitCode: 0 });
    await receive("run_cancel", { attemptId: "attempt-9", reason: "cancelled" });
    await drain();
    expect(result()).toMatchObject({ reason: "host_failure" });
  });

  async function finishSession() {
    await vi.advanceTimersByTimeAsync(2100);
    await drain();
  }
  const residentKilled = () =>
    processBoundary.kill.mock.calls.some(([pid, signal]) => pid === -7000 && signal === "SIGKILL");
  const settledFields = {
    exitCode: null,
    taskProcessExited: true,
    stdioClosed: true,
    processGroupGone: true,
    namespace: "resident_intact",
    cleanedUp: true,
  };

  it("[R2-D31] reports the observer failure of a resident command and stops the host", async () => {
    await openSession();
    await readyRunner();
    await command("attempt-a", 1);
    const observe = boundary.observe.mock.calls.at(-1);
    (observe?.[2] as (reason: string, failure?: string, detail?: string) => void)(
      "host_failure",
      "RESOURCE_OBSERVATION_UNAVAILABLE",
      "code=EAGAIN",
    );
    await finishSession();
    expect(sent.find((item) => item["type"] === "diagnostic")).toMatchObject({
      type: "diagnostic",
      stage: "launch",
      systemCode: "UNKNOWN",
      detail: {
        code: "JOB_HOST_RESOURCE_OBSERVATION_FAILED",
        command: "run",
        text: "RESOURCE_OBSERVATION_UNAVAILABLE code=EAGAIN",
      },
    });
    expect(result()).toMatchObject({ type: "result", reason: "host_failure" });
  });

  it("[R2-D31] reports a failed baseline snapshot before a resident command starts", async () => {
    await openSession();
    await readyRunner();
    boundary.snapshot.mockRejectedValueOnce(
      new Error("RESOURCE_OBSERVATION_UNAVAILABLE", { cause: { killed: true, signal: "SIGTERM" } }),
    );
    await command("attempt-a", 1);
    await finishSession();
    expect(sent.some((item) => item["type"] === "started")).toBe(false);
    expect(sent.find((item) => item["type"] === "diagnostic")).toMatchObject({
      type: "diagnostic",
      stage: "launch",
      systemCode: "UNKNOWN",
      detail: {
        code: "JOB_HOST_RESOURCE_OBSERVATION_FAILED",
        command: "run",
        text: "RESOURCE_OBSERVATION_UNAVAILABLE signal=SIGTERM killed=true",
      },
    });
    expect(result()).toMatchObject({ type: "result", reason: "host_failure" });
  });

  it("[R2-D31] sends no observer diagnostic once the session is being cancelled", async () => {
    await openSession(sessionRequest({ cleanupTimeoutMs: 1000 }));
    await readyRunner();
    await command("attempt-a", 1);
    const observe = boundary.observe.mock.calls.at(-1);
    await receive("cancel");
    expect(resource.stop).toHaveBeenCalled();
    (observe?.[2] as (reason: string, failure?: string, detail?: string) => void)(
      "host_failure",
      "RESOURCE_OBSERVATION_UNAVAILABLE",
      "code=EAGAIN",
    );
    await flush();
    expect(sent.some((item) => item["type"] === "diagnostic")).toBe(false);
    await resultFrame(1, 137);
    await finishSession();
    expect(result()).toMatchObject({ type: "result", reason: "cancelled" });
  });

  it("[R2-D31] sends no baseline diagnostic for a command cancelled while ps was running", async () => {
    await openSession();
    await readyRunner();
    let reject!: (error: Error) => void;
    boundary.snapshot.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await command("attempt-a", 1);
    await receive("run_cancel", { attemptId: "attempt-a", reason: "cancelled" });
    reject(new Error("RESOURCE_OBSERVATION_UNAVAILABLE"));
    await drain();
    expect(sent.some((item) => item["type"] === "diagnostic")).toBe(false);
    expect(lastCommand()).toMatchObject({
      attemptId: "attempt-a",
      reason: "cancelled",
      taskStarted: false,
      exitCode: null,
    });
    expect(boundary.spawn).toHaveBeenCalledOnce();
    expect(runFrames()).toEqual([]);
  });

  it("[R2-P2] settles the running command before a session cancel result", async () => {
    await openSession(sessionRequest({ cleanupTimeoutMs: 1000 }));
    await readyRunner();
    await command("attempt-a", 1);
    await receive("cancel");
    await flush();
    expect(residentKilled()).toBe(false);
    expect(result()).toBeUndefined();
    await resultFrame(1, 137);
    await finishSession();
    const terminal = sent.filter(
      (item) => item["type"] === "command_result" || item["type"] === "result",
    );
    expect(terminal.at(-1)).toMatchObject({ type: "result", reason: "cancelled" });
    expect(terminal.at(-2)).toMatchObject({
      type: "command_result",
      attemptId: "attempt-a",
      reason: "cancelled",
      ...settledFields,
    });
    expect(residentKilled()).toBe(true);
    expect(boundary.manager.reset).toHaveBeenCalledOnce();
  });

  it.each([
    ["deadline", "deadline"],
    ["deadline", "cancelled"],
    ["cancelled", "deadline"],
  ] as const)(
    "[R2-P2] keeps a deferred %s stop when a %s stop repeats before the command settles",
    async (first, second) => {
      await openSession(sessionRequest({ cleanupTimeoutMs: 1000 }));
      await readyRunner();
      await command("attempt-a", 1);
      await receive("cancel", { reason: first });
      await flush();
      await receive("cancel", { reason: second });
      await flush();
      expect(residentKilled()).toBe(false);
      await resultFrame(1, 137);
      await finishSession();
      expect(lastCommand()).toMatchObject({
        attemptId: "attempt-a",
        reason: first,
        ...settledFields,
      });
      expect(result()).toMatchObject({ reason: first });
      expect(residentKilled()).toBe(true);
    },
  );

  it("[R2-P2] settles a command whose deadline equals the session deadline when the session timer fires first", async () => {
    const deadlineAt = new Date(Date.now() + 1000).toISOString();
    await openSession(sessionRequest({ deadlineAt, cleanupTimeoutMs: 1000 }));
    await readyRunner();
    await command("attempt-a", 1, { deadlineAt });
    await advance(1100);
    await receive("cancel", { reason: "deadline" });
    await flush();
    expect(residentKilled()).toBe(false);
    await resultFrame(1, 137);
    await finishSession();
    expect(lastCommand()).toMatchObject({
      attemptId: "attempt-a",
      reason: "deadline",
      ...settledFields,
    });
    expect(result()).toMatchObject({ reason: "deadline" });
  });

  it("[R2-P2] keeps the session stop reason when a deferred command never reports back", async () => {
    await openSession(sessionRequest({ cleanupTimeoutMs: 300 }));
    await readyRunner();
    await command("attempt-a", 1);
    await receive("cancel", { reason: "deadline" });
    await advance(500);
    await drain();
    expect(lastCommand()).toMatchObject({
      attemptId: "attempt-a",
      reason: "deadline",
      taskProcessExited: false,
    });
    expect(result()).toMatchObject({ reason: "deadline" });
    expect(residentKilled()).toBe(true);
  });

  it("[R2-P2] ends an idle session at its own deadline", async () => {
    await openSession(sessionRequest({ deadlineAt: new Date(Date.now() + 2000).toISOString() }));
    await readyRunner();
    await command("attempt-a", 1, { deadlineAt: new Date(Date.now() + 1000).toISOString() });
    await resultFrame(1, 0);
    expect(lastCommand()).toMatchObject({ attemptId: "attempt-a", exitCode: 0 });
    await advance(2300);
    await flush();
    expect(result()).toMatchObject({ reason: "deadline" });
    expect(boundary.manager.reset).toHaveBeenCalledOnce();
    expect(commandResults()).toHaveLength(1);
  });

  it("[R2-P2] fails the session when a command changes the policy digest", async () => {
    await openSession();
    await readyRunner();
    await receive("run", { run: runInput("attempt-a", 1, { policyDigest: "b".repeat(64) }) });
    await drain();
    expect(runFrames()).toHaveLength(0);
    expect(result()).toMatchObject({ reason: "host_failure" });
    expect(sent.find((item) => item["type"] === "diagnostic")).toMatchObject({
      detail: { code: "JOB_HOST_RUN_INVALID" },
    });
  });

  it("[R2-P2] stops the resident runner once when the session ends", async () => {
    await openSession();
    await readyRunner();
    await command("attempt-a", 1);
    await resultFrame(1, 0);
    expect(commandResults()).toHaveLength(1);
    await receive("cancel");
    await drain();
    expect(result()).toMatchObject({ reason: "cancelled" });
    const before = processBoundary.kill.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(processBoundary.kill.mock.calls.length).toBe(before);
    expect(
      processBoundary.kill.mock.calls.some(
        ([pid, signal]) => pid === -7000 && signal === "SIGKILL",
      ),
    ).toBe(true);
  });
});
