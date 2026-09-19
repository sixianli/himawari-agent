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

/** Each request performs one bounded inspect/stop; unresolved never means a background retry. */
export interface SandboxRecoveryState {
  readonly revision: number;
  readonly owner: string;
  readonly attempts: number;
  readonly status: "running" | "resolved" | "unresolved";
  readonly action: "inspect" | "stop";
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly finishedAt: string | null;
  readonly reasonCode: string;
}
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
    },
  ): Promise<SandboxRecoveryState>;
  finishRecovery(
    input: SandboxRecoveryInput & {
      readonly expectedRecoveryRevision: number;
      readonly reasonCode: string;
    },
  ): Promise<SandboxRecoveryState>;
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
      readonly workspaces: readonly SandboxWorkspaceClaim[];
    }
  | { readonly phase: "bound"; readonly record: SandboxExecutionRecord };
export interface SandboxExecutionPreparationPort {
  /** Historical queue snapshot, including cancelled/admitted rows; never a replay permit. */
  readQueuedByInvocation(input: { readonly runId: string; readonly invocationId: string }): Promise<
    | {
        readonly sequence: number;
        readonly status: "queued" | "admitted" | "cancelled";
        readonly plan: SandboxExecutionPlanCandidateV2;
        readonly reservation: SandboxExecutionReservation;
        readonly workspaces: readonly SandboxWorkspaceClaim[];
        readonly invocation: Omit<ConsumeCapabilityInvocationInput, "consumedAt">;
      }
    | undefined
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
