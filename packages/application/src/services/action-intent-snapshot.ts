import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  ActionIntent,
  ApprovalRequest,
  GovernedActionIntent,
  GovernedGrantRecord,
  GrantRecord,
  ResolveApprovalInput,
} from "../ports/authorization.js";

/** JSON object key order is not semantic; array order remains part of the snapshot. */
export function canonicalAuthorizationSnapshot(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function actionIntentFingerprint(intent: ActionIntent): string {
  if (!("contractVersion" in intent) || intent.contractVersion !== "authorization.v2") {
    return legacyActionIntentFingerprint(intent);
  }
  return `intent.v2.sha256:${bytesToHex(
    sha256(
      new TextEncoder().encode(
        `himawari.authorization.v2\0${canonicalAuthorizationSnapshot(intent)}`,
      ),
    ),
  )}`;
}

/** Legacy snapshots remain readable; never upgrade historical approval authority. */
export function actionIntentFingerprintMatches(
  intent: ActionIntent | GovernedActionIntent,
  hash: string,
): boolean {
  return (
    hash === actionIntentFingerprint(intent) ||
    (/^intent-[0-9a-f]{8}$/.test(hash) && hash === legacyActionIntentFingerprint(intent))
  );
}

export function approvalMatchesIntent(approval: ApprovalRequest, intent: ActionIntent): boolean {
  return (
    approval.ownerId === intent.ownerId &&
    approval.agentId === intent.agentId &&
    approval.runId === intent.runId &&
    approval.intentId === intent.id &&
    canonicalAuthorizationSnapshot(approval.intentSnapshot) ===
      canonicalAuthorizationSnapshot(intent) &&
    actionIntentFingerprintMatches(approval.intentSnapshot, approval.semanticSnapshotHash)
  );
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

export function legacyActionIntentFingerprint(intent: ActionIntent): string {
  const governed = intent as Partial<import("../ports/authorization.js").GovernedActionIntent>;
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
      ...(governed.contractVersion === "authorization.v2"
        ? {
            contractVersion: governed.contractVersion,
            threadId: governed.threadId,
            actionKind: governed.actionKind,
            capabilityVersion: governed.capabilityVersion,
            targets: governed.targets,
            resourceRefs: governed.resourceRefs,
            disclosure: governed.disclosure,
            recipients: governed.recipients,
            credentialOrAccessChange: governed.credentialOrAccessChange,
            expiresAt: governed.expiresAt,
            modelClassification: governed.modelClassification,
            deterministicFacts: governed.deterministicFacts,
            finalRisk: governed.finalRisk,
          }
        : {}),
    }),
  );
}

/** A repeated decision acknowledges history; it does not reissue a grant. */
export function isApprovalResolutionReplay(
  current: ApprovalRequest,
  input: ResolveApprovalInput,
  storedGrant: GrantRecord | undefined,
): boolean {
  if (
    current.status !== input.resolution ||
    current.revision !== input.expectedRevision + 1 ||
    current.semanticSnapshotHash !== input.semanticSnapshotHash ||
    current.grantId !== (input.grant?.id ?? null)
  )
    return false;
  if (input.resolution !== "approved") return input.grant === null;
  if (!storedGrant || !input.grant) return false;
  const immutable = (grant: GrantRecord) => ({
    ...grant,
    revision: 1,
    uses: 0,
    spentCostMicros: 0,
    revokedAt: null,
    revocationReasonCode: null,
  });
  return (
    canonicalAuthorizationSnapshot(immutable(storedGrant)) ===
      canonicalAuthorizationSnapshot(input.grant) &&
    ((current as ApprovalRequest & { recentAuthenticationRef?: string | null })
      .recentAuthenticationRef ?? null) === (input.recentAuthenticationRef ?? null)
  );
}

/** Live authority checks independent of whether quota is reserved or committed. */
export function governedGrantAuthorityCovers(
  grant: GovernedGrantRecord,
  intent: GovernedActionIntent,
  now: string,
): boolean {
  const ranks = { public: 0, private: 1, sensitive: 2, restricted: 3 };
  const scope = grant.scope;
  return (
    grant.ownerId === intent.ownerId &&
    grant.agentId === intent.agentId &&
    // Scope reuse must preserve the safe READ restriction enforced at grant creation.
    (grant.kind !== "long_term" || (intent.actionKind === "READ" && intent.finalRisk === "LOW")) &&
    grant.revokedAt === null &&
    now >= grant.validFrom &&
    now < grant.expiresAt &&
    now < intent.expiresAt &&
    scope.capabilityRef === intent.capabilityRef &&
    scope.capabilityVersion === intent.capabilityVersion &&
    scope.operations.includes(intent.operation) &&
    scope.disclosure === intent.disclosure &&
    ranks[intent.dataClassification] <= ranks[scope.maxDataClassification] &&
    scope.sideEffects.includes(intent.sideEffect) &&
    scope.maxCostMicrosPerUse >= intent.estimatedCostMicros &&
    intent.frequency.count <= scope.maxFrequency.count &&
    (intent.frequency.intervalMs === null ||
      (scope.maxFrequency.intervalMs !== null &&
        intent.frequency.intervalMs >= scope.maxFrequency.intervalMs)) &&
    intent.resourceRefs.every(
      (ref) =>
        scope.resourceIdentities.includes(ref) ||
        scope.resourcePrefixes.some((prefix) => ref.startsWith(prefix)),
    ) &&
    intent.recipients.every((ref) => scope.recipients.includes(ref)) &&
    (grant.intentFingerprint === null ||
      actionIntentFingerprintMatches(intent, grant.intentFingerprint))
  );
}
