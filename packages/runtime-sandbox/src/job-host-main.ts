import { startReadinessProbe } from "./readiness-probe.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { type JobHostControlBinding, openJobHostControl } from "./job-host-control.ts";
import { type JobHostRequest, parseJobHostRequest, quoteJobArgument } from "./job-host-protocol.ts";
import { captureLinuxNamespace, type LinuxNamespaceIdentity } from "./linux-namespace.ts";
import { compileSandboxPolicy } from "./policy.ts";
import { observeTaskResources, readProcessSnapshot } from "./resource-observer.ts";

// This entry is forked by the trusted Worker with a clean environment before any
// SDK import. The task gets pipes only; it never inherits this IPC channel.
const bootId = randomUUID();
const processStartedAt = new Date().toISOString();
const processIdentityRef = `job-host-process:${randomUUID()}`;
let sessionId: string | undefined;
let messageSequence = 0;
let workerSequence = 0;
let controlSequence = 0;
let control: Awaited<ReturnType<typeof openJobHostControl>> | undefined;
let managerReset = false;
let readiness: ReturnType<typeof startReadinessProbe> | undefined;
let readyAt: string | null = null;
let lastWorkerTick = performance.now();
let heartbeat: ReturnType<typeof setInterval> | undefined;
let observer: ReturnType<typeof observeTaskResources> | undefined;
let request: JobHostRequest | undefined;
let task: ChildProcess | undefined;
let userTaskStarted = false;
let linuxNamespace: LinuxNamespaceIdentity | null = null;
let phase: "waiting" | "preparing" | "ready" | "running" | "stopping" | "finished" = "waiting";
let reason = "exited";
let total = 0;
let exited = false;
let closed = false;
let finishing = false;
let sdkOperation: Promise<unknown> = Promise.resolve();
let deadline: ReturnType<typeof setTimeout> | undefined;
let emergency: ReturnType<typeof setTimeout> | undefined;

function send(message: Record<string, unknown>) {
  if (process.connected)
    process.send?.(
      {
        ...message,
        protocolVersion: "job-host.v2",
        sessionId,
        bootId,
        processId: process.pid,
        processIdentityRef,
        processStartedAt,
        sequence: ++messageSequence,
        observedAt: new Date().toISOString(),
      },
      (error: Error | null) => {
        if (error) stop("cancelled");
      },
    );
}
function killTask() {
  // After wait/exit, the numeric PID can be reused; never turn it into a
  // recovery handle. Surviving descendants remain explicitly unverified.
  if (task?.pid && task.exitCode === null && task.signalCode === null) {
    try {
      process.kill(-task.pid, "SIGKILL");
    } catch {
      /* Already exited or unavailable; never claim tree cleanup. */
    }
  }
}
async function finish() {
  if (finishing) return;
  finishing = true;
  observer?.stop();
  clearInterval(heartbeat);
  phase = "stopping";
  clearTimeout(deadline);
  killTask();
  readiness?.cancel();
  await readiness?.result.catch(() => false);
  let reset = false;
  clearTimeout(emergency);
  emergency = setTimeout(() => process.exit(1), request?.cleanupTimeoutMs ?? 5000);
  try {
    // Initialization/wrapping must settle before reset. The emergency deadline
    // remains armed if the SDK never settles.
    await sdkOperation.catch(() => {});
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset();
    reset = true;
  } catch {
    reason = "host_failure";
  }
  phase = "finished";
  managerReset = reset;
  try {
    await control?.finish();
  } catch {
    reason = "host_failure";
  }
  send({
    type: "result",
    reason,
    resources: observer?.current() ?? null,
    exitCode: task?.exitCode ?? null,
    taskStarted: userTaskStarted,
    taskProcessExited: exited,
    stdioClosed: closed,
    srtReset: reset,
  });
  // IPC drains before disconnect; final close remains bounded by emergency.
  if (process.connected) process.disconnect();
  // Keep the final-exit watchdog armed for leaked SDK handles.
  emergency?.unref();
  process.exitCode = reset ? 0 : 1;
}
function stop(cause: string) {
  if (phase === "finished") return;
  if (phase !== "stopping") reason = cause;
  phase = "stopping";
  killTask();
  emergency ??= setTimeout(() => {
    void finish();
  }, request?.cleanupTimeoutMs ?? 5000);
  if (!task) void finish();
}
async function prepare(value: unknown, controlValue?: unknown) {
  if (phase !== "waiting") throw new Error("JOB_HOST_ALREADY_PREPARED");
  phase = "preparing";
  request = parseJobHostRequest(value);
  const privateDirectory = await realpath(request.policy.privateDirectory);
  if (
    process.env["HOME"] !== privateDirectory ||
    process.env["TMPDIR"] !== privateDirectory ||
    process.env["CLAUDE_CODE_TMPDIR"] !== privateDirectory
  )
    throw new Error("JOB_HOST_ENVIRONMENT_INVALID");
  process.chdir(request.policy.workspace);
  const policy = await compileSandboxPolicy(request.policy);
  if (policy.policyDigest !== request.policyDigest) throw new Error("JOB_HOST_POLICY_CHANGED");
  if (controlValue !== undefined) {
    const binding = controlValue as JobHostControlBinding;
    if (
      !binding ||
      binding.sessionId !== sessionId ||
      binding.jobId !== request.jobId ||
      binding.attemptId !== request.attemptId
    )
      throw new Error("JOB_HOST_CONTROL_BINDING_INVALID");
    const overlaps = (a: string, b: string) => {
      const relative = path.relative(a, b);
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      );
    };
    for (const allowed of [
      request.policy.workspace,
      request.policy.privateDirectory,
      ...request.policy.readOnlyToolchainPaths,
    ]) {
      if (overlaps(allowed, binding.directory) || overlaps(binding.directory, allowed))
        throw new Error("JOB_HOST_CONTROL_SCOPE_OVERLAP");
    }
    const policyInput = request.policy;
    control = await openJobHostControl(
      binding,
      () => ({
        sessionId: binding.sessionId,
        jobId: binding.jobId,
        attemptId: binding.attemptId,
        bootId,
        processIdentityRef,
        processId: process.pid,
        processStartedAt,
        resources: observer?.current() ?? null,
        sequence: ++controlSequence,
        observedAt: new Date().toISOString(),
        phase,
        policyDigest: policy.policyDigest,
        linuxNamespace,
        privateDirectoryRef: `sandbox-private:${createHash("sha256").update(policyInput.privateDirectory).digest("hex")}`,
        ...(request?.readiness
          ? {
              readiness: {
                ref: request.readiness.ref,
                digest: createHash("sha256")
                  .update(JSON.stringify(request.readiness))
                  .digest("hex"),
                readyAt,
              },
            }
          : {}),
        taskStarted: userTaskStarted,
        taskProcessExited: exited,
        stdioClosed: closed,
        srtReset: managerReset,
      }),
      () => stop("cancelled"),
    );
  }
  if (request.resourceLimits) await readProcessSnapshot();
  const dependencies = await SandboxManager.checkDependenciesAsync();
  if (
    !SandboxManager.isSupportedPlatform() ||
    dependencies.errors.length ||
    dependencies.warnings.length
  )
    throw new Error("JOB_HOST_DEPENDENCIES_UNAVAILABLE");
  if (phase !== "preparing") return;
  deadline = setTimeout(
    () => stop("deadline"),
    Math.max(1, Date.parse(request.deadlineAt) - Date.now()),
  );
  sdkOperation = SandboxManager.initialize(JSON.parse(policy.policyJson), undefined, false);
  await sdkOperation;
  if (phase !== "preparing") {
    await finish();
    return;
  }
  phase = "ready";
  send({
    type: "ready",
    jobId: request.jobId,
    attemptId: request.attemptId,
    policyDigest: policy.policyDigest,
  });
}
async function start() {
  if (phase !== "ready" || !request) throw new Error("JOB_HOST_NOT_READY");
  phase = "running";
  const actualCommand = [request.executable, ...request.args].map(quoteJobArgument).join(" ");
  const namespaceToken = randomUUID();
  const namespaceGate = process.platform === "linux";
  const command = namespaceGate
    ? `printf '${namespaceToken}:%s:%s\\n' "$$" "$(readlink /proc/self/ns/pid)" >&2; IFS= read -r himawari_start; [ "$himawari_start" = '${namespaceToken}' ] || exit 125; exec ${actualCommand}`
    : actualCommand;
  const wrapping = SandboxManager.wrapWithSandboxArgv(command, "/bin/bash");
  sdkOperation = wrapping;
  const launch = await wrapping;
  if (phase !== "running" || Date.now() >= Date.parse(request.deadlineAt)) {
    stop("deadline");
    return;
  }
  const executable = launch.argv[0];
  if (!executable) throw new Error("JOB_HOST_LAUNCH_INVALID");
  task = spawn(executable, launch.argv.slice(1), {
    cwd: request.policy.workspace,
    env: launch.env,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  task.on("error", () => {
    reason = "host_failure";
    void finish();
  });
  task.stdin?.on("error", () => stop("host_failure"));
  let startAcknowledged = false;
  // On Mac, spawn already permits user code before its asynchronous event.
  if (!namespaceGate && task.pid !== undefined) userTaskStarted = true;
  const acknowledgeStart = () => {
    if (phase !== "running" || !task?.pid || startAcknowledged)
      throw new Error("JOB_HOST_START_ABORTED");
    userTaskStarted = true;
    startAcknowledged = true;
    send({
      type: "started",
      pid: task.pid,
      taskIdentityRef: `sandbox-process:${randomUUID()}`,
      taskStartedAt: new Date().toISOString(),
    });
    if (request?.readiness) {
      readiness = startReadinessProbe({
        probe: request.readiness,
        privateDirectory: request.policy.privateDirectory,
        deadlineAt: request.deadlineAt,
        active: () => phase === "running" && !exited,
        wrap: (command) => SandboxManager.wrapWithSandboxArgv(command, "/bin/bash"),
      });
      void readiness.result
        .then((ready) => {
          if (ready) readyAt = new Date().toISOString();
          else if (phase === "running") stop("host_failure");
        })
        .catch(() => stop("host_failure"));
    }
    if (request?.resourceLimits)
      observer = observeTaskResources(task.pid, request.resourceLimits, stop);
  };
  if (!namespaceGate) {
    task.stdin?.end(Buffer.from(request.stdinBase64 ?? "", "base64"));
    task.on("spawn", () => {
      try {
        acknowledgeStart();
      } catch {
        stop("host_failure");
      }
    });
  }
  let gateBytes = Buffer.alloc(0);
  let gatePending = namespaceGate;
  const gateTimeout = namespaceGate ? setTimeout(() => stop("host_failure"), 1500) : undefined;
  const receiveGate = async (line: string) => {
    const match = new RegExp(`^${namespaceToken}:(\\d+):(pid:\\[\\d+\\])$`).exec(line);
    if (!match || !task?.pid || !match[1] || !match[2])
      throw new Error("JOB_HOST_NAMESPACE_GATE_INVALID");
    linuxNamespace = await captureLinuxNamespace(task.pid, Number(match[1]), match[2]);
    if (phase !== "running" || !request) throw new Error("JOB_HOST_START_ABORTED");
    acknowledgeStart();
    clearTimeout(gateTimeout);
    task.stdin?.end(
      Buffer.concat([
        Buffer.from(`${namespaceToken}\n`),
        Buffer.from(request.stdinBase64 ?? "", "base64"),
      ]),
    );
  };
  task.on("exit", () => {
    exited = true;
    observer?.stop();
    killTask();
    emergency ??= setTimeout(() => {
      void finish();
    }, request?.cleanupTimeoutMs ?? 5000);
  });
  task.on("close", () => {
    clearTimeout(gateTimeout);
    closed = true;
    void finish();
  });
  for (const [stream, channel] of [
    [task.stdout, "stdout"],
    [task.stderr, "stderr"],
  ] as const) {
    stream?.on("data", (received: Buffer) => {
      let chunk = received;
      if (namespaceGate && channel === "stderr" && gatePending) {
        gateBytes = Buffer.concat([gateBytes, chunk]);
        if (gateBytes.byteLength > 1024) {
          stop("host_failure");
          return;
        }
        const newline = gateBytes.indexOf(10);
        if (newline < 0) return;
        gatePending = false;
        const line = gateBytes.subarray(0, newline).toString("utf8");
        chunk = gateBytes.subarray(newline + 1);
        void receiveGate(line).catch(() => stop("host_failure"));
      }
      const available = Math.max(0, (request?.maxOutputBytes ?? 0) - total);
      const accepted = chunk.subarray(0, available);
      total += accepted.byteLength;
      if (accepted.byteLength)
        send({ type: "output", channel, bytes: accepted.toString("base64") });
      if (chunk.byteLength > available) stop("output_limit");
    });
  }
}
process.on("message", (message: unknown) => {
  void (async () => {
    if (!message || typeof message !== "object" || !("type" in message))
      throw new Error("JOB_HOST_MESSAGE_INVALID");
    if (
      !("protocolVersion" in message) ||
      message.protocolVersion !== "job-host.v2" ||
      !("sessionId" in message) ||
      typeof message.sessionId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(message.sessionId)
    )
      throw new Error("JOB_HOST_SESSION_INVALID");
    if (
      !("sequence" in message) ||
      message.sequence !== workerSequence + 1 ||
      !("observedAt" in message) ||
      typeof message.observedAt !== "string" ||
      !Number.isFinite(Date.parse(message.observedAt)) ||
      Date.parse(message.observedAt) > Date.now() ||
      Date.now() - Date.parse(message.observedAt) > 1500
    )
      throw new Error("JOB_HOST_WORKER_LEASE_INVALID");
    workerSequence++;
    lastWorkerTick = performance.now();
    if (message.type === "prepare") {
      if (sessionId !== undefined) throw new Error("JOB_HOST_SESSION_REPLACED");
      sessionId = message.sessionId;
      heartbeat = setInterval(() => {
        if (performance.now() - lastWorkerTick > 1500) stop("host_failure");
        else send({ type: "heartbeat" });
      }, 250);
    } else if (message.sessionId !== sessionId) throw new Error("JOB_HOST_SESSION_REPLACED");
    if (message.type === "heartbeat") return;
    if (message.type === "prepare" && "request" in message)
      await prepare(message.request, "control" in message ? message.control : undefined);
    else if (message.type === "start") await start();
    else if (message.type === "cancel") {
      const cause = "reason" in message ? message.reason : "cancelled";
      stop(cause === "deadline" || cause === "host_failure" ? cause : "cancelled");
    } else throw new Error("JOB_HOST_MESSAGE_INVALID");
  })().catch((error: unknown) => {
    // Machine codes only, on infrastructure stderr; never emit task input or SDK text.
    const systemCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      /^E[A-Z0-9_]{1,40}$/.test(error.code)
        ? error.code
        : "UNKNOWN";
    process.stderr.write(`JOB_HOST_SYSTEM_${systemCode}\n`);
    process.stderr.write(
      `${error instanceof Error && /^JOB_HOST_[A-Z_]+$/.test(error.message) ? error.message : "JOB_HOST_PREPARATION_FAILED"}\n`,
    );
    reason = "host_failure";
    stop("host_failure");
  });
});
process.on("disconnect", () => stop("cancelled"));
process.on("SIGTERM", () => stop("cancelled"));
if (!process.send) {
  process.stderr.write("JOB_HOST_IPC_REQUIRED\n");
  process.exitCode = 1;
}
