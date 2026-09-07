import type {
  SandboxExecutionPlan,
  SandboxJobIdentity,
  SandboxJobReceipt,
} from "@himawari-agent/execution-contracts";

export type {
  SandboxExecutionPlan,
  SandboxJobIdentity,
  SandboxJobReceipt,
} from "@himawari-agent/execution-contracts";

/** Worker-owned lifecycle. A typed plan is not authority: prepare/start must
 * re-read the consumed Capability receipt, live fence, protected scope, current
 * qualification and deadline. Persist starting before any process is launched.
 * Approval/Run recovery stays with the existing coordinator and checkpoints.
 */
export interface SandboxExecutionPort {
  prepare(plan: SandboxExecutionPlan): Promise<SandboxJobReceipt>;
  start(identity: SandboxJobIdentity): Promise<SandboxJobReceipt>;
  observe(identity: SandboxJobIdentity): Promise<SandboxJobReceipt>;
  /** Cancellation is a stop request, not proof that an effect did not happen.
   * Run deadline ends user execution; cleanup has a separate bounded window. */
  cancel(
    identity: SandboxJobIdentity,
    reason: "owner_cancelled" | "deadline_exceeded",
  ): Promise<SandboxJobReceipt>;
  /** Reconcile observations; never relaunch an unresolved attempt. */
  reconcile(identity: SandboxJobIdentity): Promise<SandboxJobReceipt>;
}
