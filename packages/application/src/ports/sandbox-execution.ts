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
  /** Agent-only lookup of an existing parent; does not admit or replay it. */
  readByInvocation(input: {
    readonly runId: string;
    readonly invocationId: string;
  }): Promise<SandboxJobRecord | undefined>;
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

/** Trusted host adapter returns protected output references, never raw task output.
 * A settled process is not proof of cleanup or of known side effects. */
export type SandboxHostObservation = Pick<
  SandboxJobReceipt,
  "outcome" | "cleanup" | "effect" | "outputRef" | "outputDigest" | "reasonCode" | "resources"
>;
export interface SandboxHostSession {
  readonly policyDigest: string;
  readonly ready: Promise<void>;
  readonly result: Promise<SandboxHostObservation>;
  start(): void;
  cancel(): void;
}
