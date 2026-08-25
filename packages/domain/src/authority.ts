import { DOMAIN_ERROR_CODES, DomainError } from "./errors.js";
import type { Agent } from "./entities.js";
import type { AgentId, AuthorityHolderId, AuthorityLeaseId, OwnerId } from "./identifiers.js";

export interface AgentAuthorityLease {
  readonly id: AuthorityLeaseId;
  readonly agentId: AgentId;
  readonly ownerId: OwnerId;
  readonly holderId: AuthorityHolderId;
}

export function createAgentAuthorityLease(input: {
  readonly id: AuthorityLeaseId;
  readonly agent: Agent;
  readonly holderId: AuthorityHolderId;
}): AgentAuthorityLease {
  return Object.freeze({
    id: input.id,
    agentId: input.agent.id,
    ownerId: input.agent.ownerId,
    holderId: input.holderId,
  });
}

export function claimAgentAuthority(
  current: AgentAuthorityLease | undefined,
  requested: AgentAuthorityLease,
): AgentAuthorityLease {
  if (!current) return requested;

  if (current.agentId !== requested.agentId || current.ownerId !== requested.ownerId) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.AUTHORITY_LEASE_SCOPE_MISMATCH,
      "An Agent authority slot cannot contain a lease for another Agent",
      {
        currentAgentId: current.agentId,
        requestedAgentId: requested.agentId,
      },
    );
  }

  if (current.id === requested.id && current.holderId === requested.holderId) return current;

  throw new DomainError(
    DOMAIN_ERROR_CODES.AUTHORITY_LEASE_CONFLICT,
    `Agent ${current.agentId} already has an active logical authority lease`,
    {
      agentId: current.agentId,
      currentLeaseId: current.id,
      currentHolderId: current.holderId,
      requestedLeaseId: requested.id,
      requestedHolderId: requested.holderId,
    },
  );
}

export function releaseAgentAuthority(
  current: AgentAuthorityLease | undefined,
  leaseId: AuthorityLeaseId,
): undefined {
  if (!current || current.id !== leaseId) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.AUTHORITY_LEASE_NOT_HELD,
      `Authority lease ${leaseId} is not currently held`,
      { leaseId, currentLeaseId: current?.id ?? "" },
    );
  }

  return undefined;
}
