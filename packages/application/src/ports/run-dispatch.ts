import type {
  AgentId,
  AuthorityLeaseId,
  OwnerId,
  ProductAuthorityFence,
  RunExecutionLeaseId,
  RunId,
  RunStatus,
  SessionId,
  ThreadId,
  TriggerId,
} from "@himawari-agent/domain";
import type { AuthorityFence } from "./persistence.js";
import type { RunCheckpointPhase } from "./run-checkpoints.js";

export type { RunExecutionLeaseId } from "@himawari-agent/domain";

export interface RunDispatchScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly authority: ProductAuthorityFence;
  readonly authorityLease: AuthorityFence;
  readonly consumerId: string;
}

interface RunDispatchRecord {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly triggerId: TriggerId;
  readonly threadId: ThreadId | null;
  readonly runRevision: number;
  readonly runStatus: RunStatus;
  readonly checkpointPhase: RunCheckpointPhase | null;
  readonly leaseRevision: number;
}

export type RunDispatchAction = "start" | "resume";

export interface RunDispatchCandidate extends RunDispatchRecord {
  readonly action: RunDispatchAction;
}

export interface RunReconciliationCandidate extends RunDispatchRecord {
  readonly action: "reconcile";
}

export interface RunExecutionLease {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly authorityLeaseId: AuthorityLeaseId;
  readonly deploymentId: ProductAuthorityFence["deploymentId"];
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly consumerId: string;
  readonly executionLeaseId: RunExecutionLeaseId;
  readonly revision: number;
  readonly claimedAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
}

export interface RunExecutionLeaseReceipt extends RunExecutionLease {
  readonly replayed: boolean;
}

export interface RunExecutionLeaseClaim {
  readonly executionLeaseId: RunExecutionLeaseId;
  readonly expectedLeaseRevision: number;
  readonly authorityLeaseId: AuthorityLeaseId;
  readonly authorityFencingToken: number;
  readonly deploymentId: ProductAuthorityFence["deploymentId"];
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  /** Trusted consumer identity captured by the dispatch factory. */
  readonly consumerId: string;
}

export function claimFromRunExecutionLease(lease: RunExecutionLease): RunExecutionLeaseClaim {
  if (lease.releasedAt !== null)
    throw new TypeError("Cannot claim from a released execution lease");
  return Object.freeze({
    executionLeaseId: lease.executionLeaseId,
    expectedLeaseRevision: lease.revision,
    authorityLeaseId: lease.authorityLeaseId,
    authorityFencingToken: lease.fencingToken,
    deploymentId: lease.deploymentId,
    authorityEpoch: lease.authorityEpoch,
    fencingToken: lease.fencingToken,
    consumerId: lease.consumerId,
  });
}

/**
 * Synchronous guard used by a SQLite writer that already owns its transaction.
 * It deliberately has no Promise-returning methods: checking in one RPC and
 * writing in another transaction would reintroduce a lease TOCTOU window.
 */
export interface RunExecutionLeaseTransactionGuard {
  assertHeldInTransaction(input: {
    readonly runId: RunId;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: RunExecutionLeaseId;
    readonly at: string;
  }): RunExecutionLease;
  invalidateForOwnerCancellationInTransaction(input: {
    readonly runId: RunId;
    readonly at: string;
  }): RunExecutionLease | null;
}

export interface RunDispatchPort {
  listClaimable(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly RunDispatchCandidate[]>;
  listReconciliationRequired(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly RunReconciliationCandidate[]>;
  claim(input: {
    readonly runId: RunId;
    readonly expectedRunRevision: number;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: RunExecutionLeaseId;
    readonly claimedAt: string;
    readonly expiresAt: string;
  }): Promise<RunExecutionLeaseReceipt>;
  renew(input: {
    readonly runId: RunId;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: RunExecutionLeaseId;
    readonly renewedAt: string;
    readonly expiresAt: string;
  }): Promise<RunExecutionLeaseReceipt>;
  release(input: {
    readonly runId: RunId;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: RunExecutionLeaseId;
    readonly releasedAt: string;
  }): Promise<RunExecutionLeaseReceipt>;
  assertHeld(input: {
    readonly runId: RunId;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId: RunExecutionLeaseId;
    readonly at: string;
  }): Promise<RunExecutionLease>;
}

/** Recovery can quarantine uncertain work, but cannot grant permission to execute it. */
export interface RunReconciliationPort {
  quarantine(input: {
    readonly runId: RunId;
    readonly expectedRunRevision: number;
    readonly expectedLeaseRevision: number;
    readonly executionLeaseId?: RunExecutionLeaseId;
    readonly reasonCode: string;
    readonly at: string;
  }): Promise<void>;
}
