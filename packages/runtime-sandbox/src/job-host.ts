import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type JobHostRequest,
  type JobHostResult,
  parseJobHostRequest,
} from "./job-host-protocol.ts";

export interface SandboxJobHost {
  readonly ready: Promise<void>;
  readonly result: Promise<JobHostResult>;
  /** Caller must persist the unique start intent before sending this command. */
  start(): void;
  cancel(): void;
}

/** Trusted infrastructure only. Resolving ready never starts the task. Authority,
 * protected scope and qualification are owned by the Worker admission path. */
export function prepareSandboxJobHost(value: JobHostRequest): SandboxJobHost {
  const request = parseJobHostRequest(value);
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
    killGroup(taskPid);
    killGroup(child.pid);
  };
  const send = (message: { type: string; request?: JobHostRequest; reason?: string }) => {
    if (child.connected)
      child.send(message, (error) => {
        if (error) force();
      });
  };
  const cancel = (reason = "cancelled") => {
    if (cancelled || ended) return;
    cancelled = true;
    send({ type: "cancel", reason });
    forceTimer ??= setTimeout(force, request.cleanupTimeoutMs);
  };
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
      cancel();
      return;
    }
    const message = value as Record<string, unknown>;
    if (message["type"] === "ready") {
      if (
        prepared ||
        message["jobId"] !== request.jobId ||
        message["attemptId"] !== request.attemptId ||
        message["policyDigest"] !== request.policyDigest
      ) {
        cancel();
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
        cancel();
        return;
      }
      taskPid = message["pid"] as number;
    } else if (message["type"] === "output") {
      if (
        typeof message["bytes"] !== "string" ||
        !["stdout", "stderr"].includes(message["channel"] as string)
      ) {
        cancel();
        return;
      }
      const bytes = Buffer.from(message["bytes"], "base64");
      if (received + bytes.byteLength > request.maxOutputBytes) {
        cancel();
        return;
      }
      received += bytes.byteLength;
      (message["channel"] === "stdout" ? stdout : stderr).push(bytes);
    } else if (message["type"] === "result") {
      completion = message;
      forceTimer ??= setTimeout(force, request.cleanupTimeoutMs);
    } else cancel();
  });
  child.once("error", () => {
    rejectReady(new Error("JOB_HOST_START_FAILED"));
    force();
  });
  child.once("close", () => {
    ended = true;
    clearTimeout(timer);
    clearTimeout(preparationTimer);
    clearTimeout(forceTimer);
    killGroup(taskPid);
    killGroup(child.pid);
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
  send({ type: "prepare", request });
  return Object.freeze({
    ready,
    result,
    cancel: () => cancel(),
    start() {
      if (
        !prepared ||
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
