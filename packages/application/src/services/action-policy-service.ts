import type {
  ActionKind,
  AutomaticActionReviewPort,
  ActionRiskLevel,
  ApprovalRequest,
  AuthorizationReservation,
  AuthorizationStorePort,
  GovernedActionIntent,
  GovernedApprovalRequest,
  GovernedGrantRecord,
  PermissionDecision,
  PermissionDenyDecision,
  PermissionPolicy,
} from "../ports/authorization.js";
import { ACTION_KINDS, ACTION_RISK_LEVELS } from "../ports/authorization.js";
import {
  capabilityLifecycleHasActiveAuthority,
  type CapabilityManifest,
  type CapabilityRegistryLifecycle,
} from "../ports/capabilities.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import {
  canonicalAuthorizationSnapshot,
  governedGrantAuthorityCovers,
  approvalMatchesIntent,
} from "./action-intent-snapshot.js";
import { actionIntentFingerprint } from "./permission-service.js";

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
    !Number.isSafeInteger(intent.frequency.count) ||
    !Number.isSafeInteger(intent.estimatedCostMicros) ||
    !Number.isFinite(Date.parse(intent.requestedAt)) ||
    !Number.isFinite(Date.parse(intent.expiresAt)) ||
    new Date(intent.requestedAt).toISOString() !== intent.requestedAt ||
    new Date(intent.expiresAt).toISOString() !== intent.expiresAt ||
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
  /** Absent in production unless an explicitly configured coordinator is supplied. */
  readonly automaticReview?: AutomaticActionReviewPort;
}

export class ActionPolicyService {
  private readonly dependencies: ActionPolicyServiceDependencies;

  constructor(dependencies: ActionPolicyServiceDependencies) {
    this.dependencies = dependencies;
  }

  async evaluate(
    source: GovernedActionIntent,
    options: {
      readonly uiAvailable: boolean;
      readonly approvalExpiresAt: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<PermissionDecision> {
    const current = { ...options };
    const decision = await this.evaluateCurrent(source, current, true);
    // Final trace/store writes can yield too. They preserve historical facts but
    // must not return fresh execution permission after the caller has stopped.
    return current.signal?.aborted
      ? Object.freeze({
          decision: "DENY",
          reasonCode: "action_cancelled",
          alternativesAllowed: false,
        })
      : decision;
  }

  private async evaluateCurrent(
    source: GovernedActionIntent,
    options: {
      readonly uiAvailable: boolean;
      readonly approvalExpiresAt: string;
      readonly signal?: AbortSignal;
    },
    allowReview: boolean,
  ): Promise<PermissionDecision> {
    let intent: GovernedActionIntent;
    try {
      options.signal?.throwIfAborted();
      intent = freezeGovernedActionIntent(source);
      let now = this.dependencies.clock.now();
      if (now >= intent.expiresAt) return this.finish(intent, "DENY", "intent_expired", now, false);
      const capability = await this.dependencies.capabilities.inspect(intent.capabilityRef);
      options.signal?.throwIfAborted();
      now = this.dependencies.clock.now();
      if (now >= intent.expiresAt) return this.finish(intent, "DENY", "intent_expired", now, false);
      const denial = this.capabilityDenial(capability, intent);
      if (denial) return this.finish(intent, "DENY", denial, now, false);

      const deniedRule = this.dependencies.policy.rules.find(
        (rule) =>
          rule.effect === "DENY" &&
          rule.capabilityRefs.includes(intent.capabilityRef) &&
          rule.operations.includes(intent.operation) &&
          rule.resourcePrefixes.some((prefix) =>
            intent.resourceRefs.some((ref) => ref.startsWith(prefix)),
          ),
      );
      if (deniedRule) return this.finish(intent, "DENY", deniedRule.reasonCode, now, false);

      const existing = await this.dependencies.store.findApprovalByIntent(intent.id);
      options.signal?.throwIfAborted();
      now = this.dependencies.clock.now();
      if (now >= intent.expiresAt) return this.finish(intent, "DENY", "intent_expired", now, false);
      if (existing) {
        if (!approvalMatchesIntent(existing, intent))
          return this.finish(intent, "DENY", "approval_hash_mismatch", now, false);
        if (existing.status !== "approved") return this.existingApproval(intent, existing, now);
      }
      const priorReservation = await this.dependencies.store.getAuthorizationReservation?.(
        `authorization-reservation:${intent.id}`,
      );
      if (
        priorReservation &&
        canonicalAuthorizationSnapshot(priorReservation.intent) !==
          canonicalAuthorizationSnapshot(intent)
      )
        return this.finish(
          intent,
          "DENY",
          "reservation_identity_changed",
          this.dependencies.clock.now(),
          false,
        );
      const grants = await this.dependencies.store.listGrants(intent.ownerId, intent.agentId);
      options.signal?.throwIfAborted();
      now = this.dependencies.clock.now();
      if (now >= intent.expiresAt) return this.finish(intent, "DENY", "intent_expired", now, false);
      let quotaUnavailable = false;
      for (const candidate of grants) {
        const grant = candidate as GovernedGrantRecord;
        if (priorReservation && priorReservation.grantId !== grant.id) continue;
        if (!this.governedGrantCovers(grant, intent, now)) continue;
        const reserve = this.dependencies.store.reserveAuthorization;
        if (!reserve) throw new Error("Authorization store cannot reserve quota");
        let reservation: AuthorizationReservation;
        try {
          reservation = await reserve.call(this.dependencies.store, {
            grantId: grant.id,
            intent,
            now: this.dependencies.clock.now(),
          });
        } catch (error) {
          if (
            error instanceof ApplicationPortError &&
            error.details["reasonCode"] === "AUTHORIZATION_QUOTA_UNAVAILABLE"
          ) {
            quotaUnavailable = true;
            continue;
          }
          throw error;
        }
        await this.trace(intent, "ALLOW", "grant", now);
        return Object.freeze({
          decision: "ALLOW",
          basis: Object.freeze({ type: "grant", ref: grant.id }),
          executionScope: grant.scope,
          authorizationReservation: {
            id: reservation.id,
            createdAt: reservation.createdAt,
            expiresAt: reservation.expiresAt,
          },
        });
      }
      options.signal?.throwIfAborted();
      if (priorReservation)
        return this.finish(intent, "DENY", "reserved_authority_unavailable", now, false);
      if (quotaUnavailable)
        return this.finish(intent, "DENY", "authorization_quota_unavailable", now, false);
      if (existing) return this.existingApproval(intent, existing, now);

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
      if (allowReview && this.dependencies.automaticReview) {
        const review = this.dependencies.automaticReview;
        if (
          !Number.isSafeInteger(review.maximumWaitMs) ||
          review.maximumWaitMs < 1 ||
          review.maximumWaitMs > 300_000
        )
          throw new Error("Invalid automatic review deadline");
        const controller = new AbortController();
        const signal = options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        let outcome: Awaited<ReturnType<AutomaticActionReviewPort["review"]>>;
        try {
          const duration = Math.min(
            review.maximumWaitMs,
            Date.parse(options.approvalExpiresAt) - Date.parse(this.dependencies.clock.now()),
          );
          if (duration > 0) {
            const stopped = new Promise<void>((resolve) => {
              onAbort = resolve;
              signal.addEventListener("abort", onAbort, { once: true });
            });
            timer = setTimeout(() => controller.abort(), duration);
            outcome = await Promise.race([
              review.review(
                {
                  intent,
                  policyVersion: this.dependencies.policy.version,
                  deadlineAt: new Date(
                    Date.parse(this.dependencies.clock.now()) + duration,
                  ).toISOString(),
                  approvalExpiresAt: options.approvalExpiresAt,
                },
                signal,
              ),
              stopped.then(() => undefined),
            ]);
          }
        } catch {
          // Diagnostics stay with the review coordinator; failure is not a user denial.
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort) signal.removeEventListener("abort", onAbort);
          controller.abort();
        }
        // A safer alternative is a recorded observation, not authority: the model receives
        // the reason and must propose a new request through this same entry. No Grant,
        // Approval, Handle or file claim is created for it.
        if (outcome?.decision === "alternative")
          return this.finish(
            intent,
            "DENY",
            "automatic_review_suggested_alternative",
            this.dependencies.clock.now(),
            true,
            {
              automaticReview: {
                outcome: "alternative",
                reasonCode: outcome.reasonCode,
                suggestionRef: outcome.suggestionRef,
              },
            },
          );
        // A return value cannot authorize anything. Re-read current policy, capability,
        // approval, quota and expiry after every await; review runs at most once here.
        return this.evaluateCurrent(intent, options, false);
      }
      options.signal?.throwIfAborted();
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
      // Another device or review may have resolved the request during this write.
      if (stored.status !== "pending") return this.evaluateCurrent(intent, options, false);
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
        reasonCode: options.signal?.aborted ? "action_cancelled" : "authorization_component_error",
        alternativesAllowed: false,
      });
    }
  }

  private capabilityDenial(
    facts: CapabilityAuthorizationFacts | undefined,
    intent: GovernedActionIntent,
  ): string | null {
    if (!facts) return "capability_not_registered";
    if (!capabilityLifecycleHasActiveAuthority(facts.lifecycle)) return "capability_not_active";
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
    return governedGrantAuthorityCovers(grant, intent, now);
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
    if (!approvalMatchesIntent(approval, intent)) {
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
    extra: Pick<PermissionDenyDecision, "automaticReview"> = {},
  ): Promise<PermissionDecision> {
    await this.trace(intent, decision, reasonCode, now);
    return Object.freeze({ decision, reasonCode, alternativesAllowed, ...extra });
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
