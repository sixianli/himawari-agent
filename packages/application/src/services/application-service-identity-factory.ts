import {
  createAgent,
  createAgentAuthorityLease,
  createAuthorityHolderId,
  createAuthorityLeaseId,
  createOwner,
  createOwnerId,
  createRunExecutionLeaseId,
} from "@himawari-agent/domain";
import type { ApplicationServiceIdentityFactory } from "../ports/authority-identities.js";

function assertExecutionLeaseRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("expectedLeaseRevision must be a safe integer >= 0");
  }
}

/**
 * Constructs the small set of service-owned identities that cross from the
 * application composition into durable coordination.  This is deliberately
 * a composite factory, rather than a re-export of the whole domain identity
 * module.
 */
export function createApplicationServiceIdentityFactory(): ApplicationServiceIdentityFactory {
  const factory: ApplicationServiceIdentityFactory = {
    createAuthorityLease(input) {
      const owner = createOwner(createOwnerId(input.ownerId));
      const agent = createAgent({ id: input.agentId, owner });
      return createAgentAuthorityLease({
        id: createAuthorityLeaseId(input.leaseId),
        agent,
        holderId: createAuthorityHolderId(input.holderId),
      });
    },
    createExecutionLeaseId(input) {
      assertExecutionLeaseRevision(input.expectedLeaseRevision);
      return createRunExecutionLeaseId(
        `execution:${input.instanceId}:${input.runId}:${input.expectedLeaseRevision}`,
      );
    },
  };
  return Object.freeze(factory);
}
