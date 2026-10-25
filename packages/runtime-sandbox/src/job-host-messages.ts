import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxHostFailureDetailSchema } from "@himawari-agent/execution-contracts";
import {
  JOB_HOST_FAILURE_STAGES,
  JOB_HOST_SYSTEM_CODES,
  type JobHostDiagnostic,
  type JobHostRequest,
  type JobHostResult,
  type JobHostSupervision,
} from "./job-host-protocol.ts";

export const JOB_HOST_RESULT_REASONS = [
  "exited",
  "cancelled",
  "deadline",
  "output_limit",
  "resource_limit",
  "host_failure",
] as const;

export function forkJobHost(request: JobHostRequest): ChildProcess {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return fork(fileURLToPath(new URL(`./job-host-main.${extension}`, import.meta.url)), [], {
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
}

export function authenticateJobHostEnvelope(
  message: Record<string, unknown>,
  expected: {
    readonly sessionId: string;
    readonly processId: number | undefined;
    readonly sequence: number;
    readonly previous: JobHostSupervision | null;
  },
): JobHostSupervision | null {
  const { previous } = expected;
  if (
    message["protocolVersion"] !== "job-host.v2" ||
    message["sessionId"] !== expected.sessionId ||
    message["processId"] !== expected.processId ||
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
    message["sequence"] !== expected.sequence ||
    (previous &&
      (message["bootId"] !== previous.bootId ||
        message["processIdentityRef"] !== previous.processIdentityRef ||
        message["processStartedAt"] !== previous.processStartedAt))
  )
    return null;
  return {
    protocolVersion: "job-host.v2",
    sessionId: expected.sessionId,
    bootId: message["bootId"],
    processId: expected.processId as number,
    processIdentityRef: message["processIdentityRef"],
    processStartedAt: message["processStartedAt"],
    sequence: expected.sequence,
    observedAt: message["observedAt"],
    validUntil: new Date(Date.parse(message["observedAt"]) + 1500).toISOString(),
    state: "alive",
    task: previous?.task ?? null,
    taskTreeGuarantee: "unverified",
  };
}

export function parseJobHostDiagnosticMessage(
  message: Record<string, unknown>,
): JobHostDiagnostic | null {
  if (
    !JOB_HOST_FAILURE_STAGES.some((stage) => stage === message["stage"]) ||
    !JOB_HOST_SYSTEM_CODES.some((code) => code === message["systemCode"])
  )
    return null;
  let detail: JobHostDiagnostic["detail"];
  try {
    if (message["detail"] !== undefined)
      detail = sandboxHostFailureDetailSchema.parse(message["detail"]);
  } catch {
    return null;
  }
  return {
    ...(detail ? { detail } : {}),
    stage: message["stage"] as JobHostDiagnostic["stage"],
    systemCode: message["systemCode"] as JobHostDiagnostic["systemCode"],
  };
}

export function parseJobHostStartedTask(
  message: Record<string, unknown>,
): NonNullable<JobHostSupervision["task"]> | null {
  if (
    !Number.isSafeInteger(message["pid"]) ||
    (message["pid"] as number) <= 1 ||
    typeof message["taskIdentityRef"] !== "string" ||
    !/^sandbox-process:[0-9a-f-]{36}$/.test(message["taskIdentityRef"]) ||
    typeof message["taskStartedAt"] !== "string" ||
    !Number.isFinite(Date.parse(message["taskStartedAt"]))
  )
    return null;
  return {
    processId: message["pid"] as number,
    processIdentityRef: message["taskIdentityRef"],
    startedAt: message["taskStartedAt"],
  };
}

export function decodeJobHostOutput(
  message: Record<string, unknown>,
): { readonly channel: "stdout" | "stderr"; readonly bytes: Buffer } | null {
  if (
    typeof message["bytes"] !== "string" ||
    message["bytes"].length > 131072 ||
    (message["channel"] !== "stdout" && message["channel"] !== "stderr")
  )
    return null;
  const bytes = Buffer.from(message["bytes"], "base64");
  if (bytes.toString("base64") !== message["bytes"]) return null;
  return { channel: message["channel"], bytes };
}

export function readJobHostOutputWindow(
  chunks: readonly Buffer[],
  length: number,
  offset: number,
  limit: number,
): Buffer {
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
  return bytes;
}

export function jobHostResultResources(value: unknown): JobHostResult["resources"] {
  return value &&
    typeof value === "object" &&
    ["samples", "observedCpuTimeMs", "peakObservedMemoryBytes"].every((key) => {
      const item = (value as Record<string, unknown>)[key];
      return typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
    })
    ? (value as NonNullable<JobHostResult["resources"]>)
    : null;
}

export function jobHostResultNetwork(value: unknown): NonNullable<JobHostResult["network"]> | null {
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
}
