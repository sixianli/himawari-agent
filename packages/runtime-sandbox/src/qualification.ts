import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { SRT_VERSION } from "./policy.js";
import {
  installedSrtPackageRoot,
  readSrtRuntimeIdentity,
  requireLockedSrtRuntime,
} from "./srt-runtime-identity.js";

export interface SrtDependencyReadiness {
  readonly version: typeof SRT_VERSION;
  readonly installedVersion: string | null;
  readonly bwrapVersion: string | null;
  readonly platformSupported: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly productionSuitable: false;
  readonly missingGuarantees: readonly string[];
  readonly limitations: readonly string[];
}

export async function inspectSrtDependencies(): Promise<SrtDependencyReadiness> {
  const platformSupported = SandboxManager.isSupportedPlatform();
  const dependencies = await SandboxManager.checkDependenciesAsync();
  const identity = await readSrtRuntimeIdentity(installedSrtPackageRoot());
  const runtimeErrors: string[] = [];
  try {
    requireLockedSrtRuntime(identity, SRT_VERSION);
  } catch (error) {
    runtimeErrors.push(error instanceof Error ? error.message : "JOB_HOST_SRT_VERSION_MISMATCH");
  }
  return Object.freeze({
    version: SRT_VERSION,
    installedVersion: identity.version,
    bwrapVersion: identity.bwrapVersion,
    platformSupported,
    errors: Object.freeze([...runtimeErrors, ...dependencies.errors]),
    warnings: Object.freeze([...dependencies.warnings]),
    productionSuitable: false,
    missingGuarantees: Object.freeze([
      "resource_observation",
      ...(process.platform === "darwin"
        ? ["best_effort_stop_and_unknown_quarantine", "worker_crash_reconciliation"]
        : ["task_tree_termination", "worker_crash_cleanup"]),
      "durable_start_admission",
    ]),
    limitations: Object.freeze(
      process.platform === "darwin" ? ["detached_descendants_may_survive_stop"] : [],
    ),
  });
}
