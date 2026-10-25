import {
  actionIntentFingerprint,
  type AuditLedgerPort,
  type AuditRecord,
  type AuthorizationStorePort,
  ApprovalService,
  ApplicationPortError,
  type ClockPort,
  GrantService,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
  type IdGeneratorPort,
  PORT_ERROR_CODES,
} from "@himawari-agent/application";

export async function appendAuditRecord(
  ledger: AuditLedgerPort,
  record: AuditRecord,
): Promise<void> {
  try {
    await ledger.append(record);
  } catch (error) {
    if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.DUPLICATE)
      throw error;
    const existing = (await ledger.listByAgent(record.agentId, null)).find(
      (item) => item.id === record.id,
    );
    if (
      !existing ||
      !(Object.keys(record) as (keyof AuditRecord)[]).every((key) => existing[key] === record[key])
    )
      throw error;
  }
}

export async function applyOwnerPolicyAuthorization(input: {
  readonly store: AuthorizationStorePort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly intent: GovernedActionIntent;
  readonly key: string;
  readonly revision: number;
  readonly auditId: string;
  readonly auditAction: string;
  readonly appendAudit: (record: AuditRecord) => Promise<void>;
}): Promise<void> {
  const { store, clock, ids, intent } = input;
  let approval = (await store.findApprovalByIntent(intent.id)) as
    | GovernedApprovalRequest
    | undefined;
  if (approval?.policyAuthorization && approval.status === "approved") {
    await input.appendAudit({
      id: input.auditId,
      ownerId: intent.ownerId,
      agentId: intent.agentId,
      action: input.auditAction,
      targetRef: approval.id,
      outcome: "completed",
      occurredAt: approval.decidedAt ?? clock.now(),
    });
    return;
  }
  // An explicit rejection or an already requested human decision is never overridden.
  if (approval && (!approval.policyAuthorization || approval.status !== "pending")) return;
  const policyAuthorization = { key: input.key, revision: input.revision };
  if (
    approval &&
    (approval.policyAuthorization?.key !== input.key ||
      approval.policyAuthorization.revision !== input.revision)
  )
    return;
  if (!approval)
    approval = (await store.createApproval({
      id: ids.next("policy-authorization"),
      revision: 1,
      ownerId: intent.ownerId,
      agentId: intent.agentId,
      runId: intent.runId,
      intentId: intent.id,
      intentSnapshot: intent,
      semanticSnapshotHash: actionIntentFingerprint(intent),
      status: "pending",
      deliveryState: "queued_no_ui",
      requestedAt: clock.now(),
      expiresAt: intent.expiresAt,
      decidedAt: null,
      grantId: null,
      finalRisk: intent.finalRisk,
      recentAuthenticationRequired: false,
      recentAuthenticationRef: null,
      policyAuthorization,
    } as GovernedApprovalRequest)) as GovernedApprovalRequest;
  const grant = new GrantService({ store, clock, ids }).create({
    kind: "one_time",
    intent,
    approvalRequestId: approval.id,
    expiresAt: intent.expiresAt,
    maxUses: 1,
    maxTotalCostMicros: 0,
    scope: {
      capabilityRef: intent.capabilityRef,
      capabilityVersion: intent.capabilityVersion,
      operations: [intent.operation],
      exactResourceRef: intent.resourceRef,
      resourceIdentities: [...intent.resourceRefs],
      resourcePrefixes: [],
      maxDataClassification: intent.dataClassification,
      sideEffects: [intent.sideEffect],
      maxCostMicrosPerUse: 0,
      maxFrequency: intent.frequency,
      disclosure: intent.disclosure,
      recipients: [...intent.recipients],
      credentialOrAccessChange: false,
    },
  });
  approval = await new ApprovalService({ store, clock }).respond({
    approvalRequestId: approval.id,
    expectedRevision: approval.revision,
    semanticSnapshotHash: approval.semanticSnapshotHash,
    response: { decision: "approved", grant, recentAuthenticationRef: null },
  });
  await input.appendAudit({
    id: input.auditId,
    ownerId: intent.ownerId,
    agentId: intent.agentId,
    action: input.auditAction,
    targetRef: approval.id,
    outcome: "completed",
    occurredAt: approval.decidedAt ?? clock.now(),
  });
}
