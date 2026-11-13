/** Agent-side risk reduction only. This module never imports SRT or launch code. */
export type { JobHostControlBinding, JobHostControlObservation } from "./job-host-control.ts";
export { containerRunnerDigest } from "./execution-backend/container-runner.ts";
export {
  queryJobHostControl,
  readJobHostFinalEvidence,
  readJobHostStartEvidence,
} from "./job-host-control.ts";
export { readLinuxHostGroup } from "./linux-host-group.ts";
export {
  blockJobHostLaunch,
  readJobHostLaunchDecision,
  type JobHostLaunchContext,
  type JobHostLaunchEvidence,
} from "./job-host-launch-decision.ts";
export { readLinuxNamespaceState } from "./linux-namespace.ts";
export { readMachineBootId } from "./machine-boot.ts";
export { processGroupPresent, readProcessStartToken } from "./process-identity.ts";
