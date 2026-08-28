import type {
  ActionKind,
  ActionRiskLevel,
  ApprovalRequest,
  AuthorizationStorePort,
  GovernedActionIntent,
  GovernedApprovalRequest,
  GovernedGrantRecord,
  PermissionDecision,
  PermissionPolicy,
} from "../ports/authorization.js";
import { ACTION_KINDS, ACTION_RISK_LEVELS } from "../ports/authorization.js";
import type { CapabilityManifest, CapabilityRegistryLifecycle } from "../ports/capabilities.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import { actionIntentFingerprint, grantCoversIntent } from "./permission-service.js";

const RISK_RANK: Readonly<Record<ActionRiskLevel, number>> = Object.freeze({
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
});

export const ACTION_KIND_RISK_BASELINE: Readonly<Record<ActionKind, ActionRiskLevel>> =
  Object.freeze({
    READ: "LOW",
    CREATE_OR_UPDATE: "MEDIUM",
    DELETE: "HIGH",
    COMMUNICATE: "HIGH",
    PURCHASE_OR_FUNDS: "CRITICAL",
    CREDENTIAL_OR_ACCESS: "CRITICAL",
    PRODUCTION_OR_RECOVERY: "CRITICAL",
    PUBLICATION: "CRITICAL",
    LEGAL_COMMITMENT: "CRITICAL",
    PHYSICAL_SAFETY: "CRITICAL",
    INSTALL_OR_EXECUTE_CODE: "HIGH",
  });

function highestRisk(risks: readonly ActionRiskLevel[]): ActionRiskLevel {
  return risks.reduce((highest, current) =>
    RISK_RANK[current] > RISK_RANK[highest] ? current : highest,
  );
}

export function computeActionRisk(intent: GovernedActionIntent): ActionRiskLevel {
  const facts = intent.deterministicFacts.map(({ minimumRisk }) => minimumRisk);
  if (intent.actionKind === "DELETE" && !intent.reversible) facts.push("CRITICAL");
  if (intent.credentialOrAccessChange) facts.push("CRITICAL");
  if (intent.disclosure === "public") facts.push("CRITICAL");
  return highestRisk([
    ACTION_KIND_RISK_BASELINE[intent.actionKind],
    intent.modelClassification.suggestedRisk,
    ...facts,
  ]);
}

function requiredText(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, `${name} is required`);
  }
}

export function validateGovernedActionIntent(intent: GovernedActionIntent): void {
  const expectedKeys = new Set([
    "id",
    "ownerId",
    "agentId",
    "runId",
    "capabilityRef",
    "operation",
    "resourceRef",
    "dataClassification",
    "sideEffect",
    "estimatedCostMicros",
    "frequency",
    "idempotencyKey",
    "reversible",
    "requestedAt",
    "contractVersion",
    "threadId",
    "actionKind",
    "capabilityVersion",
    "targets",
    "resourceRefs",
    "disclosure",
    "recipients",
    "credentialOrAccessChange",
    "expiresAt",
    "modelClassification",
    "deterministicFacts",
    "finalRisk",
  ]);
  const kind = intent.actionKind as string;
  const modelKind = intent.modelClassification.actionKind as string;
  const suggestedRisk = intent.modelClassification.suggestedRisk as string;
  if (
    intent.contractVersion !== "authorization.v2" ||
    !ACTION_KINDS.includes(kind as ActionKind) ||
    !ACTION_KINDS.includes(modelKind as ActionKind) ||
    !ACTION_RISK_LEVELS.includes(suggestedRisk as ActionRiskLevel)
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "ActionIntent contains an unknown contract, kind, or risk",
    );
  }
  if (Object.keys(intent).some((key) => !expectedKeys.has(key))) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "ActionIntent contains undeclared semantic parameters",
      { intentId: intent.id },
    );
  }
  for (const [name, value] of [
    ["intent id", intent.id],
    ["thread id", intent.threadId],
    ["capability ref", intent.capabilityRef],
    ["capability version", intent.capabilityVersion],
    ["operation", intent.operation],
    ["resource ref", intent.resourceRef],
    ["idempotency key", intent.idempotencyKey],
    ["classification reason", intent.modelClassification.reasonCode],
  ] as const)
    requiredText(value, name);
  if (
    intent.targets.length === 0 ||
    intent.resourceRefs.length === 0 ||
    !intent.resourceRefs.includes(intent.resourceRef) ||
    intent.targets.some(({ type, ref }) => !type || !ref) ||
    new Set(intent.resourceRefs).size !== intent.resourceRefs.length ||
    new Set(intent.recipients).size !== intent.recipients.length ||
    intent.frequency.count < 1 ||
    (intent.frequency.intervalMs !== null && intent.frequency.intervalMs < 1) ||
    intent.estimatedCostMicros < 0 ||
    intent.expiresAt <= intent.requestedAt
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "ActionIntent is incomplete or internally inconsistent",
      { intentId: intent.id },
    );
  }
  if (intent.modelClassification.actionKind !== intent.actionKind) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Model classification does not match the fixed action kind",
      { intentId: intent.id },
    );
  }
  if (computeActionRisk(intent) !== intent.finalRisk) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      "Model-provided risk cannot lower the deterministic risk floor",
      { intentId: intent.id },
    );
  }
}

export function freezeGovernedActionIntent(intent: GovernedActionIntent): GovernedActionIntent {
  validateGovernedActionIntent(intent);
  const copy = structuredClone(intent);
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      for (const nested of Object.values(value)) freeze(nested);
      Object.freeze(value);
    }
  };
  freeze(copy);
  return copy;
}

export interface ActionIntentClarification {
  readonly complete: false;
  readonly missingFields: readonly string[];
}

export function assessActionIntentCompleteness(
  candidate: Partial<GovernedActionIntent>,
): { readonly complete: true; readonly intent: GovernedActionIntent } | ActionIntentClarification {
  const missing: string[] = [];
  for (const field of [
    "targets",
    "resourceRefs",
    "capabilityRef",
    "capabilityVersion",
    "operation",
    "frequency",
    "estimatedCostMicros",
    "disclosure",
    "recipients",
  ] as const) {
    const value = candidate[field];
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0 && field !== "recipients")
    ) {
      missing.push(field);
    }
  }
  if (missing.length > 0)
    return Object.freeze({ complete: false, missingFields: Object.freeze(missing) });
  try {
    return Object.freeze({
      complete: true,
      intent: freezeGovernedActionIntent(candidate as GovernedActionIntent),
    });
  } catch {
    return Object.freeze({ complete: false, missingFields: Object.freeze(["invalid_semantics"]) });
  }
}

export interface CapabilityAuthorizationFacts {
  readonly lifecycle: CapabilityRegistryLifecycle;
  readonly manifest: CapabilityManifest;
}

export interface CapabilityAuthorizationFactsPort {
  inspect(capabilityRef: string): Promise<CapabilityAuthorizationFacts | undefined>;
}

export interface AuthorizationDecisionTracePort {
  record(input: {
    readonly intentId: string;
    readonly policyVersion: string;
    readonly facts: readonly string[];
    readonly modelRisk: ActionRiskLevel;
    readonly finalRisk: ActionRiskLevel;
    readonly decision: "ALLOW" | "ASK" | "DENY";
    readonly reasonCode: string;
    readonly occurredAt: string;
  }): Promise<void>;
}

export interface ActionPolicyServiceDependencies {
  readonly store: AuthorizationStorePort;
  readonly capabilities: CapabilityAuthorizationFactsPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly policy: PermissionPolicy;
  readonly trace?: AuthorizationDecisionTracePort;
}

export class ActionPolicyService {
  private readonly dependencies: ActionPolicyServiceDependencies;

  constructor(dependencies: ActionPolicyServiceDependencies) {
    this.dependencies = dependencies;
  }

  async evaluate(
    source: GovernedActionIntent,
    options: { readonly uiAvailable: boolean; readonly approvalExpiresAt: string },
  ): Promise<PermissionDecision> {
    let intent: GovernedActionIntent;
    try {
      intent = freezeGovernedActionIntent(source);
      const now = this.dependencies.clock.now();
      const capability = await this.dependencies.capabilities.inspect(intent.capabilityRef);
      const denial = this.capabilityDenial(capability, intent);
      if (denial) return this.finish(intent, "DENY", denial, now, false);

      const deniedRule = this.dependencies.policy.rules.find(
        (rule) =>
          rule.effect === "DENY" &&
          rule.capabilityRefs.includes(intent.capabilityRef) &&
          rule.operations.includes(intent.operation) &&
          rule.resourcePrefixes.some((prefix) =>
            intent.resourceRefs.every((ref) => ref.startsWith(prefix)),
          ),
      );
      if (deniedRule) return this.finish(intent, "DENY", deniedRule.reasonCode, now, false);

      const grants = await this.dependencies.store.listGrants(intent.ownerId, intent.agentId);
      for (const candidate of grants) {
        const grant = candidate as GovernedGrantRecord;
        if (!this.governedGrantCovers(grant, intent, now)) continue;
        const consumed = await this.dependencies.store.consumeGrant({
          grantId: grant.id,
          expectedRevision: grant.revision,
          costMicros: intent.estimatedCostMicros,
          consumedAt: now,
          usageId: `authorization-usage:${intent.id}`,
          runId: intent.runId,
          operation: intent.operation,
        });
        await this.trace(intent, "ALLOW", "grant", now);
        return Object.freeze({
          decision: "ALLOW",
          basis: Object.freeze({ type: "grant", ref: consumed.id }),
          executionScope: consumed.scope,
        });
      }

      const safeReadRule = this.dependencies.policy.rules.find(
        (rule) => rule.effect === "ALLOW" && this.safePolicyRead(rule, intent),
      );
      if (safeReadRule) {
        await this.trace(intent, "ALLOW", safeReadRule.reasonCode, now);
        return Object.freeze({
          decision: "ALLOW",
          basis: Object.freeze({ type: "policy", ref: safeReadRule.id }),
          executionScope: Object.freeze({
            capabilityRef: intent.capabilityRef,
            operations: Object.freeze([intent.operation]),
            exactResourceRef: intent.resourceRef,
            resourcePrefixes: Object.freeze([]),
            maxDataClassification: intent.dataClassification,
            sideEffects: Object.freeze([intent.sideEffect]),
            maxCostMicrosPerUse: intent.estimatedCostMicros,
            maxFrequency: Object.freeze({ ...intent.frequency }),
          }),
        });
      }

      if (options.approvalExpiresAt <= now || options.approvalExpiresAt > intent.expiresAt) {
        return this.finish(intent, "DENY", "approval_expiry_invalid", now, true);
      }
      const existing = await this.dependencies.store.findApprovalByIntent(intent.id);
      if (existing) return this.existingApproval(intent, existing, now);
      const request: GovernedApprovalRequest = Object.freeze({
        id: this.dependencies.ids.next("approval"),
        revision: 1,
        ownerId: intent.ownerId,
        agentId: intent.agentId,
        runId: intent.runId,
        intentId: intent.id,
        intentSnapshot: intent,
        semanticSnapshotHash: actionIntentFingerprint(intent),
        finalRisk: intent.finalRisk,
        recentAuthenticationRequired: intent.finalRisk === "CRITICAL",
        recentAuthenticationRef: null,
        status: "pending",
        deliveryState: options.uiAvailable ? "deliverable" : "queued_no_ui",
        requestedAt: now,
        expiresAt: options.approvalExpiresAt,
        decidedAt: null,
        grantId: null,
      });
      const stored = await this.dependencies.store.createApproval(request);
      await this.trace(
        intent,
        "ASK",
        options.uiAvailable ? "approval_required" : "approval_queued_no_ui",
        now,
      );
      return Object.freeze({ decision: "ASK", approvalRequest: stored });
    } catch {
      return Object.freeze({
        decision: "DENY",
        reasonCode: "authorization_component_error",
        alternativesAllowed: false,
      });
    }
  }

  private capabilityDenial(
    facts: CapabilityAuthorizationFacts | undefined,
    intent: GovernedActionIntent,
  ): string | null {
    if (!facts) return "capability_not_registered";
    if (facts.lifecycle !== "active") return "capability_not_active";
    if (facts.manifest.health.status !== "healthy") return "capability_not_healthy";
    if (facts.manifest.version !== intent.capabilityVersion) return "capability_version_mismatch";
    if (!facts.manifest.operations.includes(intent.operation)) return "operation_not_declared";
    if (!facts.manifest.scopes.dataClassifications.includes(intent.dataClassification)) {
      return "data_scope_not_declared";
    }
    return null;
  }

  private governedGrantCovers(
    grant: GovernedGrantRecord,
    intent: GovernedActionIntent,
    now: string,
  ): boolean {
    const scope = grant.scope;
    const replay =
      grant.intentFingerprint === actionIntentFingerprint(intent) &&
      grant.uses > 0 &&
      grant.ownerId === intent.ownerId &&
      grant.agentId === intent.agentId &&
      grant.revokedAt === null &&
      now < grant.expiresAt;
    return (
      typeof scope.capabilityVersion === "string" &&
      scope.capabilityVersion === intent.capabilityVersion &&
      scope.disclosure === intent.disclosure &&
      intent.recipients.every((recipient) => scope.recipients.includes(recipient)) &&
      intent.resourceRefs.every(
        (ref) =>
          scope.resourceIdentities.includes(ref) ||
          scope.resourcePrefixes.some((prefix) => ref.startsWith(prefix)),
      ) &&
      (grantCoversIntent(grant, intent, now) || replay)
    );
  }

  private safePolicyRead(
    rule: PermissionPolicy["rules"][number],
    intent: GovernedActionIntent,
  ): boolean {
    return (
      intent.actionKind === "READ" &&
      intent.finalRisk === "LOW" &&
      intent.sideEffect === "none" &&
      intent.disclosure === "none" &&
      intent.recipients.length === 0 &&
      intent.credentialOrAccessChange === false &&
      intent.dataClassification !== "sensitive" &&
      intent.dataClassification !== "restricted" &&
      rule.capabilityRefs.includes(intent.capabilityRef) &&
      rule.operations.includes(intent.operation) &&
      intent.resourceRefs.every((ref) =>
        rule.resourcePrefixes.some((prefix) => prefix.length > 1 && ref.startsWith(prefix)),
      ) &&
      rule.dataClassifications.includes(intent.dataClassification) &&
      rule.sideEffects.includes(intent.sideEffect) &&
      intent.estimatedCostMicros <= rule.maxCostMicros
    );
  }

  private async existingApproval(
    intent: GovernedActionIntent,
    approval: ApprovalRequest,
    now: string,
  ): Promise<PermissionDecision> {
    if (approval.semanticSnapshotHash !== actionIntentFingerprint(intent)) {
      return this.finish(intent, "DENY", "approval_hash_mismatch", now, false);
    }
    if (approval.status !== "pending") {
      return this.finish(intent, "DENY", `approval_${approval.status}`, now, true);
    }
    if (now >= approval.expiresAt)
      return this.finish(intent, "DENY", "approval_expired", now, true);
    await this.trace(intent, "ASK", "approval_pending", now);
    return Object.freeze({ decision: "ASK", approvalRequest: approval });
  }

  private async finish(
    intent: GovernedActionIntent,
    decision: "DENY",
    reasonCode: string,
    now: string,
    alternativesAllowed: boolean,
  ): Promise<PermissionDecision> {
    await this.trace(intent, decision, reasonCode, now);
    return Object.freeze({ decision, reasonCode, alternativesAllowed });
  }

  private async trace(
    intent: GovernedActionIntent,
    decision: "ALLOW" | "ASK" | "DENY",
    reasonCode: string,
    now: string,
  ): Promise<void> {
    await this.dependencies.trace?.record({
      intentId: intent.id,
      policyVersion: this.dependencies.policy.version,
      facts: intent.deterministicFacts.map(({ code }) => code),
      modelRisk: intent.modelClassification.suggestedRisk,
      finalRisk: intent.finalRisk,
      decision,
      reasonCode,
      occurredAt: now,
    });
  }
}
