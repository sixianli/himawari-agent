import path from "node:path";
import type { SandboxPolicyInput } from "./policy.ts";
import type { ResourceLimits, ResourceObservation } from "./resource-observer.ts";

/** Infrastructure probe input; product inventory/Grant parsing stays outside this package. */
export interface JobHostReadinessProbe {
  readonly kind: "unix_http";
  readonly ref: string;
  readonly socketName: string;
  readonly path: string;
  readonly expectedStatus: number;
  readonly timeoutMs: number;
}
function parseReadiness(value: unknown): JobHostReadinessProbe {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("JOB_HOST_READINESS_INVALID");
  const probe = value as JobHostReadinessProbe;
  if (
    Object.keys(probe).length !== 6 ||
    probe.kind !== "unix_http" ||
    typeof probe.ref !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(probe.ref) ||
    typeof probe.socketName !== "string" ||
    !/^[a-z][a-z0-9-]{0,20}\.sock$/.test(probe.socketName) ||
    typeof probe.path !== "string" ||
    !/^\/[a-zA-Z0-9/_-]{0,127}$/.test(probe.path) ||
    !Number.isSafeInteger(probe.expectedStatus) ||
    probe.expectedStatus < 200 ||
    probe.expectedStatus > 299 ||
    !Number.isSafeInteger(probe.timeoutMs) ||
    probe.timeoutMs < 100 ||
    probe.timeoutMs > 30000
  )
    throw new Error("JOB_HOST_READINESS_INVALID");
  return probe;
}

/** Trusted Worker-to-Job-Host IPC; not a model tool or authority grant. */
export interface JobHostRequest {
  readonly jobId: string;
  readonly attemptId: string;
  readonly policy: SandboxPolicyInput;
  readonly policyDigest: string;
  readonly executable: string;
  readonly args: readonly string[];
  /** Authorized task bytes only, bounded and encoded for private Job Host IPC. */
  readonly stdinBase64?: string;
  readonly resourceLimits?: ResourceLimits;
  readonly readiness?: JobHostReadinessProbe;
  readonly deadlineAt: string;
  readonly maxOutputBytes: number;
  readonly cleanupTimeoutMs: number;
}

export function parseJobHostRequest(value: unknown): JobHostRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("JOB_HOST_INPUT_INVALID");
  const input = value as Record<string, unknown>;
  const keys = [
    "jobId",
    "attemptId",
    "policy",
    "policyDigest",
    "executable",
    "args",
    "deadlineAt",
    "maxOutputBytes",
    "cleanupTimeoutMs",
  ];
  if (
    keys.some((key) => !(key in input)) ||
    Object.keys(input).some(
      (key) =>
        !keys.includes(key) &&
        key !== "stdinBase64" &&
        key !== "resourceLimits" &&
        key !== "readiness",
    )
  )
    throw new Error("JOB_HOST_INPUT_INVALID");
  for (const key of ["jobId", "attemptId"])
    if (typeof input[key] !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(input[key]))
      throw new Error("JOB_HOST_ID_INVALID");
  if (typeof input["policyDigest"] !== "string" || !/^[a-f0-9]{64}$/.test(input["policyDigest"]))
    throw new Error("JOB_HOST_DIGEST_INVALID");
  if (
    typeof input["executable"] !== "string" ||
    !path.isAbsolute(input["executable"]) ||
    [...input["executable"]].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("JOB_HOST_EXECUTABLE_INVALID");
  if (
    !Array.isArray(input["args"]) ||
    input["args"].some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
    throw new Error("JOB_HOST_ARGS_INVALID");
  const stdin = input["stdinBase64"];
  if (
    "stdinBase64" in input &&
    (typeof stdin !== "string" ||
      stdin.length > 65536 ||
      Buffer.from(stdin, "base64").toString("base64") !== stdin ||
      Buffer.from(stdin, "base64").byteLength > 49152)
  )
    throw new Error("JOB_HOST_STDIN_INVALID");
  if ("resourceLimits" in input) {
    const limits = input["resourceLimits"];
    if (
      !limits ||
      typeof limits !== "object" ||
      Array.isArray(limits) ||
      Object.keys(limits).length !== 2 ||
      !["maxCpuTimeMs", "maxMemoryBytes"].every((key) => {
        const value = (limits as Record<string, unknown>)[key];
        return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
      })
    )
      throw new Error("JOB_HOST_RESOURCE_LIMIT_INVALID");
  }
  const policy = input["policy"];
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    !("workspace" in policy) ||
    typeof policy.workspace !== "string" ||
    !path.isAbsolute(policy.workspace) ||
    !("privateDirectory" in policy) ||
    typeof policy.privateDirectory !== "string" ||
    !path.isAbsolute(policy.privateDirectory)
  )
    throw new Error("JOB_HOST_POLICY_INVALID");
  if ("readiness" in input) {
    const readiness = parseReadiness(input["readiness"]);
    const sockets = (policy as unknown as SandboxPolicyInput).allowedUnixSockets;
    if (
      sockets?.length !== 1 ||
      sockets[0] !== path.join(policy.privateDirectory, readiness.socketName)
    )
      throw new Error("JOB_HOST_READINESS_SCOPE_INVALID");
  }
  const deadline = input["deadlineAt"];
  if (
    typeof deadline !== "string" ||
    !Number.isFinite(Date.parse(deadline)) ||
    new Date(deadline).toISOString() !== deadline ||
    Date.parse(deadline) <= Date.now() ||
    Date.parse(deadline) > Date.now() + 3600000
  )
    throw new Error("JOB_HOST_DEADLINE_INVALID");
  for (const [key, max] of [
    ["maxOutputBytes", 16777216],
    ["cleanupTimeoutMs", 30000],
  ] as const)
    if (
      !Number.isSafeInteger(input[key]) ||
      (input[key] as number) < 1 ||
      (input[key] as number) > max
    )
      throw new Error("JOB_HOST_LIMIT_INVALID");
  if (Buffer.byteLength(JSON.stringify(value)) > 131072)
    throw new Error("JOB_HOST_INPUT_TOO_LARGE");
  return structuredClone(value) as JobHostRequest;
}

/** Quote argv elements without granting shell interpretation to their contents. */
export function quoteJobArgument(argument: string): string {
  if (argument.includes("\0")) throw new Error("JOB_HOST_ARGS_INVALID");
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

export interface JobHostResult {
  readonly supervision?: JobHostSupervision | null;
  readonly jobId: string;
  readonly attemptId: string;
  readonly reason:
    | "exited"
    | "cancelled"
    | "deadline"
    | "output_limit"
    | "resource_limit"
    | "host_failure";
  readonly resources: ResourceObservation | null;
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly taskStarted: boolean | null;
  readonly taskProcessExited: boolean;
  readonly stdioClosed: boolean;
  readonly srtReset: boolean;
  /** Process/group exit is not evidence that detached descendants are gone. */
  readonly taskTreeCleanup: "not_started" | "unknown";
}

/** Authenticated only while attached to the original owned fork/IPC channel.
 * This is not a kernel task-tree identity and cannot be reconstructed from a PID. */
export interface JobHostSupervision {
  readonly protocolVersion: "job-host.v2";
  readonly sessionId: string;
  readonly bootId: string;
  readonly processId: number;
  readonly processIdentityRef: string;
  readonly processStartedAt: string;
  readonly sequence: number;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly state: "alive" | "lost" | "exited";
  readonly task: {
    readonly processId: number;
    readonly processIdentityRef: string;
    readonly startedAt: string;
  } | null;
  readonly taskTreeGuarantee: "unverified";
}
