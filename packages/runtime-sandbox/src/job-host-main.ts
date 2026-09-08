import { type ChildProcess, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { type JobHostRequest, parseJobHostRequest, quoteJobArgument } from "./job-host-protocol.ts";
import { compileSandboxPolicy } from "./policy.ts";

// This entry is forked by the trusted Worker with a clean environment before any
// SDK import. The task gets pipes only; it never inherits this IPC channel.
let request: JobHostRequest | undefined;
let task: ChildProcess | undefined;
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
    process.send?.(message, (error: Error | null) => {
      if (error) stop("cancelled");
    });
}
function killTask() {
  if (task?.pid) {
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
  phase = "stopping";
  clearTimeout(deadline);
  killTask();
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
  send({
    type: "result",
    reason,
    exitCode: task?.exitCode ?? null,
    taskStarted: task?.pid !== undefined,
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
async function prepare(value: unknown) {
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
  const command = [request.executable, ...request.args].map(quoteJobArgument).join(" ");
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
    stdio: ["ignore", "pipe", "pipe"],
  });
  task.on("error", () => {
    reason = "host_failure";
    void finish();
  });
  task.on("spawn", () => send({ type: "started", pid: task?.pid }));
  task.on("exit", () => {
    exited = true;
    killTask();
    emergency ??= setTimeout(() => {
      void finish();
    }, request?.cleanupTimeoutMs ?? 5000);
  });
  task.on("close", () => {
    closed = true;
    void finish();
  });
  for (const [stream, channel] of [
    [task.stdout, "stdout"],
    [task.stderr, "stderr"],
  ] as const) {
    stream?.on("data", (chunk: Buffer) => {
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
    if (message.type === "prepare" && "request" in message) await prepare(message.request);
    else if (message.type === "start") await start();
    else if (message.type === "cancel") {
      const cause = "reason" in message ? message.reason : "cancelled";
      stop(cause === "deadline" || cause === "host_failure" ? cause : "cancelled");
    } else throw new Error("JOB_HOST_MESSAGE_INVALID");
  })().catch(() => {
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
