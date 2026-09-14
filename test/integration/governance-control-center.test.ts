import {
  ApplicationPortError,
  ApprovalService,
  actionIntentFingerprint,
  CapabilityLifecycleService,
  type CapabilityManifest,
  type GatewayAuthenticationContext,
  type GatewayV2ControlPlanePort,
  type GatewayV2ReadModelPort,
  type GovernanceDependencyReadPort,
  GovernanceGatewayV2ControlPlane,
  GovernanceGatewayV2ReadModel,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
  GrantService,
  PORT_ERROR_CODES,
  type RecentAuthenticationGuardPort,
} from "@himawari-agent/application";
import {
  createAgentId,
  createDeviceId,
  createIdempotencyKey,
  createOwnerId,
  createRunId,
} from "@himawari-agent/domain";
import {
  type GatewayV2Command,
  type GatewayV2Query,
  gatewayV2MessageSchema,
} from "@himawari-agent/gateway-contracts";
import {
  createReferenceAdapterSet,
  InMemoryAuditLedger,
  InMemoryAuthorizationStore,
  InMemoryCapabilityRegistryStore,
  InMemoryGovernanceMutationReceiptStore,
  ManualClock,
} from "@himawari-agent/testing";
import { describe, expect, it, vi } from "vitest";

const OWNER_ID = createOwnerId("owner-governance-ui");
const AGENT_ID = createAgentId("agent-governance-ui");
const RUN_ID = createRunId("run-governance-ui");
const NOW = "2026-08-28T02:00:00.000Z";
const EXPIRES_AT = "2026-08-28T03:00:00.000Z";
const HASH = `sha256:${"b".repeat(64)}`;
const AUTHENTICATION_DEVICE_ID = createDeviceId("device-governance-ui");

const AUTHENTICATION: GatewayAuthenticationContext = {
  subjectId: "owner-subject",
  ownerId: OWNER_ID,
  deviceId: AUTHENTICATION_DEVICE_ID,
  authenticatedAt: NOW,
  authenticationRef: "recent-auth-governance-ui",
};

const RECENT_AUTHENTICATION: RecentAuthenticationGuardPort = {
  async assertRecentAuthentication({ authentication, expectedAuthenticationRef }) {
    if (
      expectedAuthenticationRef !== authentication.authenticationRef ||
      !Number.isFinite(Date.parse(authentication.authenticatedAt))
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Recent Owner authentication evidence is required",
        { reasonCode: "RECENT_AUTH_REQUIRED" },
      );
    }
    return {
      source: "provider_step_up",
      externalSubjectRef: "fixture:owner-subject",
      ownerId: OWNER_ID,
      deviceId: AUTHENTICATION_DEVICE_ID,
      authenticationRef: authentication.authenticationRef,
      authenticatedAt: authentication.authenticatedAt,
      expiresAt: EXPIRES_AT,
    };
  },
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
    targets: [{ type: "workspace", ref: "/data/hermes/himawari/workspaces/验收目录" }],
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
    recentAuthentication: RECENT_AUTHENTICATION,
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
    clock,
    audit,
    receipts,
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
  it("shows elapsed pending approvals as expired without claiming an Owner decision", async () => {
    const setup = await fixture();
    setup.clock.set(EXPIRES_AT);
    const detail = await setup.reads.query(
      query("approval.detail", "expired-detail", { approvalRequestId: setup.approval.id }),
    );
    expect(detail).toMatchObject({
      type: "approval.snapshot",
      payload: { status: "expired", decidedAt: null },
    });
    const pending = await setup.reads.query(
      query("approval.list", "pending-after-expiry", {
        status: "pending",
        afterCursor: null,
        limit: 100,
      }),
    );
    expect(pending).toMatchObject({ type: "collection.snapshot", payload: { itemRefs: [] } });
    const expired = await setup.reads.query(
      query("approval.list", "expired-list", { status: "expired", afterCursor: null, limit: 100 }),
    );
    expect(expired).toMatchObject({
      type: "collection.snapshot",
      payload: { itemRefs: [setup.approval.id] },
    });
    expect((await setup.authorization.getApproval(setup.approval.id))?.decidedAt).toBeNull();
  });

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
          targetRefs: ["/data/hermes/himawari/workspaces/验收目录"],
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

  it("does not authorize a critical approval from a matching ref without valid freshness evidence", async () => {
    const setup = await fixture();
    const invalidAuthentication: GatewayAuthenticationContext = {
      ...AUTHENTICATION,
      authenticatedAt: "not-a-date",
    };
    const approve = command(
      "approval.respond",
      "command-invalid-auth-time",
      "idem-invalid-auth-time",
      {
        approvalRequestId: setup.approval.id,
        expectedRevision: 1,
        decision: "approved",
        semanticSnapshotHash: setup.approval.semanticSnapshotHash,
        editedPayloadRef: null,
        recentAuthenticationRef: invalidAuthentication.authenticationRef,
      },
    );

    await expect(
      setup.control.execute({ authentication: invalidAuthentication, command: approve }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
  });
});

describe("governance recovery and read boundaries", () => {
  async function execute(setup: Awaited<ReturnType<typeof fixture>>, value: GatewayV2Command) {
    return setup.control.execute({ authentication: AUTHENTICATION, command: value });
  }
  async function interruptAfterMutation(
    setup: Awaited<ReturnType<typeof fixture>>,
    value: GatewayV2Command,
  ) {
    vi.spyOn(setup.audit, "append").mockRejectedValueOnce(
      new Error("audit temporarily unavailable"),
    );
    await expect(execute(setup, value)).rejects.toThrow("audit temporarily unavailable");
    const receipt = await setup.receipts.get(OWNER_ID, AGENT_ID, value.idempotencyKey);
    expect(receipt).toMatchObject({ phase: "executing", resultRef: null });
    const result = await execute(setup, value);
    expect(result.replayed).toBe(true);
    expect(await execute(setup, value)).toEqual(result);
    expect(await setup.receipts.get(OWNER_ID, AGENT_ID, value.idempotencyKey)).toMatchObject({
      phase: "completed",
      resultRef: result.resultRef,
    });
    return result;
  }
  async function activate(setup: Awaited<ReturnType<typeof fixture>>) {
    await execute(
      setup,
      command("capability.review", "review-before-update", "review-before-update", {
        capabilityRef: manifest().ref,
        expectedRevision: 2,
      }),
    );
    await execute(
      setup,
      command("capability.install.approve", "install-before-update", "install-before-update", {
        capabilityRef: manifest().ref,
        expectedRevision: 3,
        approvalRef: "approval-install",
      }),
    );
    const installed = await setup.capabilities.get(manifest().ref);
    if (!installed) throw new Error("Expected installed capability");
    return installed;
  }
  it("recovers source review, completed installation and disable without repeating mutation", async () => {
    const setup = await fixture();
    const capabilityRef = manifest().ref;
    await interruptAfterMutation(
      setup,
      command("capability.review", "review-recover", "review-recover", {
        capabilityRef,
        expectedRevision: 2,
      }),
    );
    expect(await setup.capabilities.get(capabilityRef)).toMatchObject({
      revision: 3,
      lifecycle: "installation_proposed",
    });
    await interruptAfterMutation(
      setup,
      command("capability.install.approve", "install-recover", "install-recover", {
        capabilityRef,
        expectedRevision: 3,
        approvalRef: "approval-recover-install",
      }),
    );
    expect(await setup.capabilities.get(capabilityRef)).toMatchObject({
      revision: 5,
      lifecycle: "active",
    });
    await interruptAfterMutation(
      setup,
      command("capability.disable", "disable-recover", "disable-recover", {
        capabilityRef,
        expectedRevision: 5,
        reasonCode: "owner_disabled",
      }),
    );
    expect(await setup.capabilities.get(capabilityRef)).toMatchObject({
      revision: 6,
      lifecycle: "disabled",
    });
  });
  it.each(["approved", "denied"] as const)(
    "recovers a committed %s approval without creating a second grant",
    async (decision) => {
      const setup = await fixture();
      await interruptAfterMutation(
        setup,
        command("approval.respond", "approval-recover", "approval-recover", {
          approvalRequestId: setup.approval.id,
          expectedRevision: 1,
          decision,
          semanticSnapshotHash: setup.approval.semanticSnapshotHash,
          editedPayloadRef: null,
          recentAuthenticationRef: AUTHENTICATION.authenticationRef,
        }),
      );
      const grants = await setup.authorization.listGrants(OWNER_ID, AGENT_ID);
      expect(grants).toHaveLength(decision === "approved" ? 1 : 0);
      expect(await setup.authorization.getApproval(setup.approval.id)).toMatchObject({
        revision: 2,
        status: decision,
      });
      if (decision === "approved") {
        const grant = grants[0];
        if (!grant) throw new Error("Expected approved grant");
        await interruptAfterMutation(
          setup,
          command("grant.revoke", "grant-recover", "grant-recover", {
            grantId: grant.id,
            expectedRevision: 1,
            reasonCode: "owner_revoked",
          }),
        );
        expect(
          await setup.reads.query(
            query("grant.list", "grants-current", {
              includeRevoked: false,
              afterCursor: null,
              limit: 10,
            }),
          ),
        ).toMatchObject({ payload: { itemRefs: [] } });
        expect(
          await setup.reads.query(
            query("grant.list", "grants-all", {
              includeRevoked: true,
              afterCursor: null,
              limit: 10,
            }),
          ),
        ).toMatchObject({ payload: { itemRefs: [grant.id] } });
      }
    },
  );
  it.each(["approved", "denied"] as const)(
    "recovers a committed %s capability update",
    async (decision) => {
      const setup = await fixture();
      const active = await activate(setup);
      const candidate = { ...manifest(), version: "2.0.0" };
      const proposed = await setup.lifecycle.proposeUpdate(active.ref, candidate, {
        policyRef: "owner-update-policy",
        allowAutomaticCompatibleUpdates: false,
      });
      await interruptAfterMutation(
        setup,
        command("capability.update.respond", "update-recover", "update-recover", {
          capabilityRef: active.ref,
          expectedRevision: proposed.revision,
          decision,
          approvalRef: decision === "approved" ? "approval-update" : null,
        }),
      );
      const current = await setup.capabilities.get(active.ref);
      if (!current) throw new Error("Expected active capability");
      expect(current).toMatchObject({
        lifecycle: "active",
        declaration: { version: decision === "approved" ? "2.0.0" : "1.0.0" },
        lastVersionTransition: { outcome: decision === "approved" ? "activated" : "rejected" },
      });
      if (decision === "approved") {
        await interruptAfterMutation(
          setup,
          command("capability.rollback", "rollback-recover", "rollback-recover", {
            capabilityRef: active.ref,
            expectedRevision: current.revision,
            reasonCode: "owner_rollback",
          }),
        );
        expect(await setup.capabilities.get(active.ref)).toMatchObject({
          declaration: { version: "1.0.0" },
          lastVersionTransition: { outcome: "rolled_back" },
        });
      }
    },
  );
  it("resumes an approved update after transient runtime qualification failure", async () => {
    const setup = await fixture();
    const active = await activate(setup);
    const proposed = await setup.lifecycle.proposeUpdate(
      active.ref,
      { ...manifest(), version: "2.0.0" },
      { policyRef: "owner-update-policy", allowAutomaticCompatibleUpdates: false },
    );
    const update = command(
      "capability.update.respond",
      "update-qualification",
      "update-qualification",
      {
        capabilityRef: active.ref,
        expectedRevision: proposed.revision,
        decision: "approved",
        approvalRef: "approval-update",
      },
    );
    setup.setQualificationAvailable(false);
    await expect(execute(setup, update)).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
    });
    expect(await setup.capabilities.get(active.ref)).toMatchObject({
      lifecycle: "update_approved",
      revision: proposed.revision + 1,
    });
    setup.setQualificationAvailable(true);
    expect(await execute(setup, update)).toMatchObject({ replayed: true });
    expect(await setup.capabilities.get(active.ref)).toMatchObject({
      lifecycle: "active",
      revision: proposed.revision + 2,
      declaration: { version: "2.0.0" },
    });
  });
  it("paginates a stable approval list and rejects an unknown cursor", async () => {
    const setup = await fixture();
    await setup.authorization.createApproval({ ...setup.approval, id: "approval-z" });
    expect(
      await setup.reads.query(
        query("approval.list", "page-one", { status: null, afterCursor: null, limit: 1 }),
      ),
    ).toMatchObject({ payload: { itemRefs: [setup.approval.id], nextCursor: setup.approval.id } });
    expect(
      await setup.reads.query(
        query("approval.list", "page-two", {
          status: null,
          afterCursor: setup.approval.id,
          limit: 1,
        }),
      ),
    ).toMatchObject({ payload: { itemRefs: ["approval-z"], nextCursor: null } });
    await expect(
      setup.reads.query(
        query("approval.list", "page-invalid", { status: null, afterCursor: "missing", limit: 1 }),
      ),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_FOUND });
    expect(
      await setup.reads.query(
        query("capability.list", "capability-filter", {
          lifecycle: "active",
          afterCursor: null,
          limit: 10,
        }),
      ),
    ).toMatchObject({ payload: { itemRefs: [] } });
    expect(
      await setup.reads.query(
        query("capability.list", "capability-all", {
          lifecycle: null,
          afterCursor: null,
          limit: 10,
        }),
      ),
    ).toMatchObject({ payload: { itemRefs: [manifest().ref] } });
  });
  it.each(["approval.detail", "capability.detail", "grant.detail"] as const)(
    "reports missing %s without fabricating a snapshot",
    async (type) => {
      const setup = await fixture();
      const payload =
        type === "approval.detail"
          ? { approvalRequestId: "missing" }
          : type === "capability.detail"
            ? { capabilityRef: "missing" }
            : { grantId: "missing" };
      await expect(setup.reads.query(query(type, "missing", payload))).rejects.toMatchObject({
        code: PORT_ERROR_CODES.NOT_FOUND,
      });
    },
  );
  it("rejects edited approval content instead of approving an unfrozen intent", async () => {
    const setup = await fixture();
    await expect(
      execute(
        setup,
        command("approval.respond", "edited-approval", "edited-approval", {
          approvalRequestId: setup.approval.id,
          expectedRevision: 1,
          decision: "approved",
          semanticSnapshotHash: setup.approval.semanticSnapshotHash,
          editedPayloadRef: "edited-content",
          recentAuthenticationRef: AUTHENTICATION.authenticationRef,
        }),
      ),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.INVALID_OPERATION });
    expect(await setup.authorization.getApproval(setup.approval.id)).toMatchObject({
      status: "pending",
      revision: 1,
    });
    expect(await setup.authorization.listGrants(OWNER_ID, AGENT_ID)).toEqual([]);
  });
});
