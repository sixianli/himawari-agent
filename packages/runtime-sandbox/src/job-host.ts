import { fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type SandboxTaskTermination,
  sandboxHostFailureDetailSchema,
} from "@himawari-agent/execution-contracts";
import type { JobHostControlBinding } from "./job-host-control.js";
import {
  JOB_HOST_FAILURE_STAGES,
  JOB_HOST_SYSTEM_CODES,
  type JobHostDiagnostic,
  type JobHostRequest,
  type JobHostResult,
  type JobHostSupervision,
  parseJobHostRequest,
} from "./job-host-protocol.ts";

export interface SandboxJobHost {
  readonly controlBinding?: JobHostControlBinding;
  readonly ready: Promise<void>;
  /** Resolves only after the authenticated child reports the actual task identity. */
  readonly started: Promise<NonNullable<JobHostSupervision["task"]>>;
  readonly result: Promise<JobHostResult>;
  readonly completed: Promise<SandboxTaskTermination | null>;
  /** Bounded merged stdout/stderr in authenticated arrival order. Reading never starts work. */
  readOutput(
    offset: number,
    limit: number,
    channel?: "stdout",
  ): {
    bytes: Uint8Array;
    nextOffset: number;
    end: boolean;
  };
  /** Observation only; an expired or replaced session never grants control. */
  inspect(): JobHostSupervision | null;
  /** Limited stop of this owned fork only; never adopts a PID from a receipt. */
  stop(expected: Pick<JobHostSupervision, "sessionId" | "bootId" | "processIdentityRef">): void;
  /** Caller must persist the unique start intent before sending this command. */
  start(): void;
  cancel(): void;
}

/** Trusted infrastructure only. Resolving ready never starts the task. Authority,
 * protected scope and qualification are owned by the Worker admission path. */
export function prepareSandboxJobHost(
  value: JobHostRequest,
  controlDirectory?: string,
  assertNetworkAuthority?: () => Promise<void>,
  preparedControl?: JobHostControlBinding,
): SandboxJobHost {
  const request = parseJobHostRequest(value);
  if (request.policy.allowedDomains.length && !assertNetworkAuthority)
    throw new Error("JOB_HOST_NETWORK_AUTHORITY_REQUIRED");
  const sessionId = preparedControl?.sessionId ?? randomUUID();
  const controlBinding =
    controlDirectory === undefined
      ? undefined
      : preparedControl
        ? Object.freeze({ ...preparedControl })
        : Object.freeze({
            directory: controlDirectory,
            token: randomBytes(32).toString("hex"),
            sessionId,
            jobId: request.jobId,
            attemptId: request.attemptId,
          });
  if (
    preparedControl &&
    (preparedControl.directory !== controlDirectory ||
      preparedControl.jobId !== request.jobId ||
      preparedControl.attemptId !== request.attemptId ||
      !/^[a-f0-9]{64}$/.test(preparedControl.token) ||
      !/^[a-f0-9-]{36}$/.test(preparedControl.sessionId))
  )
    throw new Error("JOB_HOST_CONTROL_BINDING_INVALID");
  const diagnosticStarted = performance.now();
  let diagnostic: JobHostDiagnostic | undefined;
  let supervision: JobHostSupervision | null = null;
  let lastMessageTick = performance.now();
  let ipcSequence = 0;
  let authorityCheckId = 0;
  let authorityChecksPending = 0;
  let workerSequence = 0;
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const child = fork(fileURLToPath(new URL(`./job-host-main.${extension}`, import.meta.url)), [], {
    cwd: request.policy.workspace ?? request.policy.privateDirectory,
    execArgv: [],
    detached: true,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
      HOME: request.policy.privateDirectory,
      TMPDIR: request.policy.privateDirectory,
      CLAUDE_CODE_TMPDIR: request.policy.privateDirectory,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {}); // Result-only consumers still receive the failure.
  let resolveStarted!: (task: NonNullable<JobHostSupervision["task"]>) => void;
  let rejectStarted!: (error: Error) => void;
  const taskStarted = new Promise<NonNullable<JobHostSupervision["task"]>>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  void taskStarted.catch(() => {});
  let resolveResult!: (result: JobHostResult) => void;
  const result = new Promise<JobHostResult>((resolve) => {
    resolveResult = resolve;
  });
  let resolveCompleted!: (value: SandboxTaskTermination | null) => void;
  const completed = new Promise<SandboxTaskTermination | null>((resolve) => {
    resolveCompleted = resolve;
  });
  let taskCompletion: SandboxTaskTermination | null = null;
  let completionContradicted = false;
  let prepared = false;
  let started = false;
  let cancelled = false;
  let ended = false;
  let childExited = false;
  let taskPid: number | undefined;
  let received = 0;
  const output: Buffer[] = [];
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let completion: Record<string, unknown> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const killGroup = (pid: number | undefined) => {
    if (pid)
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* Exit is checked separately. */
      }
  };
  const force = () => {
    // Only the unreaped owned fork may be signalled. A task PID received over
    // IPC is not a durable OS identity and must not be adopted after host loss.
    if (!childExited && !ended) killGroup(child.pid);
  };
  child.once("exit", () => {
    childExited = true;
  });
  const send = (message: {
    type: string;
    request?: JobHostRequest;
    reason?: string;
    control?: JobHostControlBinding;
    checkId?: number;
    allowed?: boolean;
  }) => {
    if (child.connected)
      child.send(
        {
          ...message,
          protocolVersion: "job-host.v2",
          sessionId,
          sequence: ++workerSequence,
          observedAt: new Date().toISOString(),
        },
        (error) => {
          if (error) force();
        },
      );
  };
  const cancel = (reason = "cancelled") => {
    if (cancelled || ended) return;
    cancelled = true;
    send({ type: "cancel", reason });
    forceTimer ??= setTimeout(force, request.cleanupTimeoutMs);
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
  const recordTimeout = (
    code:
      | "JOB_HOST_HEARTBEAT_EXPIRED"
      | "JOB_HOST_PREPARATION_TIMEOUT"
      | "JOB_HOST_EXECUTION_DEADLINE",
  ) => {
    if (cancelled || ended) return;
    const bounded = (value: number) =>
      Math.max(-86_400_000, Math.min(86_400_000, Math.round(value)));
    diagnostic ??= {
      stage: prepared ? "launch" : "request",
      systemCode: "UNKNOWN",
      detail: sandboxHostFailureDetailSchema.parse({
        code,
        command: "heartbeat",
        phase: started ? "running" : prepared ? "ready" : "preparing",
        elapsedMs: Math.max(0, bounded(performance.now() - diagnosticStarted)),
        messageAgeMs: bounded(performance.now() - lastMessageTick),
        deadlineRemainingMs: bounded(Date.parse(request.deadlineAt) - Date.now()),
        expectedSequence: ipcSequence + 1,
        receivedSequence: null,
      }),
    };
  };
  const supervisionTimer = setInterval(() => {
    if (!ended && performance.now() - lastMessageTick > 1500) {
      recordTimeout("JOB_HOST_HEARTBEAT_EXPIRED");
      cancel("host_failure");
    }
    if (!ended && !cancelled) send({ type: "heartbeat" });
  }, 250);
  const deadlineRemainingMs = Date.parse(request.deadlineAt) - Date.now();
  const timer = setTimeout(
    () => {
      recordTimeout("JOB_HOST_EXECUTION_DEADLINE");
      cancel("deadline");
    },
    Math.max(1, deadlineRemainingMs),
  );
  const preparationTimer =
    deadlineRemainingMs > 30000
      ? setTimeout(() => {
          recordTimeout("JOB_HOST_PREPARATION_TIMEOUT");
          cancel("host_failure");
        }, 30000)
      : undefined;
  // Job Host diagnostics are never propagated into user tool output.
  child.stderr?.on("data", () => {});
  child.on("message", (value: unknown) => {
    if (!value || typeof value !== "object" || !("type" in value)) {
      cancel("host_failure");
      return;
    }
    const message = value as Record<string, unknown>;
    if (
      message["protocolVersion"] !== "job-host.v2" ||
      message["sessionId"] !== sessionId ||
      message["processId"] !== child.pid ||
      typeof message["bootId"] !== "string" ||
      !/^[0-9a-f-]{36}$/.test(message["bootId"]) ||
      typeof message["processIdentityRef"] !== "string" ||
      !/^job-host-process:[0-9a-f-]{36}$/.test(message["processIdentityRef"]) ||
      typeof message["processStartedAt"] !== "string" ||
      !Number.isFinite(Date.parse(message["processStartedAt"])) ||
      typeof message["observedAt"] !== "string" ||
      !Number.isFinite(Date.parse(message["observedAt"])) ||
      Date.parse(message["observedAt"]) > Date.now() ||
      Date.now() - Date.parse(message["observedAt"]) > 1500 ||
      message["sequence"] !== ipcSequence + 1 ||
      (supervision &&
        (message["bootId"] !== supervision.bootId ||
          message["processIdentityRef"] !== supervision.processIdentityRef ||
          message["processStartedAt"] !== supervision.processStartedAt))
    ) {
      cancel("host_failure");
      return;
    }
    ipcSequence++;
    lastMessageTick = performance.now();
    supervision = {
      protocolVersion: "job-host.v2",
      sessionId,
      bootId: message["bootId"],
      processId: child.pid as number,
      processIdentityRef: message["processIdentityRef"],
      processStartedAt: message["processStartedAt"],
      sequence: ipcSequence,
      observedAt: message["observedAt"],
      validUntil: new Date(Date.parse(message["observedAt"]) + 1500).toISOString(),
      state: "alive",
      task: supervision?.task ?? null,
      taskTreeGuarantee: "unverified",
    };
    if (message["type"] === "heartbeat") return;
    if (message["type"] === "authority_check") {
      if (
        !started ||
        completion ||
        message["checkId"] !== authorityCheckId + 1 ||
        authorityChecksPending >= 128 ||
        !assertNetworkAuthority
      ) {
        cancel("host_failure");
        return;
      }
      const checkId = ++authorityCheckId;
      authorityChecksPending++;
      void (async () => {
        let allowed = false;
        try {
          if (cancelled || ended || Date.now() >= Date.parse(request.deadlineAt))
            throw new Error("stopped");
          await assertNetworkAuthority();
          allowed = !cancelled && !ended && Date.now() < Date.parse(request.deadlineAt);
        } catch {
          /* A missing answer or unavailable authority is denial. */
        } finally {
          authorityChecksPending--;
        }
        if (!ended) send({ type: "authority_result", checkId, allowed });
        if (!allowed) cancel("cancelled");
      })();
      return;
    }
    if (message["type"] === "diagnostic") {
      if (
        !JOB_HOST_FAILURE_STAGES.some((stage) => stage === message["stage"]) ||
        !JOB_HOST_SYSTEM_CODES.some((code) => code === message["systemCode"])
      ) {
        cancel("host_failure");
        return;
      }
      let detail: JobHostDiagnostic["detail"];
      try {
        if (message["detail"] !== undefined)
          detail = sandboxHostFailureDetailSchema.parse(message["detail"]);
      } catch {
        cancel("host_failure");
        return;
      }
      diagnostic ??= {
        ...(detail ? { detail } : {}),
        stage: message["stage"] as JobHostDiagnostic["stage"],
        systemCode: message["systemCode"] as JobHostDiagnostic["systemCode"],
      };
      return;
    }
    if (message["type"] === "ready") {
      if (
        prepared ||
        message["jobId"] !== request.jobId ||
        message["attemptId"] !== request.attemptId ||
        message["policyDigest"] !== request.policyDigest
      ) {
        cancel("host_failure");
        return;
      }
      prepared = true;
      clearTimeout(preparationTimer);
      if (!cancelled) resolveReady();
    } else if (message["type"] === "started") {
      if (
        !started ||
        taskPid !== undefined ||
        !Number.isSafeInteger(message["pid"]) ||
        (message["pid"] as number) <= 1
      ) {
        cancel("host_failure");
        return;
      }
      if (
        typeof message["taskIdentityRef"] !== "string" ||
        !/^sandbox-process:[0-9a-f-]{36}$/.test(message["taskIdentityRef"]) ||
        typeof message["taskStartedAt"] !== "string" ||
        !Number.isFinite(Date.parse(message["taskStartedAt"]))
      ) {
        cancel("host_failure");
        return;
      }
      taskPid = message["pid"] as number;
      supervision = {
        ...supervision,
        task: {
          processId: taskPid,
          processIdentityRef: message["taskIdentityRef"],
          startedAt: message["taskStartedAt"],
        },
      };
      if (!cancelled && supervision.task) resolveStarted({ ...supervision.task });
    } else if (message["type"] === "output") {
      if (
        !started ||
        taskCompletion !== null ||
        completion !== undefined ||
        typeof message["bytes"] !== "string" ||
        message["bytes"].length > 131072 ||
        !["stdout", "stderr"].includes(message["channel"] as string)
      ) {
        if (taskCompletion) completionContradicted = true;
        cancel("host_failure");
        return;
      }
      const bytes = Buffer.from(message["bytes"], "base64");
      if (
        bytes.toString("base64") !== message["bytes"] ||
        received + bytes.byteLength > request.maxOutputBytes
      ) {
        cancel("host_failure");
        return;
      }
      received += bytes.byteLength;
      output.push(bytes);
      (message["channel"] === "stdout" ? stdout : stderr).push(bytes);
    } else if (message["type"] === "completed") {
      if (
        !started ||
        taskPid === undefined ||
        taskCompletion ||
        completion ||
        message["reason"] !== "exited" ||
        message["taskProcessExited"] !== true ||
        message["stdioClosed"] !== true ||
        !Number.isSafeInteger(message["exitCode"]) ||
        (message["exitCode"] as number) < 0 ||
        (message["exitCode"] as number) > 255
      ) {
        completionContradicted = true;
        cancel("host_failure");
        return;
      }
      taskCompletion = {
        exitCode: message["exitCode"] as number,
        reasonCode: "exited",
        taskProcessExited: true,
      };
      resolveCompleted({ ...taskCompletion });
    } else if (message["type"] === "result") {
      if (completion !== undefined) {
        cancel("host_failure");
        return;
      }
      completion = message;
      if (
        taskCompletion &&
        (message["exitCode"] !== taskCompletion.exitCode ||
          message["taskProcessExited"] !== true ||
          message["stdioClosed"] !== true ||
          message["taskStarted"] !== true ||
          message["reason"] !== taskCompletion.reasonCode)
      )
        completionContradicted = true;
      forceTimer ??= setTimeout(force, request.cleanupTimeoutMs);
    } else cancel("host_failure");
  });
  child.once("error", () => {
    rejectReady(new Error("JOB_HOST_START_FAILED"));
    force();
  });
  child.once("close", () => {
    ended = true;
    resolveCompleted(null);
    clearInterval(supervisionTimer);
    clearTimeout(timer);
    clearTimeout(preparationTimer);
    clearTimeout(forceTimer);
    rejectReady(new Error("JOB_HOST_NOT_READY"));
    rejectStarted(new Error("JOB_HOST_START_UNCONFIRMED"));
    const reason = completionContradicted ? "host_failure" : completion?.["reason"];
    const validReason = [
      "exited",
      "cancelled",
      "deadline",
      "output_limit",
      "resource_limit",
      "host_failure",
    ].includes(reason as string);
    const resourceValue = completion?.["resources"];
    const resources =
      resourceValue &&
      typeof resourceValue === "object" &&
      ["samples", "observedCpuTimeMs", "peakObservedMemoryBytes"].every((key) => {
        const value = (resourceValue as Record<string, unknown>)[key];
        return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
      })
        ? (resourceValue as NonNullable<JobHostResult["resources"]>)
        : null;
    const taskStarted =
      taskPid !== undefined || completion?.["taskStarted"] === true
        ? true
        : completion?.["taskStarted"] === false || !started
          ? false
          : null;
    resolveResult({
      ...(diagnostic ? { diagnostic } : {}),
      network: (() => {
        const value = completion?.["network"];
        if (!value || typeof value !== "object") return null;
        const record = value as Record<string, unknown>;
        if (
          typeof record["closed"] !== "boolean" ||
          !["deniedTargets", "deniedAddresses", "connected"].every(
            (key) =>
              typeof record[key] === "number" &&
              Number.isSafeInteger(record[key]) &&
              (record[key] as number) >= 0,
          )
        )
          return null;
        return record as NonNullable<JobHostResult["network"]>;
      })(),
      jobId: request.jobId,
      attemptId: request.attemptId,
      supervision: inspect(),
      reason: validReason ? (reason as JobHostResult["reason"]) : "host_failure",
      resources,
      exitCode:
        !completionContradicted && typeof completion?.["exitCode"] === "number"
          ? completion["exitCode"]
          : null,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
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
  send({ type: "prepare", request, ...(controlBinding ? { control: controlBinding } : {}) });
  return Object.freeze({
    ...(controlBinding ? { controlBinding } : {}),
    ready,
    started: taskStarted,
    result,
    completed,
    readOutput(offset: number, limit: number, channel?: "stdout") {
      const chunks = channel === "stdout" ? stdout : output;
      const length =
        channel === "stdout" ? stdout.reduce((total, chunk) => total + chunk.length, 0) : received;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > length ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1_048_576
      )
        throw new Error("JOB_HOST_OUTPUT_CURSOR_INVALID");
      const bytes = Buffer.alloc(Math.min(limit, length - offset));
      let position = 0;
      let copied = 0;
      for (const chunk of chunks) {
        const from = Math.max(0, offset - position);
        if (from < chunk.length && copied < bytes.length)
          copied += chunk.copy(bytes, copied, from, from + bytes.length - copied);
        position += chunk.length;
        if (copied === bytes.length) break;
      }
      return {
        bytes,
        nextOffset: offset + bytes.length,
        end: (ended || taskCompletion !== null) && offset + bytes.length === length,
      };
    },
    inspect,
    stop(expected: Pick<JobHostSupervision, "sessionId" | "bootId" | "processIdentityRef">) {
      if (
        !supervision ||
        expected.sessionId !== sessionId ||
        expected.bootId !== supervision.bootId ||
        expected.processIdentityRef !== supervision.processIdentityRef
      )
        throw new Error("JOB_HOST_IDENTITY_CHANGED");
      cancel();
    },
    cancel: () => cancel(),
    start() {
      if (
        !prepared ||
        inspect()?.state !== "alive" ||
        started ||
        cancelled ||
        ended ||
        Date.now() >= Date.parse(request.deadlineAt)
      )
        throw new Error("JOB_HOST_START_NOT_ALLOWED");
      started = true;
      send({ type: "start" });
    },
  });
}
