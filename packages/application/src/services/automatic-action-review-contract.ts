import type {
  AutomaticReviewDecision,
  AutomaticReviewRequest,
  AutomaticReviewDelegation,
} from "../ports/automatic-action-review.js";
export function automaticReviewDelegationCovers(
  delegation: AutomaticReviewDelegation,
  request: Pick<
    AutomaticReviewRequest,
    | "configurationVersion"
    | "modelRef"
    | "policyVersion"
    | "intentFingerprint"
    | "deadlineAt"
    | "approvalExpiresAt"
  >,
  now: string,
): boolean {
  return (
    delegation.kind === "automatic-review.v1" &&
    delegation.enabled === true &&
    delegation.configurationVersion === request.configurationVersion &&
    delegation.modelRef === request.modelRef &&
    delegation.policyVersion === request.policyVersion &&
    Array.isArray(delegation.intentFingerprints) &&
    delegation.intentFingerprints.includes(request.intentFingerprint) &&
    Number.isFinite(Date.parse(delegation.expiresAt)) &&
    now < delegation.expiresAt &&
    request.approvalExpiresAt <= delegation.expiresAt &&
    request.deadlineAt <= request.approvalExpiresAt &&
    now < request.deadlineAt
  );
}

/** Parse only a recommendation for this exact request. Text never becomes authority. */
export function parseAutomaticReviewDecision(
  request: AutomaticReviewRequest,
  value: unknown,
): AutomaticReviewDecision {
  const invalid = (): never => {
    throw new Error("AUTOMATIC_REVIEW_RESPONSE_INVALID");
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  const bindings = [
    "schemaVersion",
    "reviewId",
    "intentFingerprint",
    "policyVersion",
    "configurationVersion",
    "modelRef",
  ] as const;
  if (bindings.some((key) => record[key] !== request[key])) return invalid();
  const keys: readonly string[] = [
    ...bindings,
    "reasonCode",
    "decision",
    ...(record["decision"] === "alternative" ? ["suggestion"] : []),
  ];
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key))
  )
    return invalid();
  const reasonCode = record["reasonCode"];
  if (typeof reasonCode !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(reasonCode))
    return invalid();
  const identity = {
    schemaVersion: request.schemaVersion,
    reviewId: request.reviewId,
    intentFingerprint: request.intentFingerprint,
    policyVersion: request.policyVersion,
    configurationVersion: request.configurationVersion,
    modelRef: request.modelRef,
    reasonCode,
  };
  const decision = record["decision"];
  if (decision === "approve" || decision === "deny" || decision === "human")
    return Object.freeze({ ...identity, decision });
  const suggestion = record["suggestion"];
  if (
    decision === "alternative" &&
    typeof suggestion === "string" &&
    suggestion.trim().length > 0 &&
    suggestion.length <= 2000
  )
    return Object.freeze({ ...identity, decision, suggestion });
  return invalid();
}
