import path from "node:path";
import {
  type JobHostControlBinding,
  queryJobHostControlBytes,
  readJobHostControlEvidenceBytes,
  validateJobHostControlQuery,
} from "./job-host-control.ts";
import {
  describeJobHostControlDirectory,
  prepareJobHostControlDirectory,
  validateJobHostControlDirectoryName,
} from "./job-host-control-access.ts";
import {
  blockedLaunchDecision,
  decideJobHostLaunch,
  type JobHostLaunchContext,
  readJobHostLaunchDecision,
} from "./job-host-launch-decision.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("JOB_HOST_GATEWAY_CONTROL_INVALID");
  return value as Record<string, unknown>;
}

function controlDirectory(controlRoot: string, directory: unknown): string {
  if (
    typeof directory !== "string" ||
    path.resolve(directory) !== directory ||
    path.dirname(directory) !== controlRoot
  )
    throw new Error("JOB_HOST_GATEWAY_CONTROL_OUTSIDE_ROOT");
  validateJobHostControlDirectoryName(path.basename(directory));
  return directory;
}

function binding(controlRoot: string, value: unknown): JobHostControlBinding {
  const raw = record(value);
  controlDirectory(controlRoot, raw["directory"]);
  return raw as unknown as JobHostControlBinding;
}

function launchContext(controlRoot: string, value: unknown): JobHostLaunchContext {
  const raw = record(value);
  binding(controlRoot, raw["control"]);
  return raw as unknown as JobHostLaunchContext;
}

export async function answerJobHostControlFrame(
  controlRoot: string,
  frame: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const op = frame["op"];
  if (op === "prepare") {
    const name = frame["name"];
    validateJobHostControlDirectoryName(name);
    return { ...(await prepareJobHostControlDirectory(controlRoot, name)) };
  }
  if (op === "describe")
    return {
      ...(await describeJobHostControlDirectory(controlDirectory(controlRoot, frame["directory"]))),
    };
  if (op === "query") {
    const command = frame["command"];
    const timeoutMs = frame["timeoutMs"];
    validateJobHostControlQuery(command, timeoutMs);
    return {
      encoded: await queryJobHostControlBytes(
        binding(controlRoot, frame["binding"]),
        command,
        timeoutMs as number,
        signal,
      ),
    };
  }
  if (op === "evidence") {
    const name = frame["name"];
    if (name !== "final.json" && name !== "started.json")
      throw new Error("JOB_HOST_GATEWAY_CONTROL_INVALID");
    return {
      encoded: await readJobHostControlEvidenceBytes(binding(controlRoot, frame["binding"]), name),
    };
  }
  if (op === "launch") {
    const context = launchContext(controlRoot, frame["context"]);
    const action = frame["action"];
    if (action === "read") return { evidence: (await readJobHostLaunchDecision(context)) ?? null };
    if (action === "claim") return { ...(await decideJobHostLaunch(context, { kind: "launch" })) };
    if (action === "block") {
      const stopRequestedAt = frame["stopRequestedAt"];
      if (typeof stopRequestedAt !== "string")
        throw new Error("SANDBOX_RESERVATION_STOP_FENCE_INVALID");
      return {
        ...(await decideJobHostLaunch(context, blockedLaunchDecision(stopRequestedAt))),
      };
    }
  }
  throw new Error("JOB_HOST_GATEWAY_CONTROL_INVALID");
}

export function jobHostControlFailure(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : "";
  const systemCode =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return {
    type: "result",
    ok: false,
    error: /^[A-Z][A-Z0-9_]{0,79}$/.test(message) ? message : "JOB_HOST_GATEWAY_CONTROL_FAILED",
    ...(systemCode && /^E[A-Z0-9]{1,20}$/.test(systemCode) ? { systemCode } : {}),
  };
}
