import type {
  AuthorizationStorePort,
  GovernedActionIntent,
  GovernedApprovalRequest,
  GovernedGrantRecord,
} from "../ports/authorization.js";
import { ApplicationPortError, PORT_ERROR_CODES, type PortErrorCode } from "../ports/common.js";
import type { ClockPort } from "../ports/system.js";
import { grantCoversIntent } from "./permission-service.js";
import { actionIntentFingerprintMatches } from "./action-intent-snapshot.js";

export type GovernedApprovalResponse =
  | { readonly decision: "denied" }
  | {
      readonly decision: "approved";
      readonly grant: GovernedGrantRecord;
      readonly recentAuthenticationRef: string | null;
    };

export class ApprovalService {
  private readonly dependencies: {
    readonly store: AuthorizationStorePort;
    readonly clock: ClockPort;
  };

  constructor(dependencies: { readonly store: AuthorizationStorePort; readonly clock: ClockPort }) {
    this.dependencies = dependencies;
  }

  async respond(input: {
    readonly approvalRequestId: string;
    readonly expectedRevision: number;
    readonly semanticSnapshotHash: string;
    readonly response: GovernedApprovalResponse;
  }): Promise<GovernedApprovalRequest> {
    const current = (await this.dependencies.store.getApproval(input.approvalRequestId)) as
      | GovernedApprovalRequest
      | undefined;
    if (!current) this.fail(PORT_ERROR_CODES.NOT_FOUND, "Approval not found");
    if (
      current.semanticSnapshotHash !== input.semanticSnapshotHash ||
      !actionIntentFingerprintMatches(current.intentSnapshot, input.semanticSnapshotHash)
    )
      this.fail(PORT_ERROR_CODES.CONFLICT, "Approval semantic snapshot hash changed");
    // Store arbitration also covers concurrent replies that read the same pending revision.
    if (current.status !== "pending") {
      return this.dependencies.store.resolveApproval({
        approvalRequestId: current.id,
        expectedRevision: input.expectedRevision,
        semanticSnapshotHash: input.semanticSnapshotHash,
        resolution: input.response.decision,
        decidedAt: this.dependencies.clock.now(),
        grant: input.response.decision === "approved" ? input.response.grant : null,
        recentAuthenticationRef:
          input.response.decision === "approved" ? input.response.recentAuthenticationRef : null,
      }) as Promise<GovernedApprovalRequest>;
    }
    if (current.revision !== input.expectedRevision)
      this.fail(PORT_ERROR_CODES.CONFLICT, "Approval response is stale");
    const now = this.dependencies.clock.now();
    if (now >= current.expiresAt) {
      return this.dependencies.store.resolveApproval({
        approvalRequestId: current.id,
        expectedRevision: current.revision,
        semanticSnapshotHash: current.semanticSnapshotHash,
        resolution: "expired",
        decidedAt: now,
        grant: null,
      }) as Promise<GovernedApprovalRequest>;
    }
    if (
      input.response.decision === "approved" &&
      current.recentAuthenticationRequired &&
      !input.response.recentAuthenticationRef
    )
      this.fail(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "Recent Owner authentication is required");
    if (input.response.decision === "approved") {
      this.assertGrantDoesNotExpand(current.intentSnapshot, input.response.grant);
      if (
        input.response.grant.sourceApprovalRequestId !== current.id ||
        input.response.grant.validFrom > now ||
        input.response.grant.expiresAt <= now ||
        input.response.grant.uses !== 0 ||
        input.response.grant.spentCostMicros !== 0 ||
        input.response.grant.revokedAt !== null ||
        input.response.grant.revision !== 1 ||
        (input.response.grant.kind === "one_time" &&
          (input.response.grant.maxUses !== 1 ||
            input.response.grant.expiresAt > current.expiresAt ||
            input.response.grant.expiresAt > current.intentSnapshot.expiresAt ||
            input.response.grant.intentFingerprint === null ||
            !actionIntentFingerprintMatches(
              current.intentSnapshot,
              input.response.grant.intentFingerprint,
            )))
      ) {
        this.fail(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "Grant does not match this approval lifetime or identity",
        );
      }
    }
    return this.dependencies.store.resolveApproval({
      approvalRequestId: current.id,
      expectedRevision: current.revision,
      semanticSnapshotHash: current.semanticSnapshotHash,
      resolution: input.response.decision,
      decidedAt: now,
      grant: input.response.decision === "approved" ? input.response.grant : null,
      recentAuthenticationRef:
        input.response.decision === "approved" ? input.response.recentAuthenticationRef : null,
    }) as Promise<GovernedApprovalRequest>;
  }

  private assertGrantDoesNotExpand(intent: GovernedActionIntent, grant: GovernedGrantRecord): void {
    const scope = grant.scope;
    if (
      grant.ownerId !== intent.ownerId ||
      grant.agentId !== intent.agentId ||
      scope.capabilityRef !== intent.capabilityRef ||
      scope.capabilityVersion !== intent.capabilityVersion ||
      scope.operations.some((operation) => operation !== intent.operation) ||
      scope.resourcePrefixes.length > 0 ||
      scope.resourceIdentities.some((ref) => !intent.resourceRefs.includes(ref)) ||
      scope.recipients.some((recipient) => !intent.recipients.includes(recipient)) ||
      scope.maxCostMicrosPerUse > intent.estimatedCostMicros ||
      scope.maxDataClassification !== intent.dataClassification ||
      scope.disclosure !== intent.disclosure ||
      scope.sideEffects.some((effect) => effect !== intent.sideEffect) ||
      scope.maxFrequency.count > intent.frequency.count ||
      (intent.frequency.intervalMs !== null &&
        (scope.maxFrequency.intervalMs === null ||
          scope.maxFrequency.intervalMs < intent.frequency.intervalMs)) ||
      !grantCoversIntent(grant, intent, this.dependencies.clock.now())
    )
      this.fail(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Approval response expands or changes intent scope",
      );
  }

  private fail(code: PortErrorCode, message: string): never {
    throw new ApplicationPortError(code, message);
  }
}
