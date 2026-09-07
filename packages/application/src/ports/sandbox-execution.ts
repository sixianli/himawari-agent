import type {
  SandboxExecutionPlan,
  SandboxJobIdentity,
  SandboxJobReceipt,
} from "@himawari-agent/execution-contracts";
import type { CapabilityInvocationAuthority } from "./capability-invocations.js";

export interface SandboxJobRecord {
  readonly plan: SandboxExecutionPlan;
  readonly observation: SandboxJobReceipt;
}

/** The journal records facts under the existing invocation authority. It does not
 * certify the protected scope or host qualification and is not permission to spawn.
 * The supervisor must also prove fresh admission: an old/replayed receipt without
 * a journal is an unknown execution, never a reason to create and launch a new job.
 * Only a newly applied starting transition may be used by the qualified supervisor. */
export interface SandboxJobJournalPort {
  prepare(input: {
    readonly plan: SandboxExecutionPlan;
    readonly observation: SandboxJobReceipt;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
  }): Promise<{ readonly record: SandboxJobRecord; readonly applied: boolean }>;
  append(input: {
    readonly observation: SandboxJobReceipt;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
  }): Promise<{ readonly record: SandboxJobRecord; readonly applied: boolean }>;
  read(identity: SandboxJobIdentity): Promise<SandboxJobRecord | undefined>;
  listPending(input: {
    readonly afterJobId: string | null;
    readonly limit: number;
  }): Promise<readonly SandboxJobRecord[]>;
}

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
