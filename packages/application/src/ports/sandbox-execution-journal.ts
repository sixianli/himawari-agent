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
}
export interface SandboxExecutionRecord {
  readonly plan: SandboxExecutionPlanV2;
  readonly facts: SandboxExecutionFacts;
  readonly workspaces: readonly SandboxWorkspaceClaim[];
  readonly startedAt: string | null;
  readonly operationRevision: number;
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
