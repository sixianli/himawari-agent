import type {
  ExecutionEnvelope,
  ExecutionEnvironmentIdentity,
  ExecutionEnvironmentLocator,
  ExecutionEnvironmentStopProof,
} from "@himawari-agent/execution-contracts";
import type { CapabilityInvocationAuthority } from "./capability-invocations.js";
import type { SandboxWorkspaceClaim } from "./sandbox-execution-journal.js";

export type ExecutionEnvironmentState =
  | "reserved"
  | "creating"
  | "ready"
  | "running"
  | "unknown"
  | "stop_requested"
  | "released";
export type ExecutionEnvironmentRotationReason =
  | "initial"
  | "expansion"
  | "revocation"
  | "expiry"
  | "failure";
export type ExecutionEnvironmentStopReason =
  | "run_finished"
  | "run_cancelled"
  | "expansion"
  | "revocation"
  | "expiry"
  | "failure"
  | "supervision_lost";

export interface ExecutionEnvironmentStopIntent {
  readonly stopIntentId: string;
  readonly stopFence: number;
  readonly reason: ExecutionEnvironmentStopReason;
  readonly stoppedResourceRefs: readonly string[];
  readonly requestedAt: string;
  readonly acknowledgedAt: string | null;
}

export type ExecutionEnvironmentReleaseReceipt =
  | {
      readonly basis: "create_not_dispatched";
      readonly stopFence: number;
      readonly acceptedAt: string;
    }
  | {
      readonly basis: ExecutionEnvironmentStopProof["basis"];
      readonly stopFence: number;
      readonly acceptedAt: string;
      readonly proof: ExecutionEnvironmentStopProof;
    };

export interface ExecutionEnvironmentCall {
  readonly invocationId: string;
  readonly receiptRef: string;
  readonly claims: readonly SandboxWorkspaceClaim[];
  readonly linkedAt: string;
  readonly completedAt: string | null;
}

export interface ExecutionEnvironmentRecord {
  readonly identity: ExecutionEnvironmentIdentity;
  readonly state: ExecutionEnvironmentState;
  readonly rotationReason: ExecutionEnvironmentRotationReason;
  readonly backendRef: string;
  readonly envelope: ExecutionEnvelope;
  readonly envelopeDigest: string;
  readonly policyDigest: string;
  readonly imageDigest: string;
  readonly runnerDigest: string;
  readonly deadlineAt: string;
  readonly createIntentId: string;
  readonly createDispatchedAt: string | null;
  readonly locator: ExecutionEnvironmentLocator | null;
  readonly stopFence: number;
  readonly stopIntent: ExecutionEnvironmentStopIntent | null;
  readonly releaseReceipt: ExecutionEnvironmentReleaseReceipt | null;
  readonly leases: readonly SandboxWorkspaceClaim[];
  readonly calls: readonly ExecutionEnvironmentCall[];
  readonly reasonCode: string | null;
  readonly createdAt: string;
}

interface Authorized {
  readonly authority: CapabilityInvocationAuthority;
  readonly now: string;
}

export interface ExecutionEnvironmentStorePort {
  reserve(
    input: Authorized & {
      readonly runId: string;
      readonly hostId: string;
      readonly role: ExecutionEnvironmentIdentity["role"];
      readonly rotationReason: ExecutionEnvironmentRotationReason;
      readonly backendRef: string;
      readonly envelope: ExecutionEnvelope;
      readonly policyDigest: string;
      readonly imageDigest: string;
      readonly runnerDigest: string;
      readonly deadlineAt: string;
      readonly leases: readonly SandboxWorkspaceClaim[];
      readonly ids: {
        readonly executionJobId: string;
        readonly environmentId: string;
        readonly createIntentId: string;
      };
    },
  ): Promise<{ readonly record: ExecutionEnvironmentRecord; readonly applied: boolean }>;
  beginCreate(
    input: Authorized & { readonly environmentId: string },
  ): Promise<ExecutionEnvironmentRecord>;
  recordCreated(
    input: Authorized & {
      readonly environmentId: string;
      readonly locator: ExecutionEnvironmentLocator;
    },
  ): Promise<{ readonly record: ExecutionEnvironmentRecord; readonly executable: boolean }>;
  recordCreateUnknown(
    input: Authorized & { readonly environmentId: string; readonly reasonCode: string },
  ): Promise<ExecutionEnvironmentRecord>;
  linkCall(
    input: Authorized & {
      readonly environmentId: string;
      readonly expectedStopFence: number;
      readonly invocationId: string;
      readonly receiptRef: string;
      readonly claims: readonly SandboxWorkspaceClaim[];
    },
  ): Promise<{ readonly record: ExecutionEnvironmentRecord; readonly applied: boolean }>;
  completeCall(
    input: Authorized & { readonly environmentId: string; readonly invocationId: string },
  ): Promise<ExecutionEnvironmentRecord>;
  requestStop(
    input: Authorized & {
      readonly environmentId: string;
      readonly stopIntentId: string;
      readonly reason: ExecutionEnvironmentStopReason;
      readonly stoppedResourceRefs: readonly string[];
    },
  ): Promise<{ readonly record: ExecutionEnvironmentRecord; readonly applied: boolean }>;
  acknowledgeStop(
    input: Authorized & { readonly environmentId: string; readonly stopIntentId: string },
  ): Promise<ExecutionEnvironmentRecord>;
  acceptRelease(
    input: Authorized & {
      readonly environmentId: string;
      readonly proof: ExecutionEnvironmentStopProof | { readonly basis: "create_not_dispatched" };
    },
  ): Promise<{ readonly record: ExecutionEnvironmentRecord; readonly applied: boolean }>;
  read(environmentId: string): Promise<ExecutionEnvironmentRecord | undefined>;
  readRun(runId: string): Promise<
    | {
        readonly executionJobId: string;
        readonly environments: readonly ExecutionEnvironmentRecord[];
      }
    | undefined
  >;
  listUnreleased(input: {
    readonly afterEnvironmentId: string | null;
    readonly limit: number;
  }): Promise<readonly ExecutionEnvironmentRecord[]>;
}
