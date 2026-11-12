import {
  type SandboxExecutionSupport,
  withSandboxExecutionSupport,
} from "./sandbox-execution-support.ts";
import { SANDBOX_RUNTIME_VERSION } from "./sandbox-runtime-version.ts";
import {
  array,
  ContractValidationError,
  enumeration,
  type InferSchema,
  literal,
  machineString,
  object,
  type Schema,
} from "./validation.ts";

const digest: Schema<string> = {
  parse(value, path = "$") {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      throw new ContractValidationError(path, "expected SHA-256 digest");
    return value;
  },
};
const guarantees = [
  "filesystem_default_deny",
  "network_allowlist",
  "clean_environment",
  "bounded_output",
  "wall_clock_stop",
  "resource_observation",
  "durable_start_admission",
  "unknown_quarantine",
  "restart_reconciliation",
  "best_effort_stop",
  "task_tree_termination",
  "worker_crash_cleanup",
  "fixed-file-terminal-no-writer.v1",
] as const;
const shape = object({
  schemaVersion: literal("sandbox-runtime-qualification.v1"),
  qualificationRef: machineString,
  hostId: machineString,
  profileRef: machineString,
  srtVersion: literal(SANDBOX_RUNTIME_VERSION),
  platform: enumeration(["darwin", "linux"]),
  architecture: enumeration(["arm64", "x64"]),
  osRelease: machineString,
  runtimeDigest: digest,
  runnerDigest: digest,
  evidenceDigest: digest,
  resourceMode: literal("observe_and_stop"),
  terminationMode: enumeration(["best_effort", "verified_tree"]),
  guarantees: array(enumeration(guarantees)),
  limitations: array(literal("detached_descendants_may_survive_stop")),
});
export type SandboxRuntimeQualification = InferSchema<typeof shape> & {
  readonly supportedExecutions?: SandboxExecutionSupport;
};
export const sandboxRuntimeQualificationSchema: Schema<SandboxRuntimeQualification> =
  withSandboxExecutionSupport({
    parse(value, path = "$") {
      const record = shape.parse(value, path);
      const required = guarantees.slice(0, 9);
      if (
        new Set(record.guarantees).size !== record.guarantees.length ||
        new Set(record.limitations).size !== record.limitations.length ||
        required.some((guarantee) => !record.guarantees.includes(guarantee))
      )
        throw new ContractValidationError(path, "missing or duplicate sandbox guarantees");
      if (record.platform === "darwin") {
        if (
          record.terminationMode !== "best_effort" ||
          !record.guarantees.includes("best_effort_stop") ||
          record.guarantees.includes("task_tree_termination") ||
          record.guarantees.includes("worker_crash_cleanup") ||
          record.limitations.length !== 1
        )
          throw new ContractValidationError(
            path,
            "Mac profile must preserve accepted cleanup uncertainty",
          );
      } else if (
        record.terminationMode !== "verified_tree" ||
        record.limitations.length !== 0 ||
        !record.guarantees.includes("task_tree_termination") ||
        !record.guarantees.includes("worker_crash_cleanup")
      )
        throw new ContractValidationError(path, "Linux profile requires verified tree cleanup");
      return record;
    },
  });

export interface SandboxEnforcementClaims {
  readonly platform: string;
  readonly runtimeIdentity: unknown;
  readonly enforcement: {
    readonly filesystem: boolean;
    readonly network: boolean;
    readonly processes: boolean;
    readonly secrets: boolean;
    readonly resourceCeilings: boolean;
    readonly termination: boolean;
  };
}

export function sandboxEnforcementClaimsMatchEvidence(
  claims: SandboxEnforcementClaims,
  evidence: unknown,
): boolean {
  let sandbox: SandboxRuntimeQualification;
  try {
    sandbox = sandboxRuntimeQualificationSchema.parse(evidence);
  } catch (error) {
    if (error instanceof ContractValidationError) return false;
    throw error;
  }
  return (
    sandbox.platform === claims.platform &&
    claims.runtimeIdentity === `srt:${sandbox.srtVersion}` &&
    claims.enforcement.resourceCeilings === false &&
    claims.enforcement.termination === (sandbox.platform === "linux")
  );
}

export function sandboxRequiredControlsEnforced(
  enforcement: SandboxEnforcementClaims["enforcement"],
): boolean {
  return (
    enforcement.filesystem === true &&
    enforcement.network === true &&
    enforcement.processes === true &&
    enforcement.secrets === true
  );
}
