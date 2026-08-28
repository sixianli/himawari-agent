import {
  ApprovalService,
  CapabilityLifecycleService,
  GovernanceGatewayV2ControlPlane,
  GovernanceGatewayV2ReadModel,
  GrantService,
  PORT_ERROR_CODES,
  actionIntentFingerprint,
  type CapabilityManifest,
  type GatewayAuthenticationContext,
  type GatewayV2ControlPlanePort,
  type GatewayV2ReadModelPort,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
  type GovernanceDependencyReadPort,
} from "@himawari-agent/application";
import {
  createAgentId,
  createIdempotencyKey,
  createOwnerId,
  createRunId,
} from "@himawari-agent/domain";
import {
  gatewayV2MessageSchema,
  type GatewayV2Command,
  type GatewayV2Query,
} from "@himawari-agent/gateway-contracts";
import {
  InMemoryAuditLedger,
  InMemoryAuthorizationStore,
  InMemoryCapabilityRegistryStore,
  InMemoryGovernanceMutationReceiptStore,
  ManualClock,
  createReferenceAdapterSet,
} from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-governance-ui");
const AGENT_ID = createAgentId("agent-governance-ui");
const RUN_ID = createRunId("run-governance-ui");
const NOW = "2026-08-28T02:00:00.000Z";
const EXPIRES_AT = "2026-08-28T03:00:00.000Z";
const HASH = `sha256:${"b".repeat(64)}`;

const AUTHENTICATION: GatewayAuthenticationContext = {
  subjectId: "owner-subject",
  ownerId: OWNER_ID,
  deviceId: "device-governance-ui",
  authenticatedAt: NOW,
  authenticationRef: "recent-auth-governance-ui",
};

const AUTHORITY = {
  deploymentId: "deployment-governance-ui",
  authorityEpoch: 4,
  fencingToken: 9,
} as const;

function manifest(): CapabilityManifest {
  return {
    manifestVersion: "capability.v2",
    ref: "governed-ui-tool",
    displayName: "Governed UI Tool",
    version: "1.0.0",
    source: { type: "tool", locator: "tool:governed-ui-tool:1.0.0" },
    sourceIdentity: "tool:trusted-publisher",
    integrity: HASH,
    artifact: {
      digest: HASH,
      signatureStatus: "not_applicable",
      signerRef: null,
      rollbackArtifactRef: null,
    },
    operations: ["read"],
    permissionRefs: ["permission:governed-ui-tool"],
    scopes: {
      dataClassifications: ["private"],
      network: [],
      filesystem: ["workspace:governed-ui"],
      secrets: ["secret-ref:provider-token"],
    },
    isolation: "worker",
    cost: { currency: "USD", maxMicrosPerInvocation: 2_000 },
    health: { status: "healthy", checkedAt: NOW },
    reviewedBy: null,
    reviewedAt: null,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: { kind: "pi_tool", piBuiltinDefinition: "read" },
  };
}

function intent(): GovernedActionIntent {
  return {
    contractVersion: "authorization.v2",
    id: "intent-governance-ui",
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: "thread-governance-ui",
    runId: RUN_ID,
    actionKind: "READ",
    capabilityRef: "governed-ui-tool",
    capabilityVersion: "1.0.0",
    operation: "read",
    targets: [{ type: "workspace", ref: "workspace:governed-ui" }],
    resourceRef: "workspace:governed-ui",
    resourceRefs: ["workspace:governed-ui"],
    dataClassification: "private",
    disclosure: "none",
    sideEffect: "none",
    recipients: [],
    estimatedCostMicros: 500,
    frequency: { count: 1, intervalMs: null },
    credentialOrAccessChange: false,
    idempotencyKey: createIdempotencyKey("intent-governance-ui"),
    reversible: true,
    requestedAt: NOW,
    expiresAt: EXPIRES_AT,
    modelClassification: {
      actionKind: "READ",
      suggestedRisk: "HIGH",
      reasonCode: "model-governance-ui",
    },
    deterministicFacts: [
      { code: "private_workspace_read", minimumRisk: "HIGH", source: "product" },
    ],
    finalRisk: "HIGH",
  };
}

function requestEnvelope(type: string, messageId: string) {
  return {
    schemaVersion: "gateway.v2",
    type,
    messageId,
    correlationId: "correlation-governance-ui",
    causationId: null,
    dataClassification: "private",
    risk: "high",
    authorizationRef: "authorization-governance-ui",
    scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
    authority: AUTHORITY,
    actor: { actorType: "owner", actorId: AUTHENTICATION.subjectId },
  } as const;
}

function command(
  type: GatewayV2Command["type"],
  messageId: string,
  idempotencyKey: string,
  payload: unknown,
): GatewayV2Command {
  const parsed = gatewayV2MessageSchema.parse({
    ...requestEnvelope(type, messageId),
    kind: "command",
    idempotencyKey,
    payload,
  });
  if (parsed.kind !== "command") throw new Error("expected command");
  return parsed;
}

function query(type: GatewayV2Query["type"], messageId: string, payload: unknown): GatewayV2Query {
  const parsed = gatewayV2MessageSchema.parse({
    ...requestEnvelope(type, messageId),
    kind: "query",
    payload,
  });
  if (parsed.kind !== "query") throw new Error("expected query");
  return parsed;
}

async function fixture() {
  const clock = new ManualClock(NOW);
  const ids = createReferenceAdapterSet({ clock }).ids;
  const authorization = new InMemoryAuthorizationStore();
  const capabilities = new InMemoryCapabilityRegistryStore();
  const receipts = new InMemoryGovernanceMutationReceiptStore();
  const audit = new InMemoryAuditLedger();
  let qualificationAvailable = true;
  const lifecycle = new CapabilityLifecycleService({
    store: capabilities,
    clock,
    artifacts: {
      verify: async (candidate) => ({
        verificationVersion: "capability-artifact-verification.v1",
        artifactDigest: candidate.integrity,
        signatureStatus: candidate.artifact.signatureStatus,
        signerRef: candidate.artifact.signerRef,
        verified: true,
        reasonCodes: [],
        verifiedAt: clock.now(),
      }),
    },
    runtime: {
      qualify: async (candidate) => ({
        qualificationVersion: "capability-runtime-qualification.v1",
        platform: "darwin",
        runtimeIdentity: "governance-ui-fixture",
        productionSuitable: qualificationAvailable,
        artifactDigest: candidate.integrity,
        enforcement: {
          filesystem: qualificationAvailable,
          network: qualificationAvailable,
          processes: qualificationAvailable,
          secrets: qualificationAvailable,
          resourceCeilings: qualificationAvailable,
          termination: qualificationAvailable,
        },
        reasonCodes: qualificationAvailable ? [] : ["fixture_qualification_blocked"],
        checkedAt: clock.now(),
      }),
    },
  });
  const action = intent();
  const approval: GovernedApprovalRequest = {
    id: "approval-governance-ui",
    revision: 1,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    intentId: action.id,
    intentSnapshot: action,
    semanticSnapshotHash: actionIntentFingerprint(action),
    status: "pending",
    deliveryState: "deliverable",
    requestedAt: NOW,
    expiresAt: EXPIRES_AT,
    decidedAt: null,
    grantId: null,
    finalRisk: "HIGH",
    recentAuthenticationRequired: true,
    recentAuthenticationRef: null,
  };
  await authorization.createApproval(approval);
  await lifecycle.discover(manifest());
  await lifecycle.reviewRequired(manifest().ref);

  const delegateControl: GatewayV2ControlPlanePort = {
    async execute() {
      throw new Error("unexpected non-governance command");
    },
  };
  const delegateReads: GatewayV2ReadModelPort = {
    async query() {
      throw new Error("unexpected non-governance query");
    },
    async *subscribe() {
      // No governance-specific stream events in this adapter.
    },
  };
  const dependencyReads: GovernanceDependencyReadPort = {
    async listTaskRefsByCapability() {
      return ["task-capability-dependent"];
    },
    async listTaskRefsByGrant() {
      return ["task-grant-dependent"];
    },
    async trueResultRefForApproval(approvalRequestId) {
      return `result:${approvalRequestId}`;
    },
  };
  const grants = new GrantService({ store: authorization, clock, ids });
  const control = new GovernanceGatewayV2ControlPlane({
    delegate: delegateControl,
    receipts,
    authorization,
    capabilities,
    approvalService: new ApprovalService({ store: authorization, clock }),
    grantService: grants,
    capabilityLifecycle: lifecycle,
    audit,
    clock,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
  });
  const reads = new GovernanceGatewayV2ReadModel({
    delegate: delegateReads,
    authorization,
    capabilities,
    dependencies: dependencyReads,
    clock,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
  });
  return {
    approval,
    authorization,
    capabilities,
    control,
    reads,
    lifecycle,
    setQualificationAvailable(value: boolean) {
      qualificationAvailable = value;
    },
  };
}

describe("S4 Task 11 governance Control Center boundary", () => {
  it("projects frozen Approval and Grant truth, then resolves and revokes with revision and idempotency", async () => {
    const setup = await fixture();
    const approvalBefore = await setup.reads.query(
      query("approval.detail", "query-approval-before", {
        approvalRequestId: setup.approval.id,
      }),
    );
    expect(approvalBefore).toMatchObject({
      type: "approval.snapshot",
      dataClassification: "private",
      risk: "high",
      payload: {
        revision: 1,
        status: "pending",
        semanticSnapshotHash: setup.approval.semanticSnapshotHash,
        recentAuthenticationRequired: true,
        trueResultRef: `result:${setup.approval.id}`,
        intent: {
          capabilityRef: "governed-ui-tool",
          resourceRefs: ["workspace:governed-ui"],
          deterministicFactCodes: ["private_workspace_read"],
        },
      },
    });

    const approve = command("approval.respond", "command-approve", "idem-approve", {
      approvalRequestId: setup.approval.id,
      expectedRevision: 1,
      decision: "approved",
      semanticSnapshotHash: setup.approval.semanticSnapshotHash,
      editedPayloadRef: null,
      recentAuthenticationRef: AUTHENTICATION.authenticationRef,
    });
    await expect(
      setup.control.execute({ authentication: AUTHENTICATION, command: approve }),
    ).resolves.toEqual({ resultRef: `approval:${setup.approval.id}:revision-2`, replayed: false });
    await expect(
      setup.control.execute({ authentication: AUTHENTICATION, command: approve }),
    ).resolves.toEqual({ resultRef: `approval:${setup.approval.id}:revision-2`, replayed: true });

    const resolved = await setup.authorization.getApproval(setup.approval.id);
    expect(resolved).toMatchObject({
      status: "approved",
      revision: 2,
      recentAuthenticationRef: AUTHENTICATION.authenticationRef,
    });
    if (!resolved?.grantId) throw new Error("expected Grant");
    const grantSnapshot = await setup.reads.query(
      query("grant.detail", "query-grant", { grantId: resolved.grantId }),
    );
    expect(grantSnapshot).toMatchObject({
      type: "grant.snapshot",
      payload: {
        status: "active",
        capabilityRef: "governed-ui-tool",
        capabilityVersion: "1.0.0",
        affectedTaskRefs: ["task-grant-dependent"],
      },
    });

    const revoke = command("grant.revoke", "command-revoke", "idem-revoke", {
      grantId: resolved.grantId,
      expectedRevision: 1,
      reasonCode: "owner_revoked",
    });
    await expect(
      setup.control.execute({ authentication: AUTHENTICATION, command: revoke }),
    ).resolves.toEqual({ resultRef: `grant:${resolved.grantId}:revision-2`, replayed: false });
    const revoked = await setup.reads.query(
      query("grant.detail", "query-grant-revoked", { grantId: resolved.grantId }),
    );
    expect(revoked).toMatchObject({
      payload: { revision: 2, status: "revoked", revocationReasonCode: "owner_revoked" },
    });
    await expect(
      setup.control.execute({
        authentication: AUTHENTICATION,
        command: command("grant.revoke", "command-revoke-stale", "idem-revoke-stale", {
          grantId: resolved.grantId,
          expectedRevision: 1,
          reasonCode: "different_reason",
        }),
      }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
  });

  it("recovers an installation command after qualification failure without duplicating approval", async () => {
    const setup = await fixture();
    const capabilityRef = manifest().ref;
    const review = command("capability.review", "command-review", "idem-review", {
      capabilityRef,
      expectedRevision: 2,
    });
    await setup.control.execute({ authentication: AUTHENTICATION, command: review });
    expect(await setup.lifecycle.authorizedManifests()).toEqual([]);

    setup.setQualificationAvailable(false);
    const install = command("capability.install.approve", "command-install", "idem-install", {
      capabilityRef,
      expectedRevision: 3,
      approvalRef: "approval-install-governance-ui",
    });
    await expect(
      setup.control.execute({ authentication: AUTHENTICATION, command: install }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    expect(await setup.capabilities.get(capabilityRef)).toMatchObject({
      lifecycle: "installation_approved",
      revision: 4,
      approvalRefs: ["approval-install-governance-ui"],
    });

    setup.setQualificationAvailable(true);
    await expect(
      setup.control.execute({ authentication: AUTHENTICATION, command: install }),
    ).resolves.toEqual({ resultRef: `capability:${capabilityRef}:revision-5`, replayed: true });
    expect(await setup.lifecycle.authorizedManifests()).toHaveLength(1);

    const snapshot = await setup.reads.query(
      query("capability.detail", "query-capability", { capabilityRef }),
    );
    expect(snapshot).toMatchObject({
      type: "capability.snapshot",
      payload: {
        revision: 5,
        lifecycle: "active",
        secretRefs: ["secret-ref:provider-token"],
        dependencyTaskRefs: ["task-capability-dependent"],
        runtimeQualification: { productionSuitable: true },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("RAW-SECRET-MATERIAL");

    const disable = command("capability.disable", "command-disable", "idem-disable", {
      capabilityRef,
      expectedRevision: 5,
      reasonCode: "owner_disabled",
    });
    await setup.control.execute({ authentication: AUTHENTICATION, command: disable });
    expect(await setup.lifecycle.authorizedManifests()).toEqual([]);
    await expect(
      setup.control.execute({
        authentication: AUTHENTICATION,
        command: command("capability.disable", "command-disable-stale", "idem-disable-stale", {
          capabilityRef,
          expectedRevision: 5,
          reasonCode: "stale_tab",
        }),
      }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
  });

  it("rejects changed idempotency semantics and mismatched recent authentication", async () => {
    const setup = await fixture();
    const first = command("capability.review", "command-review-first", "idem-shared", {
      capabilityRef: manifest().ref,
      expectedRevision: 2,
    });
    await setup.control.execute({ authentication: AUTHENTICATION, command: first });
    await expect(
      setup.control.execute({
        authentication: AUTHENTICATION,
        command: command("capability.review", "command-review-changed", "idem-shared", {
          capabilityRef: manifest().ref,
          expectedRevision: 3,
        }),
      }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });

    await expect(
      setup.control.execute({
        authentication: AUTHENTICATION,
        command: command("approval.respond", "command-wrong-auth", "idem-wrong-auth", {
          approvalRequestId: setup.approval.id,
          expectedRevision: 1,
          decision: "approved",
          semanticSnapshotHash: setup.approval.semanticSnapshotHash,
          editedPayloadRef: null,
          recentAuthenticationRef: "recent-auth-other-session",
        }),
      }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
  });
});
