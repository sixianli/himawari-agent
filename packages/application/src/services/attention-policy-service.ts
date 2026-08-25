import {
  PORT_ERROR_CODES,
  ApplicationPortError,
  type AttentionCandidate,
  type AttentionDecision,
  type AttentionDecisionRecord,
  type AttentionPolicyState,
  type AttentionStatePort,
  type ClockPort,
  type DeliveryAttemptResult,
  type DeliveryPort,
  type DeliveryRequest,
  type DeliveryRequestWrite,
} from "../ports/index.js";

export interface AttentionPolicyConfig {
  readonly duplicateWindowMs: number;
  readonly rateLimitWindowMs: number;
  readonly maxImmediateDeliveries: number;
  readonly quietHours: {
    readonly startMinute: number;
    readonly endMinute: number;
    readonly utcOffsetMinutes: number;
  } | null;
  readonly authorizedInterruptRefs: readonly string[];
}

export interface AttentionEvaluationResult {
  readonly record: AttentionDecisionRecord;
  readonly delivery: DeliveryRequest | null;
  readonly replayed: boolean;
}

export interface AttentionDeliveryResult {
  readonly request: DeliveryRequest;
  readonly outcome: "delivered" | "pending" | "duplicate";
  readonly reasonCode: string;
}

export interface AttentionPolicyServiceDependencies {
  readonly state: AttentionStatePort;
  readonly delivery: DeliveryPort;
  readonly clock: ClockPort;
  readonly policy: AttentionPolicyConfig;
}

function candidateFingerprint(candidate: AttentionCandidate): string {
  return JSON.stringify([
    candidate.id,
    candidate.ownerId,
    candidate.agentId,
    candidate.runId,
    candidate.sessionId,
    candidate.threadId,
    candidate.resultRef,
    candidate.dataClassification,
    candidate.urgency,
    candidate.confidence,
    candidate.duplicateKey,
    candidate.generatedAt,
    candidate.deviceState,
    candidate.interruptAuthorizationRef,
  ]);
}

function withinWindow(timestamp: string, nowMs: number, windowMs: number): boolean {
  const value = new Date(timestamp).valueOf();
  return !Number.isNaN(value) && value >= nowMs - windowMs && value <= nowMs;
}

function isQuietHours(now: string, policy: AttentionPolicyConfig): boolean {
  if (!policy.quietHours) return false;
  const shifted = new Date(new Date(now).valueOf() + policy.quietHours.utcOffsetMinutes * 60_000);
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const { startMinute, endMinute } = policy.quietHours;
  if (startMinute === endMinute) return true;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

function assertCandidate(candidate: AttentionCandidate): void {
  const generatedAt = new Date(candidate.generatedAt);
  if (
    !Number.isFinite(candidate.urgency) ||
    candidate.urgency < 0 ||
    candidate.urgency > 100 ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 100 ||
    Number.isNaN(generatedAt.valueOf()) ||
    generatedAt.toISOString() !== candidate.generatedAt
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Attention candidate ${candidate.id} is invalid`,
      { candidateId: candidate.id },
    );
  }
}

function assertPolicy(policy: AttentionPolicyConfig): void {
  const nonNegative = [
    policy.duplicateWindowMs,
    policy.rateLimitWindowMs,
    policy.maxImmediateDeliveries,
  ].every((value) => Number.isSafeInteger(value) && value >= 0);
  const quietValid =
    policy.quietHours === null ||
    (Number.isSafeInteger(policy.quietHours.startMinute) &&
      policy.quietHours.startMinute >= 0 &&
      policy.quietHours.startMinute < 1_440 &&
      Number.isSafeInteger(policy.quietHours.endMinute) &&
      policy.quietHours.endMinute >= 0 &&
      policy.quietHours.endMinute < 1_440 &&
      Number.isSafeInteger(policy.quietHours.utcOffsetMinutes) &&
      policy.quietHours.utcOffsetMinutes >= -840 &&
      policy.quietHours.utcOffsetMinutes <= 840);
  if (!nonNegative || !quietValid) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Attention policy configuration is invalid",
    );
  }
}

function baseDecision(
  candidate: AttentionCandidate,
  state: AttentionPolicyState,
  now: string,
  policy: AttentionPolicyConfig,
): AttentionDecision {
  const nowMs = new Date(now).valueOf();
  const duplicate = state.decisions.some(
    (record) =>
      record.duplicateKey === candidate.duplicateKey &&
      withinWindow(record.decidedAt, nowMs, policy.duplicateWindowMs),
  );
  if (duplicate) {
    return {
      candidateId: candidate.id,
      level: "SILENT",
      reasonCode: "duplicate_result",
      interruptAuthorizationRef: null,
    };
  }
  if (candidate.urgency < 20 || candidate.confidence < 20) {
    return {
      candidateId: candidate.id,
      level: "SILENT",
      reasonCode: "low_signal",
      interruptAuthorizationRef: null,
    };
  }
  if (candidate.urgency < 40 || candidate.confidence < 50) {
    return {
      candidateId: candidate.id,
      level: "INBOX",
      reasonCode: "passive_result",
      interruptAuthorizationRef: null,
    };
  }
  if (candidate.urgency < 70 || candidate.confidence < 70) {
    return {
      candidateId: candidate.id,
      level: "DIGEST",
      reasonCode: "digest_result",
      interruptAuthorizationRef: null,
    };
  }

  const interruptAuthorized =
    candidate.urgency >= 90 &&
    candidate.confidence >= 85 &&
    candidate.interruptAuthorizationRef !== null &&
    policy.authorizedInterruptRefs.includes(candidate.interruptAuthorizationRef);
  let decision: AttentionDecision = interruptAuthorized
    ? {
        candidateId: candidate.id,
        level: "INTERRUPT",
        reasonCode: "authorized_urgent_result",
        interruptAuthorizationRef: candidate.interruptAuthorizationRef,
      }
    : {
        candidateId: candidate.id,
        level: "NOTIFY",
        reasonCode: "notifiable_result",
        interruptAuthorizationRef: null,
      };
  const recentImmediate = state.decisions.filter(
    ({ decision: previous, decidedAt }) =>
      (previous.level === "NOTIFY" || previous.level === "INTERRUPT") &&
      withinWindow(decidedAt, nowMs, policy.rateLimitWindowMs),
  ).length;
  if (recentImmediate >= policy.maxImmediateDeliveries) {
    decision = {
      candidateId: candidate.id,
      level: "DIGEST",
      reasonCode: "rate_limited",
      interruptAuthorizationRef: null,
    };
  } else if (candidate.deviceState === "unavailable") {
    decision = {
      candidateId: candidate.id,
      level: "INBOX",
      reasonCode: "client_unavailable",
      interruptAuthorizationRef: null,
    };
  } else if (decision.level === "NOTIFY" && isQuietHours(now, policy)) {
    decision = {
      candidateId: candidate.id,
      level: "DIGEST",
      reasonCode: "quiet_hours",
      interruptAuthorizationRef: null,
    };
  }
  return decision;
}

export class AttentionPolicyService {
  private readonly dependencies: AttentionPolicyServiceDependencies;

  constructor(dependencies: AttentionPolicyServiceDependencies) {
    assertPolicy(dependencies.policy);
    this.dependencies = Object.freeze({
      ...dependencies,
      policy: Object.freeze({
        ...dependencies.policy,
        quietHours: dependencies.policy.quietHours
          ? Object.freeze({ ...dependencies.policy.quietHours })
          : null,
        authorizedInterruptRefs: Object.freeze([...dependencies.policy.authorizedInterruptRefs]),
      }),
    });
  }

  async evaluate(candidate: AttentionCandidate): Promise<AttentionEvaluationResult> {
    assertCandidate(candidate);
    const fingerprint = candidateFingerprint(candidate);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const state = await this.dependencies.state.readPolicyState(
        candidate.ownerId,
        candidate.agentId,
      );
      const existing = state.decisions.find(({ candidateId }) => candidateId === candidate.id);
      if (existing) {
        if (existing.candidateFingerprint !== fingerprint) {
          throw new ApplicationPortError(
            PORT_ERROR_CODES.CONFLICT,
            `Attention candidate ${candidate.id} was reused with different content`,
            { candidateId: candidate.id },
          );
        }
        const delivery = existing.deliveryRequestId
          ? await this.dependencies.state.readDelivery(existing.deliveryRequestId)
          : undefined;
        if (existing.deliveryRequestId && !delivery) {
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            `Attention decision ${candidate.id} has no matching Delivery Request`,
            { candidateId: candidate.id, requestId: existing.deliveryRequestId },
          );
        }
        return { record: existing, delivery: delivery ?? null, replayed: true };
      }
      const now = this.dependencies.clock.now();
      const decision = Object.freeze(baseDecision(candidate, state, now, this.dependencies.policy));
      const deliveryId =
        decision.level === "SILENT"
          ? null
          : `delivery:${candidate.ownerId}:${candidate.agentId}:${candidate.id}`;
      const record: AttentionDecisionRecord = Object.freeze({
        candidateId: candidate.id,
        candidateFingerprint: fingerprint,
        ownerId: candidate.ownerId,
        agentId: candidate.agentId,
        runId: candidate.runId,
        duplicateKey: candidate.duplicateKey,
        decision,
        deliveryRequestId: deliveryId,
        decidedAt: now,
      });
      const delivery: DeliveryRequestWrite | null =
        deliveryId === null || decision.level === "SILENT"
          ? null
          : Object.freeze({
              id: deliveryId,
              candidateId: candidate.id,
              ownerId: candidate.ownerId,
              agentId: candidate.agentId,
              runId: candidate.runId,
              resultRef: candidate.resultRef,
              dataClassification: candidate.dataClassification,
              level: decision.level,
              status: "pending",
              assignedClientId: null,
              attempts: 0,
              acknowledgementRef: null,
              lastErrorCode: null,
              createdAt: now,
              updatedAt: now,
            });
      try {
        const committed = await this.dependencies.state.commitDecision({
          ownerId: candidate.ownerId,
          agentId: candidate.agentId,
          expectedRevision: state.revision,
          record,
          delivery,
        });
        return { record: committed.record, delivery: committed.delivery, replayed: false };
      } catch (error) {
        if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT) {
          throw error;
        }
      }
    }
    throw new ApplicationPortError(
      PORT_ERROR_CODES.CONFLICT,
      `Attention candidate ${candidate.id} could not be committed after concurrent changes`,
      { candidateId: candidate.id },
    );
  }

  async deliver(requestId: string, clientId: string): Promise<AttentionDeliveryResult> {
    const now = this.dependencies.clock.now();
    const claim = await this.dependencies.state.claimDelivery(requestId, clientId, now);
    if (!claim.claimed) {
      return {
        request: claim.request,
        outcome: "duplicate",
        reasonCode: claim.reasonCode,
      };
    }
    let attempt: DeliveryAttemptResult;
    try {
      attempt = await this.dependencies.delivery.deliver({ request: claim.request, clientId });
    } catch {
      attempt = {
        outcome: "failed",
        acknowledgementRef: null,
        errorCode: "DELIVERY_ADAPTER_FAILURE",
      };
    }
    const settled = await this.dependencies.state.settleDelivery({
      requestId,
      expectedRevision: claim.request.revision,
      clientId,
      outcome: attempt.outcome,
      acknowledgementRef: attempt.acknowledgementRef,
      errorCode: attempt.errorCode,
      settledAt: this.dependencies.clock.now(),
    });
    return {
      request: settled,
      outcome: attempt.outcome === "delivered" ? "delivered" : "pending",
      reasonCode:
        attempt.outcome === "delivered"
          ? "DELIVERY_ACKNOWLEDGED"
          : (attempt.errorCode ?? "DELIVERY_UNAVAILABLE"),
    };
  }
}
