import type {
  SandboxExecutionPlan,
  SandboxJobIdentity,
  SandboxJobReceipt,
} from "@himawari-agent/execution-contracts";
import type {
  CapabilityInvocationAuthority,
  ConsumeCapabilityInvocationInput,
  FrozenCapabilityInvocationReceipt,
} from "./capability-invocations.js";

export interface SandboxJobRecord {
  readonly plan: SandboxExecutionPlan;
  readonly observation: SandboxJobReceipt;
}

export interface SandboxJobAdmissionResult {
  readonly record: SandboxJobRecord;
  readonly applied: boolean;
  /** Frozen in the same transaction; callers must not consume again to project it. */
  readonly receipt: FrozenCapabilityInvocationReceipt;
}

/** Durable admission and observation share the existing invocation authority.
 * This does not certify protected scope or host qualification. Only a newly
 * applied starting transition may be used by a qualified supervisor. */
export interface SandboxJobJournalPort {
  /** Atomically consume the Handle and prepare the job. A consumed receipt with
   * no job is unknown execution and must never be admitted again. The receipt
   * fingerprint is derived by persistence, never supplied by the caller. */
  admit(input: {
    readonly invocation: ConsumeCapabilityInvocationInput;
    readonly plan: Omit<SandboxExecutionPlan, "semanticFingerprint">;
    readonly observation: SandboxJobReceipt;
  }): Promise<SandboxJobAdmissionResult>;
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
