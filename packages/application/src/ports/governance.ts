import type { AgentId, OwnerId } from "@himawari-agent/domain";

export interface GovernanceMutationReceipt {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly idempotencyKey: string;
  readonly revision: number;
  readonly commandType: string;
  readonly semanticFingerprint: string;
  readonly phase: "executing" | "completed";
  readonly resultRef: string | null;
  readonly startedAt: string;
  readonly committedAt: string | null;
}

/**
 * Durable receipt boundary for Owner governance commands. Business state remains
 * authoritative; an executing receipt lets a retry reconcile a crash between
 * the domain mutation and receipt completion without accepting a different
 * command under the same idempotency key.
 */
export interface GovernanceMutationReceiptStorePort {
  get(
    ownerId: OwnerId,
    agentId: AgentId,
    idempotencyKey: string,
  ): Promise<GovernanceMutationReceipt | undefined>;
  create(receipt: GovernanceMutationReceipt): Promise<GovernanceMutationReceipt>;
  complete(
    receipt: GovernanceMutationReceipt,
    expectedRevision: number,
  ): Promise<GovernanceMutationReceipt>;
}

export interface GovernanceDependencyReadPort {
  listTaskRefsByCapability(capabilityRef: string): Promise<readonly string[]>;
  listTaskRefsByGrant(grantId: string): Promise<readonly string[]>;
  trueResultRefForApproval(approvalRequestId: string): Promise<string | null>;
}
