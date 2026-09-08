import path from "node:path";
import type { SandboxPolicyInput } from "./policy.ts";

/** Trusted Worker-to-Job-Host IPC; not a model tool or authority grant. */
export interface JobHostRequest {
  readonly jobId: string;
  readonly attemptId: string;
  readonly policy: SandboxPolicyInput;
  readonly policyDigest: string;
  readonly executable: string;
  readonly args: readonly string[];
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
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key))
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
  if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error("JOB_HOST_INPUT_TOO_LARGE");
  return structuredClone(value) as JobHostRequest;
}

/** Quote argv elements without granting shell interpretation to their contents. */
export function quoteJobArgument(argument: string): string {
  if (argument.includes("\0")) throw new Error("JOB_HOST_ARGS_INVALID");
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

export interface JobHostResult {
  readonly jobId: string;
  readonly attemptId: string;
  readonly reason: "exited" | "cancelled" | "deadline" | "output_limit" | "host_failure";
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
