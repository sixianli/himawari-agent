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
import type { PayloadRecord } from "./observability.js";
import type { RunPayloadArtifact } from "./run-payload-artifacts.js";
import type { SandboxExecutionVerification } from "./sandbox-execution.js";

export interface SandboxReleaseReceipt {
  readonly acceptedAt: string;
  readonly verification: SandboxExecutionVerification;
}

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
      readonly basis: "preparation_not_authorized" | "preparation_launch_blocked";
    })
  | (SandboxReservationReleaseBase & {
      readonly basis: "host_never_started";
      readonly processIdentityRef: string;
      readonly controlSessionId: string;
    })
  | (SandboxReservationReleaseBase & {
      readonly basis: "task_environment_released";
      readonly taskEnvironmentIds: readonly string[];
    })
  | (SandboxReservationReleaseBase & {
      readonly basis: "task_environment_bind_fenced";
    });

export interface SandboxAdministratorReservationReleaseVerification {
  readonly schemaVersion: "sandbox-admin-reservation-release.v1";
  readonly basis: "administrator_confirmed_cleanup";
  readonly identity: SandboxJobIdentity;
  readonly environmentId: string;
  readonly semanticFingerprint: string;
  readonly stopRequestedAt: string;
  readonly checkedAt: string;
  readonly inspectionDigest: string;
  readonly administrator: string;
  readonly evidenceDigest: string;
  readonly confirmation: "HOST_GROUP_ABSENT_FINAL_ABSENT_RELATED_PROCESSES_ABSENT";
  readonly actor: {
    readonly uid: number;
    readonly account: string;
    readonly hostname: string;
  };
  readonly auditId: string;
}

export type SandboxReservationReleaseReceipt =
  | {
      readonly acceptedAt: string;
      readonly verification: SandboxReservationReleaseVerification;
    }
  | {
      readonly acceptedAt: string;
      readonly verification: SandboxAdministratorReservationReleaseVerification;
    };

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

export interface SandboxWorkspaceClaim {
  readonly ref: string;
  readonly hostId: string;
  readonly canonicalRootId: string;
  readonly access: "read" | "write";
  readonly lineage: readonly Pick<HostFileIdentity, "device" | "inode">[];
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
  interruptRecovery(input: SandboxRecoveryInput): Promise<void>;
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
    readonly expectedRecoveryRevision?: number;
    readonly facts: SandboxExecutionFacts;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
    readonly context: SandboxExecutionProjectionContext;
  }): Promise<SandboxExecutionMutation>;
  recordOperation(
    input: Parameters<SandboxExecutionJournalPort["append"]>[0],
  ): Promise<SandboxExecutionMutation>;
  readResultRecovery(input: {
    readonly identity: SandboxJobIdentity;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
    readonly recoveryPurpose?: "deadline_failure";
  }): Promise<{
    readonly receipt: FrozenCapabilityInvocationReceipt;
    readonly output: RunPayloadArtifact | undefined;
  }>;
  importResult(
    input: Parameters<SandboxExecutionJournalPort["append"]>[0] & {
      readonly recoveryPurpose?: "deadline_failure";
      readonly payload: PayloadRecord;
      readonly source: {
        readonly binding: string;
        readonly digest: string;
        readonly byteLength: number;
        readonly controlArtifact?: {
          readonly operationKey: string;
          readonly payloadRef: string;
          readonly contentDigest: string;
        };
        readonly artifacts: readonly {
          readonly operationKey: string;
          readonly payloadRef: string;
          readonly contentDigest: string;
        }[];
      };
    },
  ): Promise<SandboxExecutionMutation>;
  prepareIntent(input: SandboxContinuationIntentInput): Promise<{ readonly applied: boolean }>;
  dispatchIntent(input: SandboxContinuationIntentInput): Promise<{ readonly applied: boolean }>;
  acknowledgeIntent(input: {
    readonly identity: SandboxJobIdentity;
    readonly intentId: string;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
    readonly context: SandboxExecutionProjectionContext;
  }): Promise<void>;
  observeIntent(input: {
    readonly identity: SandboxJobIdentity;
    readonly intentId: string;
    readonly reasonCode: string;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
  }): Promise<void>;
}
export interface SandboxContinuationIntentInput {
  readonly resultRecoveryLease?: SandboxExecutionPlanV2["executionLease"];
  readonly identity: SandboxJobIdentity;
  readonly intentId: string;
  readonly kind: "tool_result" | "continue";
  readonly expectedSequence: number;
  readonly authority: CapabilityInvocationAuthority;
  readonly now: string;
  readonly context: SandboxExecutionProjectionContext;
}

export type SandboxExecutionAdmissionRecord =
  | {
      readonly phase: "reserved";
      readonly plan: SandboxExecutionPlanV2;
      readonly reservation: SandboxExecutionReservation;
      readonly stopRequestedAt?: string;
      readonly recovery?: SandboxRecoveryState;
      readonly releaseReceipt?: SandboxReservationReleaseReceipt;
      readonly workspaceBlocked?: boolean;
      readonly workspaces: readonly SandboxWorkspaceClaim[];
    }
  | { readonly phase: "bound"; readonly record: SandboxExecutionRecord };
export interface SandboxTaskEnvironmentCallFacts {
  readonly environmentId: string;
  readonly executionJobId: string;
  readonly environmentGeneration: number;
  readonly invocationId: string;
  readonly state:
    | "reserved"
    | "creating"
    | "ready"
    | "running"
    | "unknown"
    | "stop_requested"
    | "released";
  readonly stopFence: number;
  readonly deadlineAt: string;
  readonly linkedAt: string;
  readonly completedAt: string | null;
}
export interface SandboxExecutionRunInventory {
  readonly sandboxResourcesAbsent?: boolean;
  readonly legacyResourcesPending: boolean;
  readonly admissions: readonly SandboxExecutionAdmissionRecord[];
  readonly queue: readonly NonNullable<
    Awaited<ReturnType<SandboxExecutionPreparationPort["readQueuedByInvocation"]>>
  >[];
  readonly deletedPlans: readonly SandboxExecutionPlanV2[];
  readonly taskEnvironmentCalls: readonly SandboxTaskEnvironmentCallFacts[];
  readonly executionLease: {
    readonly expiresAt: string;
    readonly releasedAt: string | null;
  } | null;
}
export interface SandboxQueuedToolBatch {
  readonly version: "queued-tool-batch.v1";
  readonly continuationRef: string;
  readonly toolCallId: string;
  readonly authority: CapabilityInvocationAuthority["product"];
}
export interface SandboxExecutionPreparationPort {
  assertResultAuthority(input: {
    readonly identity: SandboxJobIdentity;
    readonly authority: CapabilityInvocationAuthority;
    readonly executionLease: SandboxExecutionPlanV2["executionLease"];
    readonly replyDeadlineAt: string;
    readonly now: string;
  }): Promise<void>;
  authorizeReservationResult(input: {
    readonly identity: SandboxJobIdentity;
    readonly authority: CapabilityInvocationAuthority;
    readonly executionLease: SandboxExecutionPlanV2["executionLease"];
    readonly deadlineAt: string;
    readonly now: string;
  }): Promise<void>;
  readRunInventory(input: { readonly runId: string }): Promise<SandboxExecutionRunInventory>;
  listRecoveryCandidates(input: {
    readonly now: string;
    readonly afterJobId: string | null;
    readonly limit: number;
  }): Promise<readonly SandboxExecutionAdmissionRecord[]>;
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
  validatePreparation(input: ConsumeCapabilityInvocationInput): Promise<void>;
  releaseReservation(input: {
    readonly identity: SandboxJobIdentity;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
    readonly verification: SandboxReservationReleaseVerification;
    readonly expectedRecoveryRevision?: number;
  }): Promise<{ readonly admission: SandboxExecutionAdmissionRecord; readonly applied: boolean }>;
  interruptReservation(input: {
    readonly identity: SandboxJobIdentity;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
    readonly reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN" | "SANDBOX_PREVIOUS_BOOT_UNKNOWN";
  }): Promise<{ readonly admission: SandboxExecutionAdmissionRecord; readonly applied: boolean }>;
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
  rebindQueued(
    input: Parameters<SandboxExecutionPreparationPort["reserve"]>[0] & {
      readonly expectedBindingRevision: number;
    },
  ): Promise<
    NonNullable<Awaited<ReturnType<SandboxExecutionPreparationPort["readQueuedByInvocation"]>>>
  >;
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
    readonly environmentDeadlineAt?: string;
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
  listRunningPrograms(input: {
    readonly afterJobId: string | null;
    readonly limit: number;
  }): Promise<readonly SandboxExecutionRecord[]>;
  listAdmissions(input: {
    readonly runId?: string;
    readonly afterJobId: string | null;
    readonly limit: number;
  }): Promise<readonly SandboxExecutionAdmissionRecord[]>;
  bindAndStart(input: {
    readonly identity: SandboxJobIdentity;
    readonly expectedSequence: 1;
    readonly facts: SandboxExecutionFacts;
    readonly authority: CapabilityInvocationAuthority;
    readonly now: string;
  }): Promise<SandboxExecutionMutation>;
}
