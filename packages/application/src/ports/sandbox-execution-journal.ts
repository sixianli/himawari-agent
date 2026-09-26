import type {
  SandboxExecutionFacts,
  SandboxExecutionPlanCandidateV2,
  SandboxExecutionPlanV2,
  SandboxExecutionReservation,
  SandboxJobIdentity,
} from "@himawari-agent/execution-contracts";
import type { SandboxExecutionProjectionContext } from "../services/sandbox-execution-projection.js";
import type {
  CapabilityInvocationAuthority,
  ConsumeCapabilityInvocationInput,
  FrozenCapabilityInvocationReceipt,
} from "./capability-invocations.js";
import type { HostFileIdentity } from "./host-files.js";
import type { SandboxExecutionVerification } from "./sandbox-execution.js";

/** Trusted journal receipt: proof was valid when accepted, not a renewable execution grant. */
export interface SandboxReleaseReceipt {
  readonly acceptedAt: string;
  readonly verification: SandboxExecutionVerification;
}

/** Host-only attestation for an environment that never started user code.
 * It creates no runtime binding, execution permission or business result. */
interface SandboxReservationReleaseBase {
  readonly schemaVersion: "sandbox-reservation-release.v1";
  readonly identity: SandboxJobIdentity;
  readonly environmentId: string;
  readonly semanticFingerprint: string;
  readonly stopRequestedAt: string;
  readonly checkedAt: string;
  readonly validUntil: string;
  readonly evidence: { readonly ref: string; readonly digest: string };
}

export type SandboxReservationReleaseVerification =
  | (SandboxReservationReleaseBase & {
      readonly basis: "host_never_started";
      readonly processIdentityRef: string;
      readonly controlSessionId: string;
    })
  | (SandboxReservationReleaseBase & {
      readonly basis: "task_environment_released";
      readonly taskEnvironmentIds: readonly string[];
    });

export interface SandboxReservationReleaseReceipt {
  readonly acceptedAt: string;
  readonly verification: SandboxReservationReleaseVerification;
}

/** Each attempt performs one bounded inspect/stop; unresolved has no scheduled retry. */
export interface SandboxRecoveryAttemptState {
  readonly revision: number;
  readonly owner: string;
  readonly attempts: number;
  readonly status: "running" | "resolved" | "unresolved";
  readonly action: "inspect" | "stop";
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly finishedAt: string | null;
  readonly reasonCode: string;
  readonly nextAttemptAt?: null;
}
interface SandboxScheduledRecovery {
  readonly revision: number;
  readonly owner: string;
  readonly attempts: number;
  readonly status: "scheduled";
  readonly action: "inspect" | "stop";
  readonly scheduledAt: string;
  readonly nextAttemptAt: string;
  readonly startedAt: null;
  readonly deadlineAt: null;
  readonly finishedAt: null;
  readonly reasonCode: string;
}
export type SandboxRecoveryState =
  | SandboxRecoveryAttemptState
  | SandboxScheduledRecovery
  | (Omit<SandboxScheduledRecovery, "status" | "nextAttemptAt" | "finishedAt"> & {
      readonly status: "resolved";
      readonly nextAttemptAt: null;
      readonly finishedAt: string;
    });
export interface SandboxRecoveryInput {
  readonly identity: SandboxJobIdentity;
  readonly authority: CapabilityInvocationAuthority;
  readonly now: string;
  readonly expectedSequence: number;
}

/** Host-verified ancestor chain, filesystem root through the authorized directory.
 * Uses the same device/inode identities as constrained file access. No raw path prefix locks.
 * R3 resolves this from current host/grant state; model arguments must never supply it.
 */
export interface SandboxWorkspaceClaim {
  readonly ref: string;
  readonly hostId: string;
  readonly canonicalRootId: string;
  readonly access: "read" | "write";
  readonly lineage: readonly Pick<HostFileIdentity, "device" | "inode">[];
  /** Absent means the whole directory tree. For files, lineage ends at the parent.
   * The host resolves aliases; the slot survives atomic inode replacement. */
  readonly file?: {
    readonly name: string;
    readonly identity: Pick<HostFileIdentity, "device" | "inode"> | null;
    readonly atomicPublish: boolean;
    readonly versionDigest?: string;
  };
}
export interface SandboxExecutionRecord {
  readonly plan: SandboxExecutionPlanV2;
  readonly facts: SandboxExecutionFacts;
  readonly workspaces: readonly SandboxWorkspaceClaim[];
  readonly startedAt: string | null;
  readonly operationRevision: number;
  /** Absent for legacy records until a fresh host verification is accepted. */
  readonly releaseReceipt?: SandboxReleaseReceipt;
  readonly recovery?: SandboxRecoveryState;
  readonly workspaceBlocked?: boolean;
}
export interface SandboxExecutionMutation {
  readonly record: SandboxExecutionRecord;
  readonly applied: boolean;
}
export interface SandboxExecutionJournalPort {
  admit(input: {
    readonly invocation: ConsumeCapabilityInvocationInput;
    readonly plan: SandboxExecutionPlanCandidateV2;
    readonly facts: SandboxExecutionFacts;
    readonly workspaces: readonly SandboxWorkspaceClaim[];
  }): Promise<SandboxExecutionMutation & { readonly receipt: FrozenCapabilityInvocationReceipt }>;
  read(identity: SandboxJobIdentity): Promise<SandboxExecutionRecord | undefined>;
  listPending(input: {
    readonly afterJobId: string | null;
    readonly limit: number;
  }): Promise<readonly SandboxExecutionRecord[]>;
  beginRecovery(
    input: SandboxRecoveryInput & {
      readonly action: "inspect" | "stop";
      readonly deadlineAt: string;
      readonly expectedRecoveryRevision?: number;
    },
  ): Promise<SandboxRecoveryAttemptState>;
  finishRecovery(
    input: SandboxRecoveryInput & {
      readonly expectedRecoveryRevision: number;
      readonly reasonCode: string;
    },
  ): Promise<SandboxRecoveryAttemptState>;
  /** Startup records a finite unresolved state without launching or inspecting any process. */
  interruptRecovery(input: SandboxRecoveryInput): Promise<void>;
  /** One starting CAS. Returning applied:false never grants permission to launch. */
  start(input: {
    readonly identity: SandboxJobIdentity;
    readonly expectedSequence: number;
    readonly policyDigest: string;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
  }): Promise<SandboxExecutionMutation>;
  append(input: {
    readonly identity: SandboxJobIdentity;
    readonly expectedSequence: number;
    readonly expectedOperationRevision: number;
    /** Recovery observations are fenced by the attempt in the same write transaction. */
    readonly expectedRecoveryRevision?: number;
    readonly facts: SandboxExecutionFacts;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
    readonly context: SandboxExecutionProjectionContext;
  }): Promise<SandboxExecutionMutation>;
  /** Late operation/effect evidence without inventing a resource transition. */
  recordOperation(
    input: Parameters<SandboxExecutionJournalPort["append"]>[0],
  ): Promise<SandboxExecutionMutation>;
  /** Same-transaction sequence/Run/fence check. This is not permission to dispatch yet. */
  prepareIntent(input: SandboxContinuationIntentInput): Promise<{ readonly applied: boolean }>;
  /** Rechecks live authority and latest facts immediately before dispatch; at most once. */
  dispatchIntent(input: SandboxContinuationIntentInput): Promise<{ readonly applied: boolean }>;
  /** Persist the caller's confirmed receipt; a crash before this stays uncertain. */
  acknowledgeIntent(input: {
    readonly identity: SandboxJobIdentity;
    readonly intentId: string;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
    readonly context: SandboxExecutionProjectionContext;
  }): Promise<void>;
  /** A post-dispatch failure is retained as uncertainty, never a dispatch retry. */
  observeIntent(input: {
    readonly identity: SandboxJobIdentity;
    readonly intentId: string;
    readonly reasonCode: string;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
  }): Promise<void>;
}
export interface SandboxContinuationIntentInput {
  readonly identity: SandboxJobIdentity;
  readonly intentId: string;
  readonly kind: "tool_result" | "continue";
  readonly expectedSequence: number;
  readonly authority: CapabilityInvocationAuthority;
  readonly now: string;
  readonly context: SandboxExecutionProjectionContext;
}

/** R3 reservations have no runtime binding until the one successful start CAS. */
export type SandboxExecutionAdmissionRecord =
  | {
      readonly phase: "reserved";
      readonly plan: SandboxExecutionPlanV2;
      readonly reservation: SandboxExecutionReservation;
      /** Immutable start fence, separate from subsequent cleanup progress. */
      readonly stopRequestedAt?: string;
      readonly recovery?: SandboxRecoveryState;
      readonly releaseReceipt?: SandboxReservationReleaseReceipt;
      readonly workspaceBlocked?: boolean;
      readonly workspaces: readonly SandboxWorkspaceClaim[];
    }
  | { readonly phase: "bound"; readonly record: SandboxExecutionRecord };
/** One database read snapshot. Internal identities and claims never go directly to the browser. */
export interface SandboxExecutionRunInventory {
  /** Old-format obligations remain visible; absence of v2 rows is not release proof. */
  readonly legacyResourcesPending: boolean;
  readonly admissions: readonly SandboxExecutionAdmissionRecord[];
  readonly queue: readonly NonNullable<
    Awaited<ReturnType<SandboxExecutionPreparationPort["readQueuedByInvocation"]>>
  >[];
  readonly deletedPlans: readonly SandboxExecutionPlanV2[];
}
/** Product-owned link to the protected Pi batch captured before this queue was created. */
export interface SandboxQueuedToolBatch {
  readonly version: "queued-tool-batch.v1";
  readonly continuationRef: string;
  readonly toolCallId: string;
  readonly authority: CapabilityInvocationAuthority["product"];
}
export interface SandboxExecutionPreparationPort {
  /** Read all resource and queue facts for one Run atomically, or reject the bounded read.
   * No authority renewal, dispatch, usage consumption, queue advancement or recovery. */
  readRunInventory(input: { readonly runId: string }): Promise<SandboxExecutionRunInventory>;
  /** Bounded, paged resource discovery independent of Run dispatchability. */
  listRecoveryCandidates(input: {
    readonly now: string;
    readonly afterJobId: string | null;
    readonly limit: number;
  }): Promise<readonly SandboxExecutionAdmissionRecord[]>;
  /** Rechecks current resource and Run facts in the writer transaction. No execution permit. */
  scheduleRecovery(
    input: Omit<SandboxRecoveryInput, "expectedSequence"> & {
      readonly expectedSequence: number | null;
      readonly expectedRecoveryRevision: number;
    },
  ): Promise<SandboxRecoveryState | undefined>;
  beginReservationRecovery(
    input: Omit<SandboxRecoveryInput, "expectedSequence"> & {
      readonly expectedRecoveryRevision: number;
      readonly deadlineAt: string;
    },
  ): Promise<SandboxRecoveryAttemptState>;
  finishReservationRecovery(
    input: Omit<SandboxRecoveryInput, "expectedSequence"> & {
      readonly expectedRecoveryRevision: number;
      readonly reasonCode: string;
    },
  ): Promise<SandboxRecoveryAttemptState>;
  /** Check current execution authority without consuming usage, queueing or claiming resources. */
  validatePreparation(input: ConsumeCapabilityInvocationInput): Promise<void>;
  /** Atomically accept a fresh host proof and release only this stopped attempt's claims. */
  releaseReservation(input: {
    readonly identity: SandboxJobIdentity;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
    readonly verification: SandboxReservationReleaseVerification;
    readonly expectedRecoveryRevision?: number;
  }): Promise<{ readonly admission: SandboxExecutionAdmissionRecord; readonly applied: boolean }>;
  /** Fence an unbound attempt. A concurrent bind returns its bound record for cleanup. */
  interruptReservation(input: {
    readonly identity: SandboxJobIdentity;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
    readonly reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN" | "SANDBOX_PREVIOUS_BOOT_UNKNOWN";
  }): Promise<{ readonly admission: SandboxExecutionAdmissionRecord; readonly applied: boolean }>;
  /** Historical queue snapshot, including cancelled/admitted rows; never a replay permit. */
  readQueuedByInvocation(input: { readonly runId: string; readonly invocationId: string }): Promise<
    | {
        readonly sequence: number;
        readonly status: "queued" | "admitted" | "cancelled";
        readonly bindingRevision: number;
        readonly recovery?: SandboxQueuedToolBatch;
        readonly plan: SandboxExecutionPlanCandidateV2;
        readonly reservation: SandboxExecutionReservation;
        readonly workspaces: readonly SandboxWorkspaceClaim[];
        readonly invocation: Omit<ConsumeCapabilityInvocationInput, "consumedAt">;
      }
    | undefined
  >;
  /** Rebind only an unconsumed queue to current execution authority. The original
   * request, target, queue position, approval and deadline remain immutable. */
  rebindQueued(
    input: Parameters<SandboxExecutionPreparationPort["reserve"]>[0] & {
      readonly expectedBindingRevision: number;
    },
  ): Promise<
    NonNullable<Awaited<ReturnType<SandboxExecutionPreparationPort["readQueuedByInvocation"]>>>
  >;
  /** Enqueue without consuming a Handle or acquiring any workspace resource. */
  enqueue(input: Parameters<SandboxExecutionPreparationPort["reserve"]>[0]): Promise<{
    readonly sequence: number;
    readonly status: "queued" | "admitted" | "cancelled";
  }>;
  cancelQueued(input: {
    readonly identity: SandboxJobIdentity;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
  }): Promise<void>;
  reserve(input: {
    readonly recovery?: SandboxQueuedToolBatch;
    readonly invocation: ConsumeCapabilityInvocationInput;
    readonly plan: SandboxExecutionPlanCandidateV2;
    readonly reservation: SandboxExecutionReservation;
    readonly workspaces: readonly SandboxWorkspaceClaim[];
  }): Promise<{
    readonly admission: SandboxExecutionAdmissionRecord;
    readonly applied: boolean;
    readonly receipt: FrozenCapabilityInvocationReceipt;
  }>;
  readAdmission(identity: SandboxJobIdentity): Promise<SandboxExecutionAdmissionRecord | undefined>;
  readAdmissionByInvocation(input: {
    readonly runId: string;
    readonly invocationId: string;
  }): Promise<SandboxExecutionAdmissionRecord | undefined>;
  readAdmissionByResource(input: {
    readonly runId: string;
    readonly resourceRef: string;
  }): Promise<SandboxExecutionAdmissionRecord | undefined>;
  listAdmissions(input: {
    readonly runId?: string;
    readonly afterJobId: string | null;
    readonly limit: number;
  }): Promise<readonly SandboxExecutionAdmissionRecord[]>;
  /** Actual policy, boot and private directory binding; no result or controlled claim. */
  bindAndStart(input: {
    readonly identity: SandboxJobIdentity;
    readonly expectedSequence: 1;
    readonly facts: SandboxExecutionFacts;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
  }): Promise<SandboxExecutionMutation>;
}
