import type {
  AgentId,
  OwnerId,
  ProductAuthorityFence,
  RunId,
  ThreadId,
} from "@himawari-agent/domain";

export type CanonicalSliceKind =
  | "adapter"
  | "approval"
  | "browser"
  | "calendar"
  | "grant"
  | "inbox"
  | "memory"
  | "message"
  | "result"
  | "task"
  | "trace"
  | "worker";

export interface CanonicalScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly traceId: string;
  readonly authority: ProductAuthorityFence;
}

export interface CanonicalSliceRecord {
  readonly kind: CanonicalSliceKind;
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly traceId: string;
  readonly authorityWriter: "product" | "adapter" | "browser" | "calendar" | "worker";
  readonly authority: ProductAuthorityFence;
  readonly browserSessionId?: string;
  readonly providerRowId?: string;
  readonly adapterLocalId?: string;
}

export interface CanonicalEventAdmission {
  readonly source: string;
  readonly deliveryId: string;
  readonly semanticFingerprint: string;
}

export interface ExternalEffectContract {
  readonly effectKind: string;
  readonly stableIdentity: string;
  readonly actionIntentRef: string;
  readonly authorizationRef: string;
  readonly executionHandleRef: string;
  readonly boundedReadbackRef: string;
  readonly reconcileRef: string;
  readonly resultRef: string;
  readonly attentionRef: string | null;
  readonly outcome: "confirmed_failure" | "confirmed_success" | "result_unknown";
  readonly retryPolicy: "never" | "reconcile_only";
}

export interface ExecutionHandleContract {
  readonly handleRef: string;
  readonly status: "active" | "consumed" | "expired" | "revoked";
  readonly authority: ProductAuthorityFence;
  readonly expectedAuthority: ProductAuthorityFence;
  readonly remainingUses: number;
  readonly deadlineAt: string;
  readonly now: string;
}

export interface SecretReferenceContract {
  readonly secretRef: string;
  readonly rawValuePresent: boolean;
  readonly disclosedToModel: boolean;
  readonly disclosedToBrowser: boolean;
  readonly includedInMigration: boolean;
}

export interface DeletionHookContract {
  readonly lifecycle: "active" | "trashed" | "deletion_pending" | "deleted_verified";
  readonly contentResolvable: boolean;
  readonly projectionResolvable: boolean;
  readonly lineageMarkerPresent: boolean;
}

export interface MigrationCredentialContract {
  readonly credentialKind: "host_bound" | "portable_reference";
  readonly transferState: "blocked_reauthorization_required" | "included" | "omitted";
}

function assertMachineReference(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new Error(`${field} must be a non-empty machine reference`);
  }
}

export function assertCanonicalScope(
  expected: CanonicalScope,
  records: readonly CanonicalSliceRecord[],
): void {
  if (records.length === 0) throw new Error("Canonical scope requires at least one slice record");
  if (
    expected.authority.authorityEpoch < 1 ||
    expected.authority.fencingToken < 1 ||
    !Number.isSafeInteger(expected.authority.authorityEpoch) ||
    !Number.isSafeInteger(expected.authority.fencingToken)
  ) {
    throw new Error("Canonical authority fence must use positive safe integers");
  }
  const canonicalIds = new Set([
    expected.ownerId,
    expected.agentId,
    expected.threadId,
    expected.runId,
    expected.traceId,
  ]);
  for (const record of records) {
    if (
      record.ownerId !== expected.ownerId ||
      record.agentId !== expected.agentId ||
      record.threadId !== expected.threadId ||
      record.runId !== expected.runId ||
      record.traceId !== expected.traceId
    ) {
      throw new Error(`${record.kind} record is outside the canonical Owner/Agent/Run/Trace scope`);
    }
    if (
      record.authority.deploymentId !== expected.authority.deploymentId ||
      record.authority.authorityEpoch !== expected.authority.authorityEpoch ||
      record.authority.fencingToken !== expected.authority.fencingToken
    ) {
      throw new Error(`${record.kind} record carries a stale or foreign authority fence`);
    }
    if (record.authorityWriter !== "product") {
      throw new Error(`${record.kind} cannot become a second product authority writer`);
    }
    for (const localId of [record.browserSessionId, record.providerRowId, record.adapterLocalId]) {
      if (localId && canonicalIds.has(localId)) {
        throw new Error(
          `${record.kind} local identity cannot replace a canonical product identity`,
        );
      }
    }
    assertMachineReference(record.id, `${record.kind}.id`);
  }
}

export function deduplicateCanonicalEvents(
  events: readonly CanonicalEventAdmission[],
): readonly CanonicalEventAdmission[] {
  const accepted = new Map<string, CanonicalEventAdmission>();
  for (const event of events) {
    const key = `${event.source}:${event.deliveryId}`;
    const previous = accepted.get(key);
    if (previous && previous.semanticFingerprint !== event.semanticFingerprint) {
      throw new Error(`Duplicate event ${key} changed semantic fingerprint`);
    }
    accepted.set(key, previous ?? event);
  }
  return Object.freeze([...accepted.values()]);
}

export function assertExternalEffectContract(effect: ExternalEffectContract): void {
  for (const [field, value] of Object.entries(effect)) {
    if (field === "outcome" || field === "retryPolicy") continue;
    if (value !== null) assertMachineReference(value, `externalEffect.${field}`);
  }
  if (effect.outcome === "result_unknown" && effect.retryPolicy !== "reconcile_only") {
    throw new Error("Unknown external result must reconcile before any retry");
  }
}

export function assertExecutionHandleContract(handle: ExecutionHandleContract): void {
  assertMachineReference(handle.handleRef, "executionHandle.handleRef");
  if (
    handle.status !== "active" ||
    handle.remainingUses < 1 ||
    Date.parse(handle.deadlineAt) <= Date.parse(handle.now) ||
    handle.authority.deploymentId !== handle.expectedAuthority.deploymentId ||
    handle.authority.authorityEpoch !== handle.expectedAuthority.authorityEpoch ||
    handle.authority.fencingToken !== handle.expectedAuthority.fencingToken
  ) {
    throw new Error("Execution Handle is revoked, expired, consumed, exhausted, or stale");
  }
}

export function assertSecretReferenceContract(secret: SecretReferenceContract): void {
  assertMachineReference(secret.secretRef, "secretRef");
  if (
    secret.rawValuePresent ||
    secret.disclosedToModel ||
    secret.disclosedToBrowser ||
    secret.includedInMigration
  ) {
    throw new Error("Machine secret raw values must remain outside product-readable surfaces");
  }
}

export function assertDeletionHookContract(deletion: DeletionHookContract): void {
  if (
    deletion.lifecycle === "deleted_verified" &&
    (deletion.contentResolvable || deletion.projectionResolvable || !deletion.lineageMarkerPresent)
  ) {
    throw new Error(
      "Verified deletion must remove resolvable content and preserve only lineage markers",
    );
  }
}

export function assertMigrationCredentialContract(migration: MigrationCredentialContract): void {
  if (
    migration.credentialKind === "host_bound" &&
    migration.transferState !== "blocked_reauthorization_required"
  ) {
    throw new Error("Host-bound credentials must remain blocked until reauthorization");
  }
}
