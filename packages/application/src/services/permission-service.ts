import type {
  ActionIntent,
  ApprovalRequest,
  AuthorizationStorePort,
  GrantRecord,
  GrantScope,
  LongTermGrantScope,
  PermissionDecision,
  PermissionPolicy,
  PermissionPolicyRule,
} from "../ports/authorization.js";
import { PORT_ERROR_CODES, ApplicationPortError } from "../ports/common.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";

const CLASSIFICATION_RANK = Object.freeze({
  public: 0,
  private: 1,
  sensitive: 2,
  restricted: 3,
});

function deepFreeze<TValue>(value: TValue): TValue {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function frozenIntent(intent: ActionIntent): ActionIntent {
  return deepFreeze(structuredClone(intent));
}

function fnv1a(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hash = 2_166_136_261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return `intent-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function actionIntentFingerprint(intent: ActionIntent): string {
  return fnv1a(
    JSON.stringify({
      id: intent.id,
      ownerId: intent.ownerId,
      agentId: intent.agentId,
      runId: intent.runId,
      capabilityRef: intent.capabilityRef,
      operation: intent.operation,
      resourceRef: intent.resourceRef,
      dataClassification: intent.dataClassification,
      sideEffect: intent.sideEffect,
      estimatedCostMicros: intent.estimatedCostMicros,
      frequency: intent.frequency,
      idempotencyKey: intent.idempotencyKey,
      reversible: intent.reversible,
      requestedAt: intent.requestedAt,
    }),
  );
}

function matchesRule(rule: PermissionPolicyRule, intent: ActionIntent): boolean {
  return (
    rule.capabilityRefs.includes(intent.capabilityRef) &&
    rule.operations.includes(intent.operation) &&
    rule.resourcePrefixes.some((prefix) => intent.resourceRef.startsWith(prefix)) &&
    rule.dataClassifications.includes(intent.dataClassification) &&
    rule.sideEffects.includes(intent.sideEffect) &&
    intent.estimatedCostMicros <= rule.maxCostMicros
  );
}

function exactScope(intent: ActionIntent): GrantScope {
  return Object.freeze({
    capabilityRef: intent.capabilityRef,
    operations: Object.freeze([intent.operation]),
    exactResourceRef: intent.resourceRef,
    resourcePrefixes: Object.freeze([]),
    maxDataClassification: intent.dataClassification,
    sideEffects: Object.freeze([intent.sideEffect]),
    maxCostMicrosPerUse: intent.estimatedCostMicros,
    maxFrequency: Object.freeze({ ...intent.frequency }),
  });
}

function longTermScope(scope: LongTermGrantScope): GrantScope {
  return Object.freeze({
    capabilityRef: scope.capabilityRef,
    operations: Object.freeze([...scope.operations]),
    exactResourceRef: null,
    resourcePrefixes: Object.freeze([...scope.resourcePrefixes]),
    maxDataClassification: scope.maxDataClassification,
    sideEffects: Object.freeze([...scope.sideEffects]),
    maxCostMicrosPerUse: scope.maxCostMicrosPerUse,
    maxFrequency: Object.freeze({ ...scope.maxFrequency }),
  });
}

function frequencyWithinScope(intent: ActionIntent, scope: GrantScope): boolean {
  if (intent.frequency.count > scope.maxFrequency.count) return false;
  if (intent.frequency.intervalMs === null) return true;
  return (
    scope.maxFrequency.intervalMs !== null &&
    intent.frequency.intervalMs >= scope.maxFrequency.intervalMs
  );
}

export function grantCoversIntent(grant: GrantRecord, intent: ActionIntent, now: string): boolean {
  const scope = grant.scope;
  const resourceMatches =
    scope.exactResourceRef === intent.resourceRef ||
    scope.resourcePrefixes.some((prefix) => intent.resourceRef.startsWith(prefix));
  return (
    grant.ownerId === intent.ownerId &&
    grant.agentId === intent.agentId &&
    grant.revokedAt === null &&
    now >= grant.validFrom &&
    now < grant.expiresAt &&
    grant.uses < grant.maxUses &&
    grant.spentCostMicros + intent.estimatedCostMicros <= grant.maxTotalCostMicros &&
    scope.capabilityRef === intent.capabilityRef &&
    scope.operations.includes(intent.operation) &&
    resourceMatches &&
    CLASSIFICATION_RANK[intent.dataClassification] <=
      CLASSIFICATION_RANK[scope.maxDataClassification] &&
    scope.sideEffects.includes(intent.sideEffect) &&
    intent.estimatedCostMicros <= scope.maxCostMicrosPerUse &&
    frequencyWithinScope(intent, scope) &&
    (grant.intentFingerprint === null ||
      grant.intentFingerprint === actionIntentFingerprint(intent))
  );
}

export interface PermissionServiceDependencies {
  readonly store: AuthorizationStorePort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly policy: PermissionPolicy;
}

export interface PermissionEvaluationOptions {
  readonly uiAvailable: boolean;
  readonly approvalExpiresAt: string;
}

export type ApprovalResponseInput =
  | {
      readonly approvalRequestId: string;
      readonly semanticSnapshotHash: string;
      readonly decision: "denied";
    }
  | {
      readonly approvalRequestId: string;
      readonly semanticSnapshotHash: string;
      readonly decision: "approved";
      readonly grantKind: "one_time";
    }
  | {
      readonly approvalRequestId: string;
      readonly semanticSnapshotHash: string;
      readonly decision: "approved";
      readonly grantKind: "long_term";
      readonly longTermScope: LongTermGrantScope;
    };

export class PermissionService {
  private readonly dependencies: PermissionServiceDependencies;

  constructor(dependencies: PermissionServiceDependencies) {
    this.dependencies = dependencies;
  }

  async evaluate(
    sourceIntent: ActionIntent,
    options: PermissionEvaluationOptions,
  ): Promise<PermissionDecision> {
    const intent = frozenIntent(sourceIntent);
    const now = this.dependencies.clock.now();

    try {
      const grants = await this.dependencies.store.listGrants(intent.ownerId, intent.agentId);
      for (const grant of grants) {
        if (!grantCoversIntent(grant, intent, now)) continue;
        const consumed = await this.dependencies.store.consumeGrant({
          grantId: grant.id,
          expectedRevision: grant.revision,
          costMicros: intent.estimatedCostMicros,
          consumedAt: now,
        });
        return Object.freeze({
          decision: "ALLOW",
          basis: Object.freeze({ type: "grant", ref: consumed.id }),
          executionScope: consumed.scope,
        });
      }

      const denied = this.dependencies.policy.rules.find(
        (rule) => rule.effect === "DENY" && matchesRule(rule, intent),
      );
      if (denied) return this.deny(denied.reasonCode, false);

      const allowed = this.dependencies.policy.rules.find(
        (rule) => rule.effect === "ALLOW" && matchesRule(rule, intent),
      );
      if (allowed) {
        return Object.freeze({
          decision: "ALLOW",
          basis: Object.freeze({ type: "policy", ref: allowed.id }),
          executionScope: exactScope(intent),
        });
      }

      const existing = await this.dependencies.store.findApprovalByIntent(intent.id);
      if (existing?.status === "pending") {
        if (now >= existing.expiresAt) {
          await this.expire(existing);
          return this.deny("approval_expired", true);
        }
        return Object.freeze({ decision: "ASK", approvalRequest: existing });
      }
      if (existing?.status === "expired") return this.deny("approval_expired", true);
      if (existing?.status === "denied") return this.deny("approval_denied", true);

      if (options.approvalExpiresAt <= now) {
        return this.deny("approval_expiry_invalid", true);
      }
      const approvalRequest = await this.dependencies.store.createApproval({
        id: this.dependencies.ids.next("approval"),
        revision: 1,
        ownerId: intent.ownerId,
        agentId: intent.agentId,
        runId: intent.runId,
        intentId: intent.id,
        intentSnapshot: intent,
        semanticSnapshotHash: actionIntentFingerprint(intent),
        status: "pending",
        deliveryState: options.uiAvailable ? "deliverable" : "queued_no_ui",
        requestedAt: now,
        expiresAt: options.approvalExpiresAt,
        decidedAt: null,
        grantId: null,
      });
      return Object.freeze({ decision: "ASK", approvalRequest });
    } catch {
      return this.deny("permission_component_error", false);
    }
  }

  async respond(input: ApprovalResponseInput): Promise<ApprovalRequest> {
    const current = await this.requireApproval(input.approvalRequestId);
    const now = this.dependencies.clock.now();
    if (current.status !== "pending") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Approval ${current.id} is already ${current.status}`,
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
    if (now >= current.expiresAt) return this.expire(current);

    if (input.decision === "denied") {
      return this.dependencies.store.resolveApproval({
        approvalRequestId: current.id,
        expectedRevision: current.revision,
        semanticSnapshotHash: input.semanticSnapshotHash,
        resolution: "denied",
        decidedAt: now,
        grant: null,
      });
    }

    const grant = this.createGrant(current, input, now);
    if (!grantCoversIntent(grant, current.intentSnapshot, now)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Grant scope does not cover approval ${current.id}`,
        { approvalRequestId: current.id },
      );
    }
    return this.dependencies.store.resolveApproval({
      approvalRequestId: current.id,
      expectedRevision: current.revision,
      semanticSnapshotHash: input.semanticSnapshotHash,
      resolution: "approved",
      decidedAt: now,
      grant,
    });
  }

  async resume(approvalRequestId: string): Promise<ApprovalRequest> {
    const current = await this.requireApproval(approvalRequestId);
    if (current.status === "pending" && this.dependencies.clock.now() >= current.expiresAt) {
      return this.expire(current);
    }
    return current;
  }

  async revokeGrant(grantId: string, reasonCode: string): Promise<GrantRecord> {
    return this.dependencies.store.revokeGrant(grantId, this.dependencies.clock.now(), reasonCode);
  }

  private createGrant(
    approval: ApprovalRequest,
    input: Extract<ApprovalResponseInput, { decision: "approved" }>,
    now: string,
  ): GrantRecord {
    const oneTime = input.grantKind === "one_time";
    const scope = oneTime
      ? exactScope(approval.intentSnapshot)
      : longTermScope(input.longTermScope);
    const expiresAt = oneTime ? approval.expiresAt : input.longTermScope.expiresAt;
    const maxUses = oneTime ? 1 : input.longTermScope.maxUses;
    const maxTotalCostMicros = oneTime
      ? approval.intentSnapshot.estimatedCostMicros
      : input.longTermScope.maxTotalCostMicros;
    if (expiresAt <= now || maxUses < 1 || maxTotalCostMicros < 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Grant lifetime and budgets must be positive",
        { approvalRequestId: approval.id },
      );
    }
    return deepFreeze({
      id: this.dependencies.ids.next("grant"),
      revision: 1,
      ownerId: approval.ownerId,
      agentId: approval.agentId,
      kind: input.grantKind,
      scope,
      intentFingerprint: oneTime ? actionIntentFingerprint(approval.intentSnapshot) : null,
      sourceApprovalRequestId: approval.id,
      validFrom: now,
      expiresAt,
      maxUses,
      uses: 0,
      maxTotalCostMicros,
      spentCostMicros: 0,
      revokedAt: null,
      revocationReasonCode: null,
    });
  }

  private async expire(current: ApprovalRequest): Promise<ApprovalRequest> {
    return this.dependencies.store.resolveApproval({
      approvalRequestId: current.id,
      expectedRevision: current.revision,
      semanticSnapshotHash: current.semanticSnapshotHash,
      resolution: "expired",
      decidedAt: this.dependencies.clock.now(),
      grant: null,
    });
  }

  private async requireApproval(approvalRequestId: string): Promise<ApprovalRequest> {
    const approval = await this.dependencies.store.getApproval(approvalRequestId);
    if (!approval) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Approval ${approvalRequestId} not found`,
        { approvalRequestId },
      );
    }
    return approval;
  }

  private deny(reasonCode: string, alternativesAllowed: boolean): PermissionDecision {
    return Object.freeze({ decision: "DENY", reasonCode, alternativesAllowed });
  }
}
