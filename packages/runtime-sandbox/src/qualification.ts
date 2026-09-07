import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { SRT_VERSION } from "./policy.js";

export interface SrtDependencyReadiness {
  readonly version: typeof SRT_VERSION;
  readonly platformSupported: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  /** SDK readiness is insufficient to issue a host qualification. */
  readonly productionSuitable: false;
  readonly missingGuarantees: readonly string[];
}

/** Read-only dependency probe. Does not initialize proxies or launch a user command.
 * Missing guarantees must be supplied and separately verified by the host supervisor;
 * neither an SDK success nor a stored boolean can manufacture this evidence. */
export async function inspectSrtDependencies(): Promise<SrtDependencyReadiness> {
  const platformSupported = SandboxManager.isSupportedPlatform();
  const dependencies = await SandboxManager.checkDependenciesAsync();
  return Object.freeze({
    version: SRT_VERSION,
    platformSupported,
    errors: Object.freeze([...dependencies.errors]),
    warnings: Object.freeze([...dependencies.warnings]),
    productionSuitable: false,
    missingGuarantees: Object.freeze([
      "hard_cpu_ceiling",
      "hard_memory_ceiling",
      "task_tree_termination",
      "worker_crash_cleanup",
      "durable_start_admission",
    ]),
  });
}
