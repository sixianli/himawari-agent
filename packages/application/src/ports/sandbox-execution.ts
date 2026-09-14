import type {
  SandboxExecutionFacts,
  SandboxExecutionPlan,
  SandboxExecutionPlanV2,
  SandboxJobIdentity,
  SandboxJobReceipt,
  SandboxResourceObservation,
  SandboxResourceOutputPage,
  SandboxResourceOutputQuery,
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
  SandboxExecutionFacts,
  SandboxExecutionPlan,
  SandboxExecutionPlanV2,
  SandboxJobIdentity,
  SandboxJobReceipt,
  SandboxResourceObservation,
  SandboxResourceOutputPage,
  SandboxResourceOutputQuery,
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

/** Explicit v2 opt-in. Existing v1 adapters cannot acquire controlled/released defaults.
 * Implementations must retain the same admission, authenticated Payload and lifecycle ownership.
 * A resource locator is not authority; each request carries its own current trusted context.
 */
export interface SandboxExecutionPortV2 {
  readonly schemaVersion: "sandbox-execution.v2";
  prepare(plan: SandboxExecutionPlanV2): Promise<SandboxExecutionFacts>;
  start(identity: SandboxJobIdentity): Promise<SandboxExecutionFacts>;
  observe(identity: SandboxJobIdentity): Promise<SandboxExecutionFacts>;
  cancel(
    identity: SandboxJobIdentity,
    reason: "owner_cancelled" | "deadline_exceeded",
  ): Promise<SandboxExecutionFacts>;
  reconcile(identity: SandboxJobIdentity): Promise<SandboxExecutionFacts>;
  inspectResource(input: SandboxResourceControlRequest): Promise<SandboxResourceObservation>;
  readResourceOutput(
    input: SandboxResourceControlRequest & SandboxResourceOutputQuery,
  ): Promise<SandboxResourceOutputPage>;
  /** Risk reduction only; expired original Grant must not prevent trusted emergency cleanup. */
  stopResource(
    input: SandboxResourceControlRequest & {
      readonly reason: "owner_cancelled" | "deadline_exceeded" | "supervision_lost";
    },
  ): Promise<SandboxResourceObservation>;
  /** Each request has an independently consumed Handle/identity, within the same frozen scope. */
  invokeService(input: {
    readonly resourceRef: string;
    readonly plan: SandboxExecutionPlanV2;
  }): Promise<SandboxExecutionFacts>;
}
export interface SandboxResourceControlRequest {
  readonly resourceRef: string;
  readonly identity: SandboxJobIdentity;
  readonly authority: CapabilityInvocationAuthority;
  readonly now: string;
  readonly expectedSequence: number;
}

/** Produced by trusted Payload/qualification/verifier readers, never by a runner.
 * Shape validation cannot establish evidence authenticity. Empty evidence fails closed.
 */
export interface SandboxExecutionVerification {
  /** Exact immutable facts authenticated by the reader; evidence cannot be reused on edited claims. */
  readonly facts: SandboxExecutionFacts;
  readonly identity: SandboxJobIdentity;
  readonly environmentId: string;
  readonly policyDigest: string;
  readonly resourceSequence: number;
  readonly checkedAt: string;
  readonly validUntil: string;
  readonly evidence: readonly { readonly ref: string; readonly digest: string }[];
  readonly outputs: readonly {
    readonly ref: string;
    readonly digest: string;
    readonly byteLength: number;
  }[];
}
/** Evidence readers authenticate ownership/content/qualification. Implementations are R3/R4 work. */
export interface SandboxExecutionEvidencePort {
  verify(input: {
    readonly plan: SandboxExecutionPlanV2;
    readonly facts: SandboxExecutionFacts;
    readonly now: string;
  }): Promise<SandboxExecutionVerification>;
}
