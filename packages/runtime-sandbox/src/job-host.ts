import { fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { JobHostControlBinding } from "./job-host-control.js";
import {
  type JobHostRequest,
  type JobHostResult,
  type JobHostSupervision,
  parseJobHostRequest,
} from "./job-host-protocol.ts";

export interface SandboxJobHost {
  readonly controlBinding?: JobHostControlBinding;
  readonly ready: Promise<void>;
  readonly result: Promise<JobHostResult>;
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
): SandboxJobHost {
  const request = parseJobHostRequest(value);
  const sessionId = randomUUID();
  const controlBinding =
    controlDirectory === undefined
      ? undefined
      : Object.freeze({
          directory: controlDirectory,
          token: randomBytes(32).toString("hex"),
          sessionId,
          jobId: request.jobId,
          attemptId: request.attemptId,
        });
  let supervision: JobHostSupervision | null = null;
  let lastMessageTick = performance.now();
  let ipcSequence = 0;
  let workerSequence = 0;
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const child = fork(fileURLToPath(new URL(`./job-host-main.${extension}`, import.meta.url)), [], {
    cwd: request.policy.workspace,
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
  let resolveResult!: (result: JobHostResult) => void;
  const result = new Promise<JobHostResult>((resolve) => {
    resolveResult = resolve;
  });
  let prepared = false;
  let started = false;
  let cancelled = false;
  let ended = false;
  let childExited = false;
  let taskPid: number | undefined;
  let received = 0;
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
  const supervisionTimer = setInterval(() => {
    if (!ended && performance.now() - lastMessageTick > 1500) cancel("host_failure");
    if (!ended && !cancelled) send({ type: "heartbeat" });
  }, 250);
  const timer = setTimeout(
    () => cancel("deadline"),
    Math.max(1, Date.parse(request.deadlineAt) - Date.now()),
  );
  const preparationTimer = setTimeout(
    () => cancel("host_failure"),
    Math.min(30000, Math.max(1, Date.parse(request.deadlineAt) - Date.now())),
  );
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
    } else if (message["type"] === "output") {
      if (
        !started ||
        completion !== undefined ||
        typeof message["bytes"] !== "string" ||
        message["bytes"].length > 131072 ||
        !["stdout", "stderr"].includes(message["channel"] as string)
      ) {
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
      (message["channel"] === "stdout" ? stdout : stderr).push(bytes);
    } else if (message["type"] === "result") {
      if (completion !== undefined) {
        cancel("host_failure");
        return;
      }
      completion = message;
      forceTimer ??= setTimeout(force, request.cleanupTimeoutMs);
    } else cancel("host_failure");
  });
  child.once("error", () => {
    rejectReady(new Error("JOB_HOST_START_FAILED"));
    force();
  });
  child.once("close", () => {
    ended = true;
    clearInterval(supervisionTimer);
    clearTimeout(timer);
    clearTimeout(preparationTimer);
    clearTimeout(forceTimer);
    rejectReady(new Error("JOB_HOST_NOT_READY"));
    const reason = completion?.["reason"];
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
      jobId: request.jobId,
      attemptId: request.attemptId,
      supervision: inspect(),
      reason: validReason ? (reason as JobHostResult["reason"]) : "host_failure",
      resources,
      exitCode: typeof completion?.["exitCode"] === "number" ? completion["exitCode"] : null,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      taskStarted,
      taskProcessExited: completion?.["taskProcessExited"] === true,
      stdioClosed: completion?.["stdioClosed"] === true,
      srtReset: completion?.["srtReset"] === true,
      taskTreeCleanup: taskStarted === false ? "not_started" : "unknown",
    });
  });
  send({ type: "prepare", request, ...(controlBinding ? { control: controlBinding } : {}) });
  return Object.freeze({
    ...(controlBinding ? { controlBinding } : {}),
    ready,
    result,
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
