import type {
  AgentAuthorityLease,
  AgentId,
  AuthorityHolderId,
  AuthorityLeaseId,
  DeploymentAuthorityState,
  DeploymentId,
  OwnerId,
  ProductAuthorityFence,
  RunExecutionLeaseId,
  RunId,
} from "@himawari-agent/domain";

/**
 * The narrow identity boundary shared by a service composition root and its
 * durable adapters.  Domain validation and composite lease construction stay
 * in application; host code supplies only entropy and already-branded
 * product scope.
 */
export interface ApplicationServiceIdentityFactory {
  createAuthorityLease(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly leaseId: string;
    readonly holderId: string;
  }): AgentAuthorityLease;
  createExecutionLeaseId(input: {
    readonly instanceId: string;
    readonly runId: RunId;
    readonly expectedLeaseRevision: number;
  }): RunExecutionLeaseId;
}

export type {
  AgentAuthorityLease,
  AgentId,
  AuthorityHolderId,
  AuthorityLeaseId,
  DeploymentAuthorityState,
  DeploymentId,
  OwnerId,
  ProductAuthorityFence,
  RunExecutionLeaseId,
  RunId,
};
