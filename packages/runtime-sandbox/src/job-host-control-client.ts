/** Agent-side risk reduction only. This module never imports SRT or launch code. */
export type { JobHostControlBinding, JobHostControlObservation } from "./job-host-control.ts";
export { queryJobHostControl, readJobHostFinalEvidence } from "./job-host-control.ts";
export { readLinuxNamespaceState } from "./linux-namespace.ts";
