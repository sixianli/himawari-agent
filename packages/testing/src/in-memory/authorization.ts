import type {
  ApprovalRequest,
  AuthorizationStorePort,
  ConsumeGrantInput,
  GrantRecord,
  ResolveApprovalInput,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES, ApplicationPortError } from "@himawari-agent/application";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import { type FailureScheduler, NO_FAILURES } from "../deterministic.js";
import { frozenCopy } from "./helpers.js";

export class InMemoryAuthorizationStore implements AuthorizationStorePort {
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly grants = new Map<string, GrantRecord>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async createApproval(request: ApprovalRequest): Promise<ApprovalRequest> {
    this.failures.checkpoint("authorization.createApproval");
    if (this.approvals.has(request.id)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Approval ${request.id} already exists`,
        { approvalRequestId: request.id },
      );
    }
    this.approvals.set(request.id, frozenCopy(request));
    return frozenCopy(request);
  }

  async findApprovalByIntent(intentId: string): Promise<ApprovalRequest | undefined> {
    this.failures.checkpoint("authorization.findApprovalByIntent");
    const matches = [...this.approvals.values()].filter(
      (approval) => approval.intentId === intentId,
    );
    const latest = matches.at(-1);
    return latest ? frozenCopy(latest) : undefined;
  }

  async getApproval(approvalRequestId: string): Promise<ApprovalRequest | undefined> {
    this.failures.checkpoint("authorization.getApproval");
    const approval = this.approvals.get(approvalRequestId);
    return approval ? frozenCopy(approval) : undefined;
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<ApprovalRequest> {
    this.failures.checkpoint("authorization.resolveApproval");
    const current = this.approvals.get(input.approvalRequestId);
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Approval ${input.approvalRequestId} not found`,
        { approvalRequestId: input.approvalRequestId },
      );
    }
    if (current.revision !== input.expectedRevision || current.status !== "pending") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Approval ${current.id} cannot be resolved from its current revision`,
        { approvalRequestId: current.id, status: current.status },
      );
    }
    if (current.semanticSnapshotHash !== input.semanticSnapshotHash) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Approval ${current.id} semantic snapshot changed`,
        { approvalRequestId: current.id },
      );
    }
    if ((input.resolution === "approved") !== (input.grant !== null)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Approved resolutions require exactly one Grant",
        { approvalRequestId: current.id },
      );
    }
    if (input.grant && this.grants.has(input.grant.id)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Grant ${input.grant.id} already exists`,
        { grantId: input.grant.id },
      );
    }

    const resolved = frozenCopy({
      ...current,
      revision: current.revision + 1,
      status: input.resolution,
      decidedAt: input.decidedAt,
      grantId: input.grant?.id ?? null,
    });
    if (input.grant) this.grants.set(input.grant.id, frozenCopy(input.grant));
    this.approvals.set(current.id, resolved);
    return frozenCopy(resolved);
  }

  async listGrants(ownerId: OwnerId, agentId: AgentId): Promise<readonly GrantRecord[]> {
    this.failures.checkpoint("authorization.listGrants");
    return [...this.grants.values()]
      .filter((grant) => grant.ownerId === ownerId && grant.agentId === agentId)
      .map(frozenCopy);
  }

  async consumeGrant(input: ConsumeGrantInput): Promise<GrantRecord> {
    this.failures.checkpoint("authorization.consumeGrant");
    const current = this.grants.get(input.grantId);
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Grant ${input.grantId} not found`,
        { grantId: input.grantId },
      );
    }
    if (current.revision !== input.expectedRevision) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Grant ${current.id} has a stale revision`,
        { grantId: current.id },
      );
    }
    if (
      current.revokedAt !== null ||
      input.consumedAt < current.validFrom ||
      input.consumedAt >= current.expiresAt ||
      current.uses >= current.maxUses ||
      current.spentCostMicros + input.costMicros > current.maxTotalCostMicros
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Grant ${current.id} is not consumable`,
        { grantId: current.id },
      );
    }
    const consumed = frozenCopy({
      ...current,
      revision: current.revision + 1,
      uses: current.uses + 1,
      spentCostMicros: current.spentCostMicros + input.costMicros,
    });
    this.grants.set(current.id, consumed);
    return frozenCopy(consumed);
  }

  async revokeGrant(grantId: string, revokedAt: string, reasonCode: string): Promise<GrantRecord> {
    this.failures.checkpoint("authorization.revokeGrant");
    const current = this.grants.get(grantId);
    if (!current) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `Grant ${grantId} not found`, {
        grantId,
      });
    }
    if (current.revokedAt !== null) return frozenCopy(current);
    const revoked = frozenCopy({
      ...current,
      revision: current.revision + 1,
      revokedAt,
      revocationReasonCode: reasonCode,
    });
    this.grants.set(grantId, revoked);
    return frozenCopy(revoked);
  }
}
