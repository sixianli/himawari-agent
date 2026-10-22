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
  JOB_HOST_STARTUP_WINDOW_MS,
  JOB_HOST_SYSTEM_CODES,
  type JobHostCommandReport,
  type JobHostDiagnostic,
  type JobHostRequest,
  type JobHostRun,
  jobHostCommandSettled,
  parseJobHostRequest,
  parseJobHostRun,
  parseJobHostSessionRequest,
} from "./job-host-protocol.ts";
import { captureLinuxNamespace, type LinuxNamespaceIdentity } from "./linux-namespace.ts";
import { startLinuxHostGuardian } from "./linux-host-guardian.ts";
import { openNetworkEgress } from "./network-egress.ts";
import { stopProcessGroup } from "./process-group.ts";
import { readProcessStartToken } from "./process-identity.ts";
import { startReadinessProbe } from "./readiness-probe.ts";
import {
  captureResidentInfrastructure,
  type ResidentInfrastructure,
  sweepResidentCommand,
} from "./resident-process-tree.ts";
import { observeTaskResources, readProcessSnapshot } from "./resource-observer.ts";
import type { SandboxSdk } from "./sandbox-sdk.ts";

const diagnosticStarted = performance.now();
const bootId = randomUUID();
const processStartedAt = new Date().toISOString();
const processIdentityRef = `job-host-process:${randomUUID()}`;
let sessionId: string | undefined;
let messageSequence = 0;
let replied = false;
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
  residentSequence: number | null;
  started: boolean;
  exited: boolean;
  closed: boolean;
  exitCode: number | null;
  forwardedBytes: number;
  cause?: CommandCause;
  observer?: ReturnType<typeof observeTaskResources>;
  readonly timers: Array<ReturnType<typeof setTimeout>>;
  settlement?: Promise<void>;
}
interface ResidentRunner {
  readonly child: ChildProcess;
  readonly group: number;
  infrastructure: ResidentInfrastructure | null;
  pending: Buffer;
  readySeen: boolean;
  exited: boolean;
  closed: boolean;
  sequence: number;
  readonly closedSignal: Promise<void>;
  readonly markClosed: () => void;
  readonly markReady: () => void;
  readonly markLost: (error: Error) => void;
}
let sessionMode = false;
let resident: ResidentRunner | undefined;
let runSequence = 0;
let active: SessionCommand | undefined;
let reportedAttemptId: string | undefined;
let sessionTaskStarted = false;
let spawnedCommands = 0;
let commandsExited = true;
let commandsClosed = true;
let pendingStop: "deadline" | "cancelled" | undefined;
let commandGroupsGone = true;

function send(message: Record<string, unknown>) {
  if (!process.connected) return;
  replied = true;
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
  if (task?.pid && task.exitCode === null && task.signalCode === null) {
    try {
      process.kill(-task.pid, "SIGKILL");
    } catch {}
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
  if (resident) commandGroupsGone &&= await stopResident(resident);
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
    taskProcessExited: sessionMode
      ? spawnedCommands > 0 && commandsExited && resident?.exited === true
      : exited,
    stdioClosed: sessionMode
      ? spawnedCommands > 0 && commandsClosed && resident?.closed === true
      : closed,
    srtReset: reset,
    taskProcessGroupGone: sessionMode ? commandGroupsGone : taskProcessGroupGone,
  });
  if (process.connected) process.disconnect();
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
  if (phase === "running" && active && (cause === "deadline" || cause === "cancelled")) {
    pendingStop ??= cause;
    endCommand(active, cause);
    return;
  }
  if (phase !== "stopping") reason = pendingStop ?? cause;
  phase = "stopping";
  networkAuthority.close();
  void egress?.close();
  killTask();
  if (active) killCommand(active);
  killResident();
  emergency ??= setTimeout(() => {
    void finish();
  }, request?.cleanupTimeoutMs ?? 5000);
  if (sessionMode || !task) void finish();
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
  if (sessionMode) {
    await launchResident(manager, request);
    if (phase !== "preparing") {
      await finish();
      return;
    }
  }
  phase = "ready";
  send({
    type: "ready",
    jobId: request.jobId,
    attemptId: request.attemptId,
    policyDigest: policy.policyDigest,
    ...(resident ? { residentProcessId: resident.group } : {}),
  });
}
interface TaskLaunch {
  readonly manager: SandboxSdk;
  readonly request: JobHostRequest;
  readonly deadlineAt: string;
  readonly input: Buffer;
  readonly keepInputOpen: boolean;
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
  if (!namespaceGate && child.pid !== undefined) launch.exposed();
  const acknowledgeStart = () => {
    if (!launch.running() || !child.pid || startAcknowledged)
      throw new Error("JOB_HOST_START_ABORTED");
    startAcknowledged = true;
    launch.started(child.pid);
  };
  if (!namespaceGate) {
    if (launch.keepInputOpen) child.stdin?.write(launch.input);
    else child.stdin?.end(launch.input);
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
    const gated = Buffer.concat([Buffer.from(`${namespaceToken}\n`), launch.input]);
    if (launch.keepInputOpen) child.stdin?.write(gated);
    else child.stdin?.end(gated);
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
    keepInputOpen: false,
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
function residentFrameLimit(): number {
  if (!diagnostics) throw new Error("JOB_HOST_NOT_READY");
  return diagnostics.PI_RESIDENT_FRAME_LIMIT_BYTES;
}
function residentSweep(runner: ResidentRunner, timeoutMs: number, proceed?: () => boolean) {
  if (!runner.infrastructure)
    return Promise.resolve({ commandTreeGone: false, infrastructureIntact: false });
  return sweepResidentCommand(runner.group, runner.infrastructure, {
    timeoutMs,
    intervalMs: 10,
    kill: (pid, signal) => process.kill(pid, signal),
    ...(proceed ? { proceed } : {}),
  }).catch(() => ({ commandTreeGone: false, infrastructureIntact: false }));
}
function killResident() {
  const runner = resident;
  if (!runner || runner.exited) return;
  try {
    process.kill(-runner.group, "SIGKILL");
  } catch {}
}
async function stopResident(runner: ResidentRunner): Promise<boolean> {
  killResident();
  const timeoutMs = Math.min(1000, request?.cleanupTimeoutMs ?? 1000);
  const gone = await stopProcessGroup(runner.group, {
    timeoutMs,
    intervalMs: 10,
    kill: (pid, signal) => process.kill(pid, signal),
  });
  await Promise.race([
    runner.closedSignal,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return gone;
}
function residentLost(runner: ResidentRunner, error: Error) {
  if (phase === "preparing") runner.markLost(error);
  if (phase === "preparing" || phase === "ready" || phase === "running") stop("host_failure");
}
function receiveResidentFrame(runner: ResidentRunner, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("JOB_HOST_RESIDENT_FRAME_INVALID");
  const frame = value as Record<string, unknown>;
  const keys = Object.keys(frame).sort().join(",");
  if (frame["type"] === "ready") {
    if (keys !== "type" || runner.readySeen || phase !== "preparing")
      throw new Error("JOB_HOST_RESIDENT_FRAME_INVALID");
    runner.readySeen = true;
    runner.markReady();
    return;
  }
  const command = active;
  if (
    !command ||
    phase !== "running" ||
    command.residentSequence === null ||
    command.exited ||
    frame["seq"] !== command.residentSequence
  )
    throw new Error("JOB_HOST_RESIDENT_FRAME_INVALID");
  if (frame["type"] === "output") {
    const channel = frame["channel"];
    const bytes = frame["bytes"];
    if (
      keys !== "bytes,channel,seq,type" ||
      (channel !== "stdout" && channel !== "stderr") ||
      typeof bytes !== "string" ||
      Buffer.from(bytes, "base64").toString("base64") !== bytes
    )
      throw new Error("JOB_HOST_RESIDENT_FRAME_INVALID");
    if (command.cause !== undefined) return;
    const decoded = Buffer.from(bytes, "base64");
    const accepted = decoded.subarray(
      0,
      Math.max(0, command.run.maxOutputBytes - command.forwardedBytes),
    );
    command.forwardedBytes += accepted.byteLength;
    if (accepted.byteLength)
      send({
        type: "output",
        attemptId: command.run.attemptId,
        channel,
        bytes: accepted.toString("base64"),
      });
    if (decoded.byteLength > accepted.byteLength) endCommand(command, "output_limit");
    return;
  }
  const exitCode = frame["exitCode"];
  if (
    frame["type"] !== "result" ||
    keys !== "exitCode,seq,type" ||
    typeof exitCode !== "number" ||
    !Number.isSafeInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 255
  )
    throw new Error("JOB_HOST_RESIDENT_FRAME_INVALID");
  command.exitCode = exitCode;
  command.exited = true;
  command.closed = true;
  void settleCommand(command);
}
function sessionEnding(): boolean {
  return phase === "stopping" || phase === "finished";
}
function receiveResidentBytes(runner: ResidentRunner, bytes: Buffer) {
  if (sessionEnding()) return;
  runner.pending = Buffer.concat([runner.pending, bytes]);
  try {
    const limit = residentFrameLimit();
    for (
      let newline = runner.pending.indexOf(10);
      newline >= 0;
      newline = runner.pending.indexOf(10)
    ) {
      const line = runner.pending.subarray(0, newline);
      runner.pending = runner.pending.subarray(newline + 1);
      if (line.byteLength > limit) throw new Error("JOB_HOST_RESIDENT_FRAME_INVALID");
      receiveResidentFrame(
        runner,
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)),
      );
      if (sessionEnding()) return;
    }
    if (runner.pending.byteLength > limit) throw new Error("JOB_HOST_RESIDENT_FRAME_INVALID");
  } catch {
    residentLost(runner, new Error("JOB_HOST_RESIDENT_FRAME_INVALID"));
  }
}
async function launchResident(manager: SandboxSdk, current: JobHostRequest) {
  let markReady!: () => void;
  let markLost!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    markLost = reject;
  });
  void ready.catch(() => {});
  let markClosed!: () => void;
  const closedSignal = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  await launchTask({
    manager,
    request: current,
    deadlineAt: current.deadlineAt,
    input: Buffer.alloc(0),
    keepInputOpen: true,
    maxOutputBytes: Number.MAX_SAFE_INTEGER,
    running: () => phase === "preparing",
    notLaunched: () => markLost(new Error("JOB_HOST_START_ABORTED")),
    spawned: (child) => {
      if (child.pid === undefined) return;
      resident = {
        child,
        group: child.pid,
        infrastructure: null,
        pending: Buffer.alloc(0),
        readySeen: false,
        exited: false,
        closed: false,
        sequence: 0,
        closedSignal,
        markClosed,
        markReady,
        markLost,
      };
    },
    exposed: () => {},
    namespace: (identity) => {
      linuxNamespace = identity;
    },
    started: () => {},
    output: (channel, bytes) => {
      if (channel === "stdout" && resident) receiveResidentBytes(resident, bytes);
    },
    outputLimit: () => {},
    failed: (failure) => {
      if (failure) sendLaunchFailureDiagnostic(failure, "start");
      markLost(new Error("JOB_HOST_START_ABORTED"));
      stop("host_failure");
    },
    spawnFailed: (failure) => {
      sendLaunchFailureDiagnostic(failure, "start");
      markLost(new Error("JOB_HOST_START_ABORTED"));
      stop("host_failure");
    },
    exited: () => {
      if (!resident) return;
      resident.exited = true;
      residentLost(resident, new Error("JOB_HOST_START_ABORTED"));
    },
    closed: () => {
      if (!resident) return;
      resident.closed = true;
      resident.markClosed();
      residentLost(resident, new Error("JOB_HOST_START_ABORTED"));
    },
  });
  await ready;
  const runner = resident;
  if (!runner || phase !== "preparing") return;
  runner.infrastructure = await captureResidentInfrastructure(runner.group);
}
function killCommand(command: SessionCommand) {
  const runner = resident;
  if (!runner || command.residentSequence === null || command.exited) return;
  void residentSweep(
    runner,
    request?.cleanupTimeoutMs ?? 1000,
    () => active === command && command.settlement === undefined,
  );
}
function endCommand(command: SessionCommand, cause: CommandCause) {
  if (active !== command || command.cause !== undefined || phase !== "running") return;
  command.cause = cause;
  killCommand(command);
  command.timers.push(
    setTimeout(() => {
      if (active === command && !command.exited) stop("host_failure");
    }, request?.cleanupTimeoutMs ?? 1000),
  );
}
function settleCommand(command: SessionCommand): Promise<void> {
  command.settlement ??= (async () => {
    for (const timer of command.timers) clearTimeout(timer);
    command.observer?.stop();
    const runner = resident;
    const sweep =
      runner && command.residentSequence !== null
        ? await residentSweep(runner, Math.min(1000, request?.cleanupTimeoutMs ?? 1000))
        : { commandTreeGone: command.residentSequence === null, infrastructureIntact: false };
    const intact = sweep.infrastructureIntact && runner !== undefined && !runner.exited;
    const commandReason: JobHostCommandReport["reason"] =
      command.cause ??
      (phase === "stopping" ? (reason as JobHostCommandReport["reason"]) : "exited");
    const report: JobHostCommandReport = {
      attemptId: command.run.attemptId,
      sequence: command.run.sequence,
      reason: commandReason,
      exitCode: commandReason === "exited" ? command.exitCode : null,
      resources: command.observer?.current() ?? null,
      taskStarted: command.started,
      taskProcessExited: command.exited,
      stdioClosed: command.closed,
      processGroupGone: sweep.commandTreeGone,
      namespace: intact ? "resident_intact" : "unknown",
      cleanedUp: sweep.commandTreeGone,
    };
    const { sequence: runSequence, ...fields } = report;
    send({ type: "command_result", ...fields, runSequence });
    reportedAttemptId = command.run.attemptId;
    if (active === command) active = undefined;
    commandGroupsGone &&= sweep.commandTreeGone;
    if (command.residentSequence !== null) {
      commandsExited &&= command.exited;
      commandsClosed &&= command.closed;
    }
    if (phase === "running") {
      if (jobHostCommandSettled(report)) phase = "ready";
      else stop("host_failure");
    } else if (phase === "stopping") void finish();
    if (phase === "ready" && pendingStop !== undefined) stop(pendingStop);
  })();
  return command.settlement;
}
async function runCommand(value: unknown) {
  const runner = resident;
  if (
    !sessionMode ||
    phase !== "ready" ||
    active ||
    !request ||
    !runner?.infrastructure ||
    runner.exited
  )
    throw new Error("JOB_HOST_RUN_NOT_ALLOWED");
  const run = parseJobHostRun(value, request, runSequence);
  runSequence = run.sequence;
  const command: SessionCommand = {
    run,
    residentSequence: null,
    started: false,
    exited: false,
    closed: false,
    exitCode: null,
    forwardedBytes: 0,
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
  let baseline: Awaited<ReturnType<typeof readProcessSnapshot>>;
  try {
    baseline = await readProcessSnapshot();
  } catch {
    stop("host_failure");
    return;
  }
  if (active !== command || phase !== "running" || command.cause !== undefined) {
    if (active === command && phase === "running") void settleCommand(command);
    return;
  }
  command.residentSequence = ++runner.sequence;
  spawnedCommands++;
  command.started = true;
  sessionTaskStarted = true;
  send({
    type: "started",
    attemptId: run.attemptId,
    pid: runner.group,
    taskIdentityRef: `sandbox-process:${randomUUID()}`,
    taskStartedAt: new Date().toISOString(),
  });
  command.observer = observeTaskResources(
    runner.group,
    run.resourceLimits,
    (cause) => {
      if (cause === "resource_limit") endCommand(command, cause);
      else stop("host_failure");
    },
    baseline,
  );
  runner.child.stdin?.write(
    `${JSON.stringify({ type: "run", seq: command.residentSequence, inputBase64: run.inputBase64 })}\n`,
  );
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
      receivedAt - Date.parse(message.observedAt) > (replied ? 1500 : JOB_HOST_STARTUP_WINDOW_MS)
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
