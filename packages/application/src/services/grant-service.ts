import type {
  ActionFrequency,
  AuthorizationStorePort,
  GovernedActionIntent,
  GovernedGrantRecord,
  GovernedGrantScope,
} from "../ports/authorization.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import { actionIntentFingerprint } from "./permission-service.js";

function bounded(values: readonly string[], name: string): void {
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some(
      (value) =>
        !value || value === "*" || value === "/" || value === "home:" || value === "account:*",
    )
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `${name} must contain explicit bounded values`,
    );
  }
}

export interface GovernedGrantInput {
  readonly kind: "one_time" | "long_term";
  readonly intent: GovernedActionIntent;
  readonly approvalRequestId: string;
  readonly scope: GovernedGrantScope;
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly maxTotalCostMicros: number;
}

export class GrantService {
  private readonly dependencies: {
    readonly store: AuthorizationStorePort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  };

  constructor(dependencies: {
    readonly store: AuthorizationStorePort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  }) {
    this.dependencies = dependencies;
  }

  create(input: GovernedGrantInput): GovernedGrantRecord {
    const now = this.dependencies.clock.now();
    bounded(input.scope.operations, "Grant operations");
    if (input.scope.capabilityRef !== input.intent.capabilityRef) {
      this.invalid("Grant capability does not match the approved intent");
    }
    if (input.scope.capabilityVersion !== input.intent.capabilityVersion) {
      this.invalid("Grant version does not match the approved intent");
    }
    if (
      input.scope.credentialOrAccessChange ||
      input.expiresAt <= now ||
      input.maxUses < 1 ||
      input.maxTotalCostMicros < 0 ||
      input.scope.maxCostMicrosPerUse < 0 ||
      input.scope.maxFrequency.count < 1
    )
      this.invalid("Grant lifetime, authority and budgets must be bounded");
    if (input.kind === "long_term") {
      if (
        input.intent.actionKind !== "READ" ||
        input.intent.finalRisk !== "LOW" ||
        input.scope.sideEffects.some((effect) => effect !== "none") ||
        input.scope.disclosure !== "none" ||
        input.scope.recipients.length > 0 ||
        input.scope.maxDataClassification === "sensitive" ||
        input.scope.maxDataClassification === "restricted"
      )
        this.invalid("Long-term Grants are limited to bounded safe READ actions");
      if (
        input.scope.resourceIdentities.length === 0 &&
        input.scope.resourcePrefixes.length === 0
      ) {
        this.invalid("Long-term Grants require bounded resource identities or prefixes");
      }
      if (input.scope.resourcePrefixes.some((prefix) => prefix.length < 3 || prefix === "/")) {
        this.invalid("Long-term Grant resource prefixes are too broad");
      }
    }
    const oneTime = input.kind === "one_time";
    return Object.freeze({
      id: this.dependencies.ids.next("grant"),
      revision: 1,
      ownerId: input.intent.ownerId,
      agentId: input.intent.agentId,
      kind: input.kind,
      scope: Object.freeze(structuredClone(input.scope)),
      intentFingerprint: oneTime ? actionIntentFingerprint(input.intent) : null,
      sourceApprovalRequestId: input.approvalRequestId,
      validFrom: now,
      expiresAt: input.expiresAt,
      maxUses: oneTime ? 1 : input.maxUses,
      uses: 0,
      maxTotalCostMicros: oneTime ? input.intent.estimatedCostMicros : input.maxTotalCostMicros,
      spentCostMicros: 0,
      revokedAt: null,
      revocationReasonCode: null,
    });
  }

  consume(input: {
    readonly grant: GovernedGrantRecord;
    readonly intent: GovernedActionIntent;
  }): Promise<GovernedGrantRecord> {
    return this.dependencies.store.consumeGrant({
      grantId: input.grant.id,
      expectedRevision: input.grant.revision,
      costMicros: input.intent.estimatedCostMicros,
      consumedAt: this.dependencies.clock.now(),
      usageId: `authorization-usage:${input.intent.id}`,
      runId: input.intent.runId,
      operation: input.intent.operation,
    }) as Promise<GovernedGrantRecord>;
  }

  revoke(grantId: string, reasonCode: string): Promise<GovernedGrantRecord> {
    return this.dependencies.store.revokeGrant(
      grantId,
      this.dependencies.clock.now(),
      reasonCode,
    ) as Promise<GovernedGrantRecord>;
  }

  private invalid(message: string): never {
    throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, message);
  }
}

export function frequencyWithin(requested: ActionFrequency, maximum: ActionFrequency): boolean {
  return (
    requested.count <= maximum.count &&
    (requested.intervalMs === null ||
      (maximum.intervalMs !== null && requested.intervalMs >= maximum.intervalMs))
  );
}
