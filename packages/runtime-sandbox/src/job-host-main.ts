import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  resolveLinuxTmpfsDestination,
  rewriteLinuxReadOnlyTmpfs,
} from "./bwrap-read-only-tmpfs.ts";
import { jobCommand } from "./job-command.ts";
import { type JobHostControlBinding, openJobHostControl } from "./job-host-control.ts";
import { JobHostNetworkAuthority } from "./job-host-network-authority.ts";
import {
  JOB_HOST_SYSTEM_CODES,
  type JobHostCommandReport,
  type JobHostDiagnostic,
  type JobHostNamespaceState,
  type JobHostRequest,
  type JobHostRun,
  jobHostCommandSettled,
  parseJobHostRequest,
  parseJobHostRun,
  parseJobHostSessionRequest,
} from "./job-host-protocol.ts";
import {
  captureLinuxNamespace,
  type LinuxNamespaceIdentity,
  readLinuxNamespaceState,
} from "./linux-namespace.ts";
import { startLinuxHostGuardian } from "./linux-host-guardian.ts";
import { openNetworkEgress } from "./network-egress.ts";
import { stopProcessGroup } from "./process-group.ts";
import { readProcessStartToken } from "./process-identity.ts";
import { startReadinessProbe } from "./readiness-probe.ts";
import { observeTaskResources, readProcessSnapshot } from "./resource-observer.ts";
import type { SandboxSdk } from "./sandbox-sdk.ts";

// This entry is forked by the trusted Worker with a clean environment before any
// SDK import. The task gets pipes only; it never inherits this IPC channel.
const diagnosticStarted = performance.now();
const bootId = randomUUID();
const processStartedAt = new Date().toISOString();
const processIdentityRef = `job-host-process:${randomUUID()}`;
let sessionId: string | undefined;
let messageSequence = 0;
let workerSequence = 0;
let controlSequence = 0;
let control: Awaited<ReturnType<typeof openJobHostControl>> | undefined;
let managerReset = false;
let taskProcessGroupGone = false;
let processStartToken: string | undefined;
let taskProcessGroup: { processGroupId: number; startToken: string } | undefined;
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
let failureStage: JobHostDiagnostic["stage"] = "request";
const steps: Array<{
  stage: JobHostDiagnostic["stage"];
  startedMs: number;
  elapsedMs: number | null;
}> = [];
let exited = false;
let closed = false;
let finishing = false;
let diagnostics: typeof import("@himawari-agent/execution-contracts") | undefined;
let sandboxManager: SandboxSdk | undefined;
let sdkOperation: Promise<unknown> = Promise.resolve();
let egress: Awaited<ReturnType<typeof openNetworkEgress>> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let emergency: ReturnType<typeof setTimeout> | undefined;

type CommandCause = "cancelled" | "deadline" | "output_limit" | "resource_limit";
interface SessionCommand {
  readonly run: JobHostRun;
  task?: ChildProcess;
  spawned: boolean;
  started: boolean;
  exited: boolean;
  closed: boolean;
  cause?: CommandCause;
  namespace: LinuxNamespaceIdentity | null;
  observer?: ReturnType<typeof observeTaskResources>;
  readonly timers: Array<ReturnType<typeof setTimeout>>;
  settlement?: Promise<void>;
}
let sessionMode = false;
let runSequence = 0;
let active: SessionCommand | undefined;
let reportedAttemptId: string | undefined;
let sessionTaskStarted = false;
let spawnedCommands = 0;
let commandsExited = true;
let commandsClosed = true;
let commandGroupsGone = true;

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
const networkAuthority = new JobHostNetworkAuthority(send, () => stop("cancelled"));
function sinceStart() {
  return Math.max(0, Math.min(86_400_000, Math.round(performance.now() - diagnosticStarted)));
}
function stepsSnapshot() {
  return steps.map((step) => ({ ...step }));
}
function sendHeartbeat() {
  send({ type: "heartbeat", steps: stepsSnapshot() });
}
function enterStage(stage: JobHostDiagnostic["stage"]) {
  failureStage = stage;
  const now = sinceStart();
  const open = steps.at(-1);
  if (open && open.elapsedMs === null) open.elapsedMs = Math.max(0, now - open.startedMs);
  if (steps.length < 16) steps.push({ stage, startedMs: now, elapsedMs: null });
  sendHeartbeat();
}

const LAUNCH_FAILURE_TEXT_CODES: ReadonlyArray<
  readonly [RegExp, (typeof JOB_HOST_SYSTEM_CODES)[number]]
> = [
  [/operation not permitted/i, "EPERM"],
  [/permission denied/i, "EACCES"],
  [/no such file or directory/i, "ENOENT"],
  [/no space left on device/i, "ENOSPC"],
  [/cannot allocate memory|out of memory/i, "ENOMEM"],
  [/too many open files/i, "EMFILE"],
  [/resource temporarily unavailable/i, "EAGAIN"],
  [/address already in use/i, "EADDRINUSE"],
  [/connection reset by peer/i, "ECONNRESET"],
  [/invalid argument/i, "EINVAL"],
  [/input\/output error/i, "EIO"],
];
function bwrapFailureLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("bwrap: "))
    .at(-1);
}
function launchFailureSystemCode(text: string): (typeof JOB_HOST_SYSTEM_CODES)[number] {
  const line = bwrapFailureLine(text);
  if (!line) return "UNKNOWN";
  for (const [pattern, code] of LAUNCH_FAILURE_TEXT_CODES) if (pattern.test(line)) return code;
  return "UNKNOWN";
}
interface LaunchFailure {
  readonly code: NonNullable<JobHostDiagnostic["detail"]>["code"];
  readonly systemCode: (typeof JOB_HOST_SYSTEM_CODES)[number];
  readonly text: string | null;
}
function sendLaunchFailureDiagnostic(
  { code, systemCode, text }: LaunchFailure,
  command: "start" | "run",
) {
  if (!request) return;
  const bounded = (value: number) => Math.max(-86_400_000, Math.min(86_400_000, Math.round(value)));
  const detail = diagnostics
    ? diagnostics.sandboxHostFailureDetailSchema.parse({
        code,
        command,
        phase,
        elapsedMs: Math.max(0, sinceStart()),
        messageAgeMs: null,
        deadlineRemainingMs: bounded(Date.parse(request.deadlineAt) - Date.now()),
        expectedSequence: workerSequence + 1,
        receivedSequence: null,
        text,
        steps: stepsSnapshot(),
      })
    : undefined;
  send({
    type: "diagnostic",
    stage: "launch",
    systemCode,
    ...(detail ? { detail } : {}),
  });
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
  clearTimeout(emergency);
  emergency = setTimeout(() => process.exit(1), request?.cleanupTimeoutMs ?? 5000);
  observer?.stop();
  phase = "stopping";
  networkAuthority.close();
  void egress?.close();
  clearTimeout(deadline);
  if (active) {
    killCommand(active);
    await settleCommand(active);
  }
  killTask();
  readiness?.cancel();
  await readiness?.result.catch(() => false);
  if (userTaskStarted && task?.pid !== undefined)
    taskProcessGroupGone = await stopProcessGroup(task.pid, {
      timeoutMs: Math.min(1000, request?.cleanupTimeoutMs ?? 1000),
      intervalMs: 10,
      kill: (pid, signal) => process.kill(pid, signal),
    });
  let reset = false;
  try {
    // Initialization/wrapping must settle before reset. The emergency deadline
    // remains armed if the SDK never settles.
    await sdkOperation.catch(() => {});
    await egress?.close();
    if (sandboxManager) {
      if (!sessionMode) await sandboxManager.cleanupAfterCommand();
      await sandboxManager.reset();
      reset = true;
    }
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
  clearInterval(heartbeat);
  send({
    type: "result",
    network: egress?.observation() ?? null,
    reason,
    resources: observer?.current() ?? null,
    exitCode: task?.exitCode ?? null,
    taskStarted: sessionMode ? sessionTaskStarted : userTaskStarted,
    taskProcessExited: sessionMode ? spawnedCommands > 0 && commandsExited : exited,
    stdioClosed: sessionMode ? spawnedCommands > 0 && commandsClosed : closed,
    srtReset: reset,
    taskProcessGroupGone: sessionMode ? commandGroupsGone : taskProcessGroupGone,
  });
  // IPC drains before disconnect; final close remains bounded by emergency.
  if (process.connected) process.disconnect();
  // Keep the final-exit watchdog armed for leaked SDK handles.
  emergency?.unref();
  process.exitCode = reset ? 0 : 1;
}
async function recordStart(groupId: number) {
  try {
    const [host, leader] = await Promise.all([
      readProcessStartToken(process.pid),
      readProcessStartToken(groupId),
    ]);
    if (!host || !leader || !control) return;
    processStartToken = host;
    taskProcessGroup = { processGroupId: groupId, startToken: leader };
    await control.recordStart();
  } catch {
    return;
  }
}
function stop(cause: string) {
  if (phase === "finished") return;
  if (phase !== "stopping") reason = cause;
  phase = "stopping";
  networkAuthority.close();
  void egress?.close();
  killTask();
  if (active) killCommand(active);
  emergency ??= setTimeout(() => {
    void finish();
  }, request?.cleanupTimeoutMs ?? 5000);
  if (sessionMode ? !active?.task : !task) void finish();
}
async function prepare(value: unknown, controlValue: unknown, session: boolean) {
  if (phase !== "waiting") throw new Error("JOB_HOST_ALREADY_PREPARED");
  phase = "preparing";
  request = session ? parseJobHostSessionRequest(value) : parseJobHostRequest(value);
  sessionMode = session;
  deadline = setTimeout(
    () => stop("deadline"),
    Math.max(1, Date.parse(request.deadlineAt) - Date.now()),
  );
  if (session && controlValue !== undefined) throw new Error("JOB_HOST_SESSION_MODE_INVALID");
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
      ...(request.policy.workspace ? [request.policy.workspace] : []),
      request.policy.privateDirectory,
      ...request.policy.readOnlyToolchainPaths,
    ]) {
      if (overlaps(allowed, binding.directory) || overlaps(binding.directory, allowed))
        throw new Error("JOB_HOST_CONTROL_SCOPE_OVERLAP");
    }
    const policyInput = request.policy;
    const requestedPolicyDigest = request.policyDigest;
    enterStage("control");
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
        policyDigest: requestedPolicyDigest,
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
        taskProcessGroupGone,
        ...(processStartToken && taskProcessGroup ? { processStartToken, taskProcessGroup } : {}),
      }),
      () => stop("cancelled"),
    );
  }
  enterStage("dependencies");
  const loading = import("@himawari-agent/execution-contracts").then(async (module) => {
    diagnostics = module;
    if (phase !== "preparing") return;
    const { createSandboxSdk } = await import("./sandbox-sdk.ts");
    const manager = await createSandboxSdk(() => stop("host_failure"));
    sandboxManager = manager;
    return manager;
  });
  sdkOperation = loading;
  const manager = await loading;
  if (!manager || phase !== "preparing") return;
  enterStage("policy");
  const privateDirectory = await realpath(request.policy.privateDirectory);
  if (
    process.env["HOME"] !== privateDirectory ||
    process.env["TMPDIR"] !== privateDirectory ||
    process.env["CLAUDE_CODE_TMPDIR"] !== privateDirectory
  )
    throw new Error("JOB_HOST_ENVIRONMENT_INVALID");
  process.chdir(request.policy.workspace ?? privateDirectory);
  const { policyJson } = await manager.compileSandboxPolicy(request.policy);
  const policy = {
    policyJson,
    policyDigest: createHash("sha256").update(policyJson).digest("hex"),
  };
  if (policy.policyDigest !== request.policyDigest) throw new Error("JOB_HOST_POLICY_CHANGED");
  enterStage("resource_snapshot");
  if (request.resourceLimits || sessionMode) await readProcessSnapshot();
  enterStage("dependencies");
  const dependencies = await manager.checkDependenciesAsync();
  if (!manager.isSupportedPlatform() || dependencies.errors.length || dependencies.warnings.length)
    throw new Error("JOB_HOST_DEPENDENCIES_UNAVAILABLE");
  if (phase !== "preparing") return;
  // The ephemeral upstream is infrastructure-owned, never accepted from a scope.
  // The frozen policy digest binds the allowed targets; runtime digest binds this
  // mandatory routing implementation. Both proxy schemes disable all bypasses.
  sdkOperation = (async () => {
    if (process.platform === "linux") {
      await startLinuxHostGuardian(request.cleanupTimeoutMs ?? 5000, () => stop("host_failure"));
      if (phase !== "preparing") return;
    }
    const configuration = JSON.parse(policy.policyJson);
    enterStage("network");
    egress = await openNetworkEgress(
      configuration.network.allowedDomains,
      networkAuthority.assertCurrent,
    );
    if (phase !== "preparing") {
      await egress.close();
      return;
    }
    configuration.network.parentProxy = egress.parentProxy;
    enterStage("sdk_initialize");
    const javaAgentJarPath = fileURLToPath(
      new URL(
        "../vendor/java-proxy-agent/srt-proxy-agent.jar",
        import.meta.resolve("@anthropic-ai/sandbox-runtime"),
      ),
    );
    if (
      (await realpath(javaAgentJarPath)) !== javaAgentJarPath ||
      !(await stat(javaAgentJarPath)).isFile()
    )
      throw new Error("JOB_HOST_JAVA_AGENT_INVALID");
    configuration.javaAgentJarPath = javaAgentJarPath;
    await manager.initialize(configuration, undefined, false);
  })();
  await sdkOperation;
  if (phase !== "preparing") {
    await finish();
    return;
  }
  enterStage("launch");
  phase = "ready";
  send({
    type: "ready",
    jobId: request.jobId,
    attemptId: request.attemptId,
    policyDigest: policy.policyDigest,
  });
}
interface TaskLaunch {
  readonly manager: SandboxSdk;
  readonly request: JobHostRequest;
  readonly deadlineAt: string;
  readonly input: Buffer;
  readonly maxOutputBytes: number;
  running(): boolean;
  notLaunched(): void;
  spawned(child: ChildProcess): void;
  exposed(): void;
  namespace(identity: LinuxNamespaceIdentity): void;
  started(pid: number): void;
  output(channel: "stdout" | "stderr", bytes: Buffer): void;
  outputLimit(): void;
  failed(failure?: LaunchFailure): void;
  spawnFailed(failure: LaunchFailure): void;
  exited(): void;
  closed(): void;
}
async function launchTask(launch: TaskLaunch) {
  const current = launch.request;
  // SRT 0.0.75 advertises localhost in proxy URLs. Node's getaddrinfo can
  // fail under the Mac resolver restrictions even with /etc/hosts readable.
  // Normalize only SRT-owned proxy variables inside its wrapper; retain its
  // authentication/ports and the OS deny policy, without opening DNS services.
  const namespaceToken = randomUUID();
  const namespaceGate = process.platform === "linux";
  const command = namespaceGate
    ? `printf '${namespaceToken}:%s:%s\\n' "$$" "$(readlink /proc/self/ns/pid)" >&2; IFS= read -r himawari_start; [ "$himawari_start" = '${namespaceToken}' ] || exit 125; ${jobCommand(current.executable, current.args, true)}`
    : jobCommand(current.executable, current.args, false);
  const wrapping = launch.manager.wrapWithSandboxArgv(command, "/bin/bash");
  sdkOperation = wrapping;
  const wrapped = await wrapping;
  if (!launch.running() || Date.now() >= Date.parse(launch.deadlineAt)) {
    launch.notLaunched();
    return;
  }
  const launchArgv =
    process.platform === "linux"
      ? rewriteLinuxReadOnlyTmpfs(wrapped.argv, "/bin/bash", resolveLinuxTmpfsDestination)
      : wrapped.argv;
  const executable = launchArgv[0];
  if (!executable) throw new Error("JOB_HOST_LAUNCH_INVALID");
  const child = spawn(executable, launchArgv.slice(1), {
    cwd: current.policy.workspace ?? current.policy.privateDirectory,
    env: wrapped.env,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  launch.spawned(child);
  child.on("error", (error: NodeJS.ErrnoException) => {
    launch.spawnFailed({
      code: "JOB_HOST_LAUNCH_SPAWN_FAILED",
      systemCode: JOB_HOST_SYSTEM_CODES.some((code) => code === error?.code)
        ? (error.code as (typeof JOB_HOST_SYSTEM_CODES)[number])
        : "UNKNOWN",
      text: error?.message ?? null,
    });
  });
  child.stdin?.on("error", () => launch.failed());
  let startAcknowledged = false;
  // On Mac, spawn already permits user code before its asynchronous event.
  if (!namespaceGate && child.pid !== undefined) launch.exposed();
  const acknowledgeStart = () => {
    if (!launch.running() || !child.pid || startAcknowledged)
      throw new Error("JOB_HOST_START_ABORTED");
    startAcknowledged = true;
    launch.started(child.pid);
  };
  if (!namespaceGate) {
    child.stdin?.end(launch.input);
    child.on("spawn", () => {
      try {
        acknowledgeStart();
      } catch {
        launch.failed();
      }
    });
  }
  let gateBytes = Buffer.alloc(0);
  let gateReceivedBytes = 0;
  const gateDiagnostics: Buffer[] = [];
  const gateFailure = (
    code: "JOB_HOST_NAMESPACE_GATE_INVALID" | "JOB_HOST_NAMESPACE_GATE_TIMEOUT",
  ): LaunchFailure => {
    const text = Buffer.concat([...gateDiagnostics, gateBytes])
      .subarray(-4096)
      .toString("utf8");
    return { code, systemCode: launchFailureSystemCode(text), text: text || null };
  };
  let gatePending = namespaceGate;
  const gateTimeout = namespaceGate
    ? setTimeout(() => launch.failed(gateFailure("JOB_HOST_NAMESPACE_GATE_TIMEOUT")), 1500)
    : undefined;
  const receiveGate = async (line: string) => {
    const match = new RegExp(`^${namespaceToken}:(\\d+):(pid:\\[\\d+\\])$`).exec(line);
    if (!match || !child.pid || !match[1] || !match[2])
      throw new Error("JOB_HOST_NAMESPACE_GATE_INVALID");
    launch.namespace(await captureLinuxNamespace(child.pid, Number(match[1]), match[2]));
    if (!launch.running()) throw new Error("JOB_HOST_START_ABORTED");
    acknowledgeStart();
    clearTimeout(gateTimeout);
    child.stdin?.end(Buffer.concat([Buffer.from(`${namespaceToken}\n`), launch.input]));
  };
  child.on("exit", () => launch.exited());
  child.on("close", () => {
    clearTimeout(gateTimeout);
    launch.closed();
  });
  let total = 0;
  for (const [stream, channel] of [
    [child.stdout, "stdout"],
    [child.stderr, "stderr"],
  ] as const) {
    stream?.on("data", (received: Buffer) => {
      let chunk = received;
      if (namespaceGate && channel === "stderr" && gatePending) {
        gateReceivedBytes += chunk.byteLength;
        gateBytes = Buffer.concat([gateBytes, chunk]);
        if (gateReceivedBytes > 1024) {
          launch.failed(gateFailure("JOB_HOST_NAMESPACE_GATE_INVALID"));
          return;
        }
        // stderr is also used by the wrapping shell for startup diagnostics.
        // Only the unpredictable token identifies our control frame; diagnostics
        // cannot start user code, renew the deadline, or bypass namespace capture.
        while (gatePending) {
          const newline = gateBytes.indexOf(10);
          if (newline < 0) return;
          const line = gateBytes.subarray(0, newline).toString("utf8");
          const bytes = gateBytes.subarray(0, newline + 1);
          gateBytes = gateBytes.subarray(newline + 1);
          if (!line.startsWith(`${namespaceToken}:`)) {
            gateDiagnostics.push(bytes);
            continue;
          }
          gatePending = false;
          chunk = Buffer.concat([...gateDiagnostics, gateBytes]);
          void receiveGate(line).catch(() =>
            launch.failed(gateFailure("JOB_HOST_NAMESPACE_GATE_INVALID")),
          );
        }
      }
      const available = Math.max(0, launch.maxOutputBytes - total);
      const accepted = chunk.subarray(0, available);
      total += accepted.byteLength;
      if (accepted.byteLength) launch.output(channel, accepted);
      if (chunk.byteLength > available) launch.outputLimit();
    });
  }
}
async function start() {
  if (phase !== "ready" || !request || !sandboxManager || sessionMode)
    throw new Error("JOB_HOST_NOT_READY");
  const manager = sandboxManager;
  const current = request;
  phase = "running";
  await launchTask({
    manager,
    request: current,
    deadlineAt: current.deadlineAt,
    input: Buffer.from(current.stdinBase64 ?? "", "base64"),
    maxOutputBytes: current.maxOutputBytes,
    running: () => phase === "running",
    notLaunched: () => stop("deadline"),
    spawned: (child) => {
      task = child;
    },
    exposed: () => {
      userTaskStarted = true;
    },
    namespace: (identity) => {
      linuxNamespace = identity;
    },
    started: (pid) => {
      userTaskStarted = true;
      send({
        type: "started",
        pid,
        taskIdentityRef: `sandbox-process:${randomUUID()}`,
        taskStartedAt: new Date().toISOString(),
      });
      void recordStart(pid);
      if (current.readiness) {
        readiness = startReadinessProbe({
          probe: current.readiness,
          privateDirectory: current.policy.privateDirectory,
          deadlineAt: current.deadlineAt,
          active: () => phase === "running" && !exited,
          wrap: async (command) => {
            const wrapped = await manager.wrapWithSandboxArgv(command, "/bin/bash");
            if (process.platform !== "linux") return wrapped;
            return {
              ...wrapped,
              argv: [
                ...rewriteLinuxReadOnlyTmpfs(
                  wrapped.argv,
                  "/bin/bash",
                  resolveLinuxTmpfsDestination,
                ),
              ],
            };
          },
        });
        void readiness.result
          .then((ready) => {
            if (ready) readyAt = new Date().toISOString();
            else if (phase === "running") stop("host_failure");
          })
          .catch(() => stop("host_failure"));
      }
      if (current.resourceLimits)
        observer = observeTaskResources(pid, current.resourceLimits, stop);
    },
    output: (channel, bytes) => send({ type: "output", channel, bytes: bytes.toString("base64") }),
    outputLimit: () => stop("output_limit"),
    failed: (failure) => {
      if (failure) sendLaunchFailureDiagnostic(failure, "start");
      stop("host_failure");
    },
    spawnFailed: (failure) => {
      sendLaunchFailureDiagnostic(failure, "start");
      reason = "host_failure";
      void finish();
    },
    exited: () => {
      exited = true;
      observer?.stop();
      killTask();
      emergency ??= setTimeout(() => {
        void finish();
      }, current.cleanupTimeoutMs ?? 5000);
    },
    closed: () => {
      closed = true;
      if (userTaskStarted && exited && reason === "exited" && task?.exitCode !== null)
        send({
          type: "completed",
          exitCode: task?.exitCode,
          reason,
          taskProcessExited: true,
          stdioClosed: true,
        });
      void finish();
    },
  });
}
function killCommand(command: SessionCommand) {
  const child = command.task;
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}
function endCommand(command: SessionCommand, cause: CommandCause) {
  if (active !== command || command.cause !== undefined || phase !== "running") return;
  command.cause = cause;
  killCommand(command);
}
async function commandNamespace(command: SessionCommand): Promise<JobHostNamespaceState> {
  if (!command.spawned || command.task?.pid === undefined) return "not_applicable";
  if (!command.namespace) return "unknown";
  const until = Date.now() + 1000;
  for (;;) {
    const state = await readLinuxNamespaceState(command.namespace);
    if (state === "released" || Date.now() >= until) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function settleCommand(command: SessionCommand): Promise<void> {
  command.settlement ??= (async () => {
    for (const timer of command.timers) clearTimeout(timer);
    command.observer?.stop();
    const pid = command.task?.pid;
    const processGroupGone =
      pid === undefined
        ? true
        : await stopProcessGroup(pid, {
            timeoutMs: Math.min(1000, request?.cleanupTimeoutMs ?? 1000),
            intervalMs: 10,
            kill: (id, signal) => process.kill(id, signal),
          });
    const namespace = await commandNamespace(command);
    let cleanedUp = false;
    try {
      await sdkOperation.catch(() => {});
      if (!sandboxManager) throw new Error("JOB_HOST_NOT_READY");
      const manager = sandboxManager;
      const cleaning = (async () => {
        await manager.cleanupAfterCommand();
      })();
      sdkOperation = cleaning;
      await cleaning;
      cleanedUp = true;
    } catch {
      cleanedUp = false;
    }
    const report: JobHostCommandReport = {
      attemptId: command.run.attemptId,
      sequence: command.run.sequence,
      reason:
        command.cause ??
        (phase === "stopping" ? (reason as JobHostCommandReport["reason"]) : "exited"),
      exitCode: command.task?.exitCode ?? null,
      resources: command.observer?.current() ?? null,
      taskStarted: command.started,
      taskProcessExited: command.exited,
      stdioClosed: command.closed,
      processGroupGone,
      namespace,
      cleanedUp,
    };
    const { sequence: runSequence, ...fields } = report;
    send({ type: "command_result", ...fields, runSequence });
    reportedAttemptId = command.run.attemptId;
    if (active === command) active = undefined;
    commandGroupsGone &&= processGroupGone;
    if (command.spawned) {
      commandsExited &&= command.exited;
      commandsClosed &&= command.closed;
    }
    if (phase === "running") {
      if (jobHostCommandSettled(report)) phase = "ready";
      else stop("host_failure");
    } else if (phase === "stopping") void finish();
  })();
  return command.settlement;
}
async function runCommand(value: unknown) {
  if (!sessionMode || phase !== "ready" || active || !request || !sandboxManager)
    throw new Error("JOB_HOST_RUN_NOT_ALLOWED");
  const run = parseJobHostRun(value, request, runSequence);
  runSequence = run.sequence;
  const command: SessionCommand = {
    run,
    spawned: false,
    started: false,
    exited: false,
    closed: false,
    namespace: null,
    timers: [],
  };
  active = command;
  phase = "running";
  command.timers.push(
    setTimeout(
      () => endCommand(command, "deadline"),
      Math.max(1, Date.parse(run.deadlineAt) - Date.now()),
    ),
  );
  const current = request;
  await launchTask({
    manager: sandboxManager,
    request: current,
    deadlineAt: run.deadlineAt,
    input: Buffer.from(run.inputBase64, "base64"),
    maxOutputBytes: run.maxOutputBytes,
    running: () => phase === "running" && active === command && command.cause === undefined,
    notLaunched: () => {
      if (active !== command || phase !== "running") return;
      command.cause ??= "deadline";
      void settleCommand(command);
    },
    spawned: (child) => {
      command.task = child;
      command.spawned = true;
      spawnedCommands++;
    },
    exposed: () => {
      command.started = true;
      sessionTaskStarted = true;
    },
    namespace: (identity) => {
      command.namespace = identity;
    },
    started: (pid) => {
      command.started = true;
      sessionTaskStarted = true;
      send({
        type: "started",
        attemptId: run.attemptId,
        pid,
        taskIdentityRef: `sandbox-process:${randomUUID()}`,
        taskStartedAt: new Date().toISOString(),
      });
      command.observer = observeTaskResources(pid, run.resourceLimits, (cause) => {
        if (cause === "resource_limit") endCommand(command, cause);
        else stop("host_failure");
      });
    },
    output: (channel, bytes) =>
      send({ type: "output", attemptId: run.attemptId, channel, bytes: bytes.toString("base64") }),
    outputLimit: () => endCommand(command, "output_limit"),
    failed: (failure) => {
      if (active !== command || command.cause !== undefined) return;
      if (failure) sendLaunchFailureDiagnostic(failure, "run");
      stop("host_failure");
    },
    spawnFailed: (failure) => {
      sendLaunchFailureDiagnostic(failure, "run");
      stop("host_failure");
      void finish();
    },
    exited: () => {
      command.exited = true;
      command.observer?.stop();
      killCommand(command);
      command.timers.push(setTimeout(() => stop("host_failure"), current.cleanupTimeoutMs));
    },
    closed: () => {
      command.closed = true;
      void settleCommand(command);
    },
  });
}
function cancelCommand(attemptId: unknown, cause: unknown) {
  if (!sessionMode) throw new Error("JOB_HOST_RUN_NOT_ALLOWED");
  if (cause !== "cancelled" && cause !== "deadline") throw new Error("JOB_HOST_RUN_INVALID");
  if (active && attemptId === active.run.attemptId) endCommand(active, cause);
  else if (attemptId === undefined || attemptId !== reportedAttemptId)
    throw new Error("JOB_HOST_RUN_INVALID");
}
process.on("message", (message: unknown) => {
  const receivedAt = Date.now();
  const expectedSequence = workerSequence + 1;
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
      Date.parse(message.observedAt) > receivedAt ||
      receivedAt - Date.parse(message.observedAt) > 1500
    )
      throw new Error("JOB_HOST_WORKER_LEASE_INVALID");
    workerSequence++;
    lastWorkerTick = performance.now();
    if (message.type === "prepare") {
      if (sessionId !== undefined) throw new Error("JOB_HOST_SESSION_REPLACED");
      sessionId = message.sessionId;
      sendHeartbeat();
      heartbeat = setInterval(() => {
        if (performance.now() - lastWorkerTick > 1500) stop("host_failure");
        else sendHeartbeat();
      }, 250);
    } else if (message.sessionId !== sessionId) throw new Error("JOB_HOST_SESSION_REPLACED");
    if (message.type === "heartbeat") return;
    if (message.type === "authority_result") {
      networkAuthority.receive(
        "checkId" in message ? message.checkId : undefined,
        "allowed" in message ? message.allowed : undefined,
      );
      return;
    }
    if (message.type === "prepare" && "request" in message) {
      const session = "session" in message ? message.session : false;
      if (typeof session !== "boolean") throw new Error("JOB_HOST_SESSION_MODE_INVALID");
      await prepare(message.request, "control" in message ? message.control : undefined, session);
    } else if (message.type === "start") await start();
    else if (message.type === "run") await runCommand("run" in message ? message.run : undefined);
    else if (message.type === "run_cancel")
      cancelCommand(
        "attemptId" in message ? message.attemptId : undefined,
        "reason" in message ? message.reason : undefined,
      );
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
    if (request) {
      send({
        type: "diagnostic",
        stage: failureStage,
        detail: (() => {
          if (!diagnostics) return undefined;
          const { SANDBOX_HOST_FAILURE_CODES, sandboxHostFailureDetailSchema } = diagnostics;
          const incoming =
            message && typeof message === "object" ? (message as Record<string, unknown>) : {};
          const age =
            typeof incoming["observedAt"] === "string"
              ? receivedAt - Date.parse(incoming["observedAt"])
              : NaN;
          const bounded = (value: number) =>
            Number.isFinite(value)
              ? Math.max(-86_400_000, Math.min(86_400_000, Math.round(value)))
              : null;
          return sandboxHostFailureDetailSchema.parse({
            code:
              error instanceof Error &&
              SANDBOX_HOST_FAILURE_CODES.some((code) => code === error.message)
                ? error.message
                : "UNKNOWN",
            command: [
              "prepare",
              "heartbeat",
              "start",
              "run",
              "run_cancel",
              "cancel",
              "authority_result",
            ].includes(incoming["type"] as string)
              ? incoming["type"]
              : "unknown",
            phase,
            elapsedMs: Math.max(0, bounded(performance.now() - diagnosticStarted) ?? 0),
            messageAgeMs: bounded(age),
            deadlineRemainingMs: bounded(
              request ? Date.parse(request.deadlineAt) - Date.now() : NaN,
            ),
            expectedSequence,
            receivedSequence:
              Number.isSafeInteger(incoming["sequence"]) && (incoming["sequence"] as number) >= 0
                ? incoming["sequence"]
                : null,
            text: null,
            steps: stepsSnapshot(),
          });
        })(),
        systemCode: JOB_HOST_SYSTEM_CODES.some((code) => code === systemCode)
          ? systemCode
          : "UNKNOWN",
      });
    } else {
      process.stderr.write(`JOB_HOST_SYSTEM_${systemCode}\n`);
      process.stderr.write(
        `${error instanceof Error && /^JOB_HOST_[A-Z_]+$/.test(error.message) ? error.message : "JOB_HOST_PREPARATION_FAILED"}\n`,
      );
    }
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
