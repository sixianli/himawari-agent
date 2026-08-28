import type { RiskLevel } from "../components/primitives.js";

export const GOVERNED_ACTION_BLOCKER_CODES = [
  "authorization_required",
  "recent_authentication_required",
  "revision_conflict",
  "explicit_acknowledgement_required",
] as const;

export type GovernedActionBlockerCode = (typeof GOVERNED_ACTION_BLOCKER_CODES)[number];

export interface GovernedActionGateInput {
  readonly acknowledged: boolean;
  readonly authorizationRef: string | null;
  readonly currentRevision: number;
  readonly destructive: boolean;
  readonly expectedRevision: number;
  readonly recentAuthenticationRef: string | null;
  readonly risk: RiskLevel;
}

export interface GovernedActionGateResult {
  readonly allowed: boolean;
  readonly blockers: readonly GovernedActionBlockerCode[];
}

export function evaluateGovernedActionGate(
  input: GovernedActionGateInput,
): GovernedActionGateResult {
  const blockers: GovernedActionBlockerCode[] = [];
  if ((input.risk === "high" || input.risk === "critical") && !input.authorizationRef) {
    blockers.push("authorization_required");
  }
  if ((input.risk === "critical" || input.destructive) && !input.recentAuthenticationRef) {
    blockers.push("recent_authentication_required");
  }
  if (input.expectedRevision !== input.currentRevision) blockers.push("revision_conflict");
  if (
    (input.risk === "high" || input.risk === "critical" || input.destructive) &&
    !input.acknowledged
  ) {
    blockers.push("explicit_acknowledgement_required");
  }
  return Object.freeze({ allowed: blockers.length === 0, blockers: Object.freeze(blockers) });
}
