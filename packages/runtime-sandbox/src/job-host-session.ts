import { randomUUID } from "node:crypto";
import { type SandboxHostSteps, sandboxHostStepsSchema } from "@himawari-agent/execution-contracts";
import {
  authenticateJobHostEnvelope,
  decodeJobHostOutput,
  JOB_HOST_RESULT_REASONS,
  jobHostResultNetwork,
  jobHostResultResources,
  parseJobHostDiagnosticMessage,
  parseJobHostStartedTask,
  readJobHostOutputWindow,
} from "./job-host-messages.ts";
import {
  JOB_HOST_NAMESPACE_STATES,
  JOB_HOST_STARTUP_WINDOW_MS,
  type JobHostCommandOutcome,
  type JobHostCommandReport,
  type JobHostDiagnostic,
  type JobHostRequest,
  type JobHostResult,
  type JobHostRun,
  type JobHostSupervision,
  jobHostCommandSettled,
  parseJobHostRun,
  parseJobHostSessionRequest,
} from "./job-host-protocol.ts";
import { forkLocalJobHost, type JobHostLauncher } from "./job-host-transport.ts";

export type JobHostRunInput = Omit<JobHostRun, "sequence">;

export interface SandboxJobSessionRun {
  readonly started: Promise<NonNullable<JobHostSupervision["task"]>>;
  readonly result: Promise<JobHostCommandOutcome>;
  readOutput(
    offset: number,
    limit: number,
    channel?: "stdout",
  ): { bytes: Uint8Array; nextOffset: number; end: boolean };
  cancel(reason?: "cancelled" | "deadline"): void;
}

export class JobHostPreparationError extends Error {
  readonly diagnostic: JobHostDiagnostic | undefined;
  constructor(diagnostic: JobHostDiagnostic | undefined) {
    super("JOB_HOST_NOT_READY");
    this.name = "JobHostPreparationError";
    this.diagnostic = diagnostic;
  }
}

export interface SandboxJobSessionReady {
  readonly residentProcessId: number;
  readonly hostSteps: SandboxHostSteps | null;
}

export interface SandboxJobSession {
  readonly pid: number | undefined;
  readonly spawned: Promise<number | undefined>;
  readonly ready: Promise<SandboxJobSessionReady>;
  readonly result: Promise<JobHostResult>;
  run(input: JobHostRunInput, authorize: () => Promise<void>): SandboxJobSessionRun;
  inspect(): JobHostSupervision | null;
  close(): void;
}

interface ActiveCommand {
  readonly run: JobHostRun;
  readonly authorize: () => Promise<void>;
  readonly output: Buffer[];
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  received: number;
  task: NonNullable<JobHostSupervision["task"]> | null;
  outcome: JobHostCommandOutcome | null;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  overdueTimer?: ReturnType<typeof setTimeout>;
  resolveStarted(task: NonNullable<JobHostSupervision["task"]>): void;
  rejectStarted(error: Error): void;
  resolveResult(outcome: JobHostCommandOutcome): void;
}

const isFlag = (value: unknown): value is boolean => typeof value === "boolean";

export function prepareSandboxJobSession(
  value: JobHostRequest,
  launcher: JobHostLauncher = forkLocalJobHost,
): SandboxJobSession {
  const request = parseJobHostSessionRequest(value);
  const sessionId = randomUUID();
  const child = launcher(request);
  let diagnostic: JobHostDiagnostic | undefined;
  let supervision: JobHostSupervision | null = null;
  let lastMessageTick = performance.now();
  let starting = true;
  let ipcSequence = 0;
  let workerSequence = 0;
  let runSequence = 0;
  let authorityCheckId = 0;
  let authorityChecksPending = 0;
  let prepared = false;
  let cancelled = false;
  let ended = false;
  let childExited = false;
  let anyCommandStarted = false;
  let commandsSent = 0;
  let active: ActiveCommand | null = null;
  let completion: Record<string, unknown> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let residentProcessId: number | null = null;
  let hostSteps: SandboxHostSteps | null = null;
  let resolveReady!: (value: SandboxJobSessionReady) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<SandboxJobSessionReady>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  let resolveResult!: (result: JobHostResult) => void;
  const result = new Promise<JobHostResult>((resolve) => {
    resolveResult = resolve;
  });
  const force = () => {
    if (!childExited && !ended) child.killGroup();
  };
  child.onceExit(() => {
    childExited = true;
  });
  const send = (message: Record<string, unknown>) => {
    if (child.connected)
      child.send(
        {
          ...message,
          protocolVersion: "job-host.v2",
          sessionId,
          sequence: ++workerSequence,
          observedAt: new Date().toISOString(),
        },
        force,
      );
  };
  const cancel = (reason: "cancelled" | "deadline" | "host_failure") => {
    if (cancelled || ended) return;
    cancelled = true;
    send({ type: "cancel", reason });
    forceTimer ??= setTimeout(force, request.cleanupTimeoutMs);
  };
  const finishCommand = (
    command: ActiveCommand,
    report: JobHostCommandReport,
    trusted: boolean,
  ) => {
    if (command.outcome) return;
    clearTimeout(command.deadlineTimer);
    clearTimeout(command.overdueTimer);
    command.outcome = Object.freeze({
      ...report,
      settled: trusted && jobHostCommandSettled(report),
      stdout: Buffer.concat(command.stdout),
      stderr: Buffer.concat(command.stderr),
    });
    if (!command.task) command.rejectStarted(new Error("JOB_HOST_START_UNCONFIRMED"));
    command.resolveResult(command.outcome);
    if (active === command) active = null;
  };
  const abandonCommand = (reason: JobHostResult["reason"]) => {
    if (!active) return;
    finishCommand(
      active,
      {
        attemptId: active.run.attemptId,
        sequence: active.run.sequence,
        reason,
        exitCode: null,
        resources: null,
        taskStarted: active.task !== null,
        taskProcessExited: false,
        stdioClosed: false,
        processGroupGone: false,
        namespace: "unknown",
        namespaceSwept: false,
        cleanedUp: false,
      },
      false,
    );
  };
  const fail = () => {
    cancel("host_failure");
    abandonCommand("host_failure");
  };
  const requestCommandEnd = (command: ActiveCommand, reason: "cancelled" | "deadline") => {
    if (command.outcome || command.overdueTimer || cancelled || ended) return;
    send({ type: "run_cancel", attemptId: command.run.attemptId, reason });
    command.overdueTimer = setTimeout(
      () => {
        if (active === command) fail();
      },
      2 * request.cleanupTimeoutMs + 3000,
    );
  };
  const inspect = (): JobHostSupervision | null =>
    supervision
      ? {
          ...supervision,
          state: ended
            ? completion
              ? "exited"
              : "lost"
            : cancelled || !child.connected || performance.now() - lastMessageTick > 1500
              ? "lost"
              : "alive",
        }
      : null;
  const supervisionTimer = setInterval(() => {
    if (starting) return;
    if (!ended && performance.now() - lastMessageTick > 1500) fail();
    if (!ended && !cancelled) send({ type: "heartbeat" });
  }, 250);
  const deadlineRemainingMs = Date.parse(request.deadlineAt) - Date.now();
  const sessionTimer = setTimeout(() => cancel("deadline"), Math.max(1, deadlineRemainingMs));
  const preparationTimer =
    deadlineRemainingMs > 30000 ? setTimeout(() => cancel("host_failure"), 30000) : undefined;
  const startupTimer = setTimeout(
    fail,
    Math.min(JOB_HOST_STARTUP_WINDOW_MS, Math.max(1, deadlineRemainingMs)),
  );
  const receiveCommandResult = (message: Record<string, unknown>) => {
    const command = active;
    const resources = message["resources"];
    const exitCode = message["exitCode"];
    if (
      !command ||
      message["attemptId"] !== command.run.attemptId ||
      message["runSequence"] !== command.run.sequence ||
      !JOB_HOST_RESULT_REASONS.some((reason) => reason === message["reason"]) ||
      !(
        exitCode === null ||
        (Number.isSafeInteger(exitCode) && (exitCode as number) >= 0 && (exitCode as number) <= 255)
      ) ||
      (exitCode !== null && message["reason"] !== "exited") ||
      (resources !== null && jobHostResultResources(resources) === null) ||
      !isFlag(message["taskStarted"]) ||
      !isFlag(message["taskProcessExited"]) ||
      !isFlag(message["stdioClosed"]) ||
      !isFlag(message["processGroupGone"]) ||
      !isFlag(message["cleanedUp"]) ||
      !isFlag(message["namespaceSwept"]) ||
      (message["namespaceSwept"] && !message["processGroupGone"]) ||
      !JOB_HOST_NAMESPACE_STATES.some((state) => state === message["namespace"]) ||
      message["taskStarted"] !== (command.task !== null)
    ) {
      fail();
      return;
    }
    finishCommand(
      command,
      {
        attemptId: command.run.attemptId,
        sequence: command.run.sequence,
        reason: message["reason"] as JobHostResult["reason"],
        exitCode: exitCode as number | null,
        resources: jobHostResultResources(resources),
        taskStarted: message["taskStarted"],
        taskProcessExited: message["taskProcessExited"],
        stdioClosed: message["stdioClosed"],
        processGroupGone: message["processGroupGone"],
        namespace: message["namespace"] as JobHostCommandReport["namespace"],
        namespaceSwept: message["namespaceSwept"],
        cleanedUp: message["cleanedUp"],
      },
      true,
    );
  };
  const receiveAuthorityCheck = (message: Record<string, unknown>) => {
    const command = active;
    if (
      !command?.task ||
      command.outcome ||
      completion ||
      message["checkId"] !== authorityCheckId + 1 ||
      authorityChecksPending >= 128
    ) {
      fail();
      return;
    }
    const checkId = ++authorityCheckId;
    authorityChecksPending++;
    const permitted = () =>
      !cancelled && !ended && !command.outcome && Date.now() < Date.parse(command.run.deadlineAt);
    void (async () => {
      let allowed = false;
      try {
        if (!permitted()) throw new Error("stopped");
        await command.authorize();
        allowed = permitted();
      } catch {
      } finally {
        authorityChecksPending--;
      }
      if (!ended) send({ type: "authority_result", checkId, allowed });
      if (!allowed) cancel("cancelled");
    })();
  };
  child.onStderr(() => {});
  child.onMessage((value: unknown) => {
    if (!value || typeof value !== "object" || !("type" in value)) {
      fail();
      return;
    }
    const message = value as Record<string, unknown>;
    const authenticated = authenticateJobHostEnvelope(message, {
      sessionId,
      processId: child.pid,
      sequence: ipcSequence + 1,
      previous: supervision,
    });
    if (!authenticated) {
      fail();
      return;
    }
    ipcSequence++;
    lastMessageTick = performance.now();
    if (starting) {
      starting = false;
      clearTimeout(startupTimer);
    }
    supervision = authenticated;
    const type = message["type"];
    if (type === "heartbeat") {
      try {
        hostSteps = sandboxHostStepsSchema.parse(message["steps"]);
      } catch {
        fail();
      }
    } else if (type === "authority_check") receiveAuthorityCheck(message);
    else if (type === "diagnostic") {
      const parsed = parseJobHostDiagnosticMessage(message);
      if (parsed) diagnostic ??= parsed;
      else fail();
    } else if (type === "ready") {
      if (
        prepared ||
        message["jobId"] !== request.jobId ||
        message["attemptId"] !== request.attemptId ||
        message["policyDigest"] !== request.policyDigest ||
        typeof message["residentProcessId"] !== "number" ||
        !Number.isSafeInteger(message["residentProcessId"]) ||
        message["residentProcessId"] <= 1
      ) {
        fail();
        return;
      }
      prepared = true;
      residentProcessId = message["residentProcessId"];
      clearTimeout(preparationTimer);
      if (!cancelled) resolveReady({ residentProcessId, hostSteps });
    } else if (type === "started") {
      const task = parseJobHostStartedTask(message);
      const command = active;
      if (
        !command ||
        command.task ||
        command.outcome ||
        message["attemptId"] !== command.run.attemptId ||
        !task ||
        task.processId !== residentProcessId
      ) {
        fail();
        return;
      }
      command.task = task;
      anyCommandStarted = true;
      supervision = { ...supervision, task };
      command.resolveStarted({ ...task });
    } else if (type === "output") {
      const command = active;
      const decoded = decodeJobHostOutput(message);
      if (
        !command ||
        command.outcome ||
        message["attemptId"] !== command.run.attemptId ||
        !decoded ||
        command.received + decoded.bytes.byteLength > command.run.maxOutputBytes
      ) {
        fail();
        return;
      }
      command.received += decoded.bytes.byteLength;
      command.output.push(decoded.bytes);
      (decoded.channel === "stdout" ? command.stdout : command.stderr).push(decoded.bytes);
    } else if (type === "command_result") receiveCommandResult(message);
    else if (type === "result") {
      if (completion !== undefined) {
        fail();
        return;
      }
      completion = message;
      const reason = message["reason"];
      abandonCommand(
        JOB_HOST_RESULT_REASONS.some((item) => item === reason)
          ? (reason as JobHostResult["reason"])
          : "host_failure",
      );
      forceTimer ??= setTimeout(force, request.cleanupTimeoutMs);
    } else fail();
  });
  child.onceError(() => {
    rejectReady(new Error("JOB_HOST_START_FAILED"));
    force();
  });
  child.onceClose(() => {
    ended = true;
    clearInterval(supervisionTimer);
    clearTimeout(sessionTimer);
    clearTimeout(preparationTimer);
    clearTimeout(startupTimer);
    clearTimeout(forceTimer);
    rejectReady(new JobHostPreparationError(diagnostic));
    const completedReason = completion?.["reason"];
    const reason = JOB_HOST_RESULT_REASONS.some((item) => item === completedReason)
      ? (completedReason as JobHostResult["reason"])
      : "host_failure";
    abandonCommand(reason);
    const taskStarted =
      anyCommandStarted || completion?.["taskStarted"] === true
        ? true
        : completion?.["taskStarted"] === false || commandsSent === 0
          ? false
          : null;
    resolveResult({
      ...(diagnostic ? { diagnostic } : {}),
      network: jobHostResultNetwork(completion?.["network"]),
      jobId: request.jobId,
      attemptId: request.attemptId,
      supervision: inspect(),
      reason,
      resources: jobHostResultResources(completion?.["resources"]),
      exitCode: null,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      taskStarted,
      taskProcessExited: completion?.["taskProcessExited"] === true,
      stdioClosed: completion?.["stdioClosed"] === true,
      srtReset: completion?.["srtReset"] === true,
      taskTreeCleanup:
        taskStarted === false
          ? "not_started"
          : taskStarted === true && completion?.["taskProcessGroupGone"] === true
            ? "process_group_gone"
            : "unknown",
    });
  });
  send({ type: "prepare", request, session: true });
  return Object.freeze({
    get pid() {
      return child.pid;
    },
    spawned: child.spawned,
    ready,
    result,
    inspect,
    close: () => cancel("cancelled"),
    run(input: JobHostRunInput, authorize: () => Promise<void>): SandboxJobSessionRun {
      if (
        !prepared ||
        active ||
        cancelled ||
        ended ||
        completion ||
        inspect()?.state !== "alive" ||
        Date.now() >= Date.parse(request.deadlineAt)
      )
        throw new Error("JOB_HOST_RUN_NOT_ALLOWED");
      const run = parseJobHostRun({ ...input, sequence: runSequence + 1 }, request, runSequence);
      runSequence = run.sequence;
      let resolveStarted!: ActiveCommand["resolveStarted"];
      let rejectStarted!: ActiveCommand["rejectStarted"];
      const started = new Promise<NonNullable<JobHostSupervision["task"]>>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      void started.catch(() => {});
      let resolveOutcome!: ActiveCommand["resolveResult"];
      const outcome = new Promise<JobHostCommandOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      const command: ActiveCommand = {
        run,
        authorize,
        output: [],
        stdout: [],
        stderr: [],
        received: 0,
        task: null,
        outcome: null,
        resolveStarted,
        rejectStarted,
        resolveResult: resolveOutcome,
      };
      active = command;
      commandsSent++;
      command.deadlineTimer = setTimeout(
        () => requestCommandEnd(command, "deadline"),
        Math.max(1, Date.parse(run.deadlineAt) - Date.now()),
      );
      send({ type: "run", run });
      return Object.freeze({
        started,
        result: outcome,
        readOutput(offset: number, limit: number, channel?: "stdout") {
          const chunks = channel === "stdout" ? command.stdout : command.output;
          const length =
            channel === "stdout"
              ? command.stdout.reduce((total, chunk) => total + chunk.length, 0)
              : command.received;
          const bytes = readJobHostOutputWindow(chunks, length, offset, limit);
          return {
            bytes,
            nextOffset: offset + bytes.length,
            end: command.outcome !== null && offset + bytes.length === length,
          };
        },
        cancel: (reason: "cancelled" | "deadline" = "cancelled") =>
          requestCommandEnd(command, reason),
      });
    },
  });
}
