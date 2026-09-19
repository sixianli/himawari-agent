import {
  actionIntentFingerprintMatches,
  legacyActionIntentFingerprint,
} from "@himawari-agent/application/action-intent-snapshot";
import {
  ACTION_KINDS,
  ACTION_KIND_RISK_BASELINE,
  ActionPolicyService,
  ApprovalService,
  CapabilityHandleService,
  CapabilityLifecycleService,
  ExecutionWorkerService,
  GrantService,
  PORT_ERROR_CODES,
  actionIntentFingerprint,
  assessActionIntentCompleteness,
  computeActionRisk,
  validateCapabilityManifest,
  validateGovernedActionIntent,
  type ActionKind,
  type ActionRiskLevel,
  type CapabilityArtifactVerifierPort,
  type CapabilityManifest,
  type GovernedActionIntent,
  type GovernedGrantScope,
  type GovernedGrantRecord,
  type PermissionPolicy,
} from "@himawari-agent/application";
import {
  createAgentId,
  createIdempotencyKey,
  createOwnerId,
  createRunId,
} from "@himawari-agent/domain";
import {
  EXECUTION_SCHEMA_VERSION,
  type ExecuteWorkRequest,
} from "@himawari-agent/execution-contracts";
import {
  InMemoryAuthorizationStore,
  InMemoryCapabilityRegistryStore,
  ManualClock,
  createReferenceAdapterSet,
} from "@himawari-agent/testing";
import { describe, expect, it, vi } from "vitest";

const OWNER_ID = createOwnerId("owner-governance-v2");
const AGENT_ID = createAgentId("agent-governance-v2");
const RUN_ID = createRunId("run-governance-v2");
const T0 = "2026-08-28T00:00:00.000Z";
const T1 = "2026-08-28T00:01:00.000Z";
const T2 = "2026-08-28T01:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;

const POLICY: PermissionPolicy = {
  version: "authorization-policy-v2",
  rules: [
    {
      id: "deny-account-root",
      effect: "DENY",
      capabilityRefs: ["governed-tool"],
      operations: ["delete"],
      resourcePrefixes: ["account:"],
      dataClassifications: ["restricted"],
      sideEffects: ["irreversible"],
      maxCostMicros: 0,
      reasonCode: "account_root_denied",
    },
    {
      id: "allow-bounded-read",
      effect: "ALLOW",
      capabilityRefs: ["governed-tool"],
      operations: ["read"],
      resourcePrefixes: ["repo:approved/"],
      dataClassifications: ["public", "private"],
      sideEffects: ["none"],
      maxCostMicros: 1_000,
      reasonCode: "bounded_read_allowed",
    },
  ],
};

function manifest(
  sourceType: CapabilityManifest["source"]["type"] = "tool",
  ref = "governed-tool",
): CapabilityManifest {
  const runtime: CapabilityManifest["runtime"] =
    sourceType === "tool"
      ? { kind: "pi_tool", piBuiltinDefinition: "read" }
      : sourceType === "skill"
        ? { kind: "pi_resource", additionalResourcePaths: ["skill:approved/research"] }
        : sourceType === "mcp"
          ? {
              kind: "mcp",
              serverIdentity: "mcp:approved",
              transport: "stdio:v1",
              mappedResources: ["tool:search"],
            }
          : sourceType === "program"
            ? {
                kind: "program",
                argv: ["program:approved", "--json"],
                environmentKeys: ["LANG"],
                workdirRef: "workspace:approved",
                stdin: "protected_payload",
                stdout: "protected_payload",
                subprocesses: [],
                network: ["api.example.test:443"],
                filesystem: ["workspace:approved"],
              }
            : {
                kind: sourceType === "adapter" ? "adapter" : "remote_api",
                endpointIdentity: `${sourceType}:approved`,
                protectedReferenceOnly: true,
              };
  return {
    manifestVersion: "capability.v2",
    ref,
    displayName: ref,
    version: "1.0.0",
    source: { type: sourceType, locator: `${sourceType}:${ref}:1.0.0` },
    sourceIdentity: `${sourceType}:trusted-publisher`,
    integrity: HASH,
    artifact: {
      digest: HASH,
      signatureStatus: sourceType === "tool" ? "not_applicable" : "verified",
      signerRef: sourceType === "tool" ? null : "signer:trusted",
      rollbackArtifactRef: null,
    },
    operations: sourceType === "tool" ? ["read", "delete"] : ["execute"],
    permissionRefs: ["resource:approved"],
    scopes: {
      dataClassifications: ["public", "private", "restricted"],
      network: sourceType === "program" ? ["api.example.test:443"] : [],
      filesystem: sourceType === "program" ? ["workspace:approved"] : [],
      secrets: ["provider-token"],
    },
    isolation: sourceType === "remote_api" ? "remote" : "worker",
    cost: { currency: "USD", maxMicrosPerInvocation: 1_000 },
    health: { status: "healthy", checkedAt: T0 },
    reviewedBy: null,
    reviewedAt: null,
    contractCompatibility: ["capability-conformance.v1"],
    runtime,
  };
}

function intent(input: {
  readonly id: string;
  readonly actionKind?: ActionKind;
  readonly finalRisk?: ActionRiskLevel;
  readonly operation?: string;
  readonly resourceRef?: string;
  readonly classification?: GovernedActionIntent["dataClassification"];
  readonly sideEffect?: GovernedActionIntent["sideEffect"];
  readonly reversible?: boolean;
}): GovernedActionIntent {
  const actionKind = input.actionKind ?? "READ";
  const base: GovernedActionIntent = {
    contractVersion: "authorization.v2",
    id: input.id,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: "thread-governance-v2",
    runId: RUN_ID,
    actionKind,
    capabilityRef: "governed-tool",
    capabilityVersion: "1.0.0",
    operation: input.operation ?? "read",
    targets: [{ type: "repository", ref: "repo:approved/project" }],
    resourceRef: input.resourceRef ?? "repo:approved/project",
    resourceRefs: [input.resourceRef ?? "repo:approved/project"],
    dataClassification: input.classification ?? "private",
    disclosure: "none",
    sideEffect: input.sideEffect ?? "none",
    recipients: [],
    estimatedCostMicros: 100,
    frequency: { count: 1, intervalMs: null },
    credentialOrAccessChange: false,
    idempotencyKey: createIdempotencyKey(`idempotency-${input.id}`),
    reversible: input.reversible ?? true,
    requestedAt: T0,
    expiresAt: T2,
    modelClassification: {
      actionKind,
      suggestedRisk: ACTION_KIND_RISK_BASELINE[actionKind],
      reasonCode: "model_classification",
    },
    deterministicFacts: [],
    finalRisk: input.finalRisk ?? ACTION_KIND_RISK_BASELINE[actionKind],
  };
  return base;
}

async function activeCapability(artifacts?: CapabilityArtifactVerifierPort) {
  const clock = new ManualClock(T0);
  const store = new InMemoryCapabilityRegistryStore();
  const lifecycle = new CapabilityLifecycleService({
    store,
    clock,
    artifacts: artifacts ?? {
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
        runtimeIdentity: "deterministic-governance-fixture",
        productionSuitable: true,
        artifactDigest: candidate.integrity,
        enforcement: {
          filesystem: true,
          network: true,
          processes: true,
          secrets: true,
          resourceCeilings: true,
          termination: true,
        },
        reasonCodes: [],
        checkedAt: clock.now(),
      }),
    },
  });
  await lifecycle.discover(manifest());
  await lifecycle.reviewRequired("governed-tool");
  await lifecycle.recordSourceReview("governed-tool", { reviewer: "owner-review", reviewedAt: T0 });
  await lifecycle.approveInstallation("governed-tool", "approval-install-governed-tool");
  await lifecycle.activate("governed-tool");
  return { clock, store, lifecycle };
}

describe("S4 authorization and capability governance", () => {
  it("freezes all fixed ActionKinds and raises deterministic CRITICAL floors", () => {
    expect(ACTION_KINDS).toHaveLength(11);
    for (const actionKind of ACTION_KINDS) {
      const action = intent({ id: `kind-${actionKind}`, actionKind });
      expect(computeActionRisk(action)).toBe(ACTION_KIND_RISK_BASELINE[actionKind]);
      expect(() => validateGovernedActionIntent(action)).not.toThrow();
    }
    const irreversibleDelete = intent({
      id: "irreversible-delete",
      actionKind: "DELETE",
      operation: "delete",
      resourceRef: "account:owner",
      classification: "restricted",
      sideEffect: "irreversible",
      reversible: false,
      finalRisk: "HIGH",
    });
    expect(computeActionRisk(irreversibleDelete)).toBe("CRITICAL");
    expect(() => validateGovernedActionIntent(irreversibleDelete)).toThrowError(
      expect.objectContaining({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE }),
    );
    expect(() =>
      validateGovernedActionIntent({
        ...intent({ id: "injected" }),
        policyOverride: "ALLOW",
      } as never),
    ).toThrowError(expect.objectContaining({ code: PORT_ERROR_CODES.INVALID_OPERATION }));
    const {
      targets: _targets,
      resourceRefs: _resourceRefs,
      ...incomplete
    } = intent({ id: "clarification" });
    expect(assessActionIntentCompleteness(incomplete)).toEqual({
      complete: false,
      missingFields: ["targets", "resourceRefs"],
    });
  });

  it("orders active/health/scope and deterministic DENY before Grant or bounded READ ALLOW", async () => {
    const capability = await activeCapability();
    const authorization = new InMemoryAuthorizationStore();
    const traces: Array<{ decision: string; reasonCode: string }> = [];
    const service = new ActionPolicyService({
      store: authorization,
      capabilities: {
        inspect: async (ref) => {
          const record = await capability.store.get(ref);
          return record
            ? { lifecycle: record.lifecycle, manifest: record.declaration as CapabilityManifest }
            : undefined;
        },
      },
      clock: capability.clock,
      ids: createReferenceAdapterSet({ clock: capability.clock }).ids,
      policy: POLICY,
      trace: {
        record: async (record) => {
          traces.push(record);
        },
      },
    });
    await expect(
      service.evaluate(intent({ id: "safe-read" }), {
        uiAvailable: true,
        approvalExpiresAt: T1,
      }),
    ).resolves.toMatchObject({ decision: "ALLOW", basis: { type: "policy" } });
    const denied = intent({
      id: "deny-root",
      actionKind: "DELETE",
      finalRisk: "CRITICAL",
      operation: "delete",
      resourceRef: "account:owner",
      classification: "restricted",
      sideEffect: "irreversible",
      reversible: false,
    });
    await expect(
      service.evaluate(denied, { uiAvailable: true, approvalExpiresAt: T1 }),
    ).resolves.toMatchObject({ decision: "DENY", reasonCode: "account_root_denied" });
    expect(traces).toMatchObject([
      { decision: "ALLOW", reasonCode: "bounded_read_allowed" },
      { decision: "DENY", reasonCode: "account_root_denied" },
    ]);
    await capability.lifecycle.disable("governed-tool");
    await expect(
      service.evaluate(intent({ id: "disabled" }), {
        uiAvailable: true,
        approvalExpiresAt: T1,
      }),
    ).resolves.toMatchObject({ decision: "DENY", reasonCode: "capability_not_active" });
  });

  it("persists frozen Approval, requires recent auth for CRITICAL, and consumes one-time Grant idempotently", async () => {
    const capability = await activeCapability();
    const store = new InMemoryAuthorizationStore();
    const ids = createReferenceAdapterSet({ clock: capability.clock }).ids;
    const policy = new ActionPolicyService({
      store,
      capabilities: {
        inspect: async (ref) => {
          const record = await capability.store.get(ref);
          return record
            ? { lifecycle: record.lifecycle, manifest: record.declaration as CapabilityManifest }
            : undefined;
        },
      },
      clock: capability.clock,
      ids,
      policy: { version: "ask-only-v2", rules: [] },
    });
    const action = intent({ id: "grant-once" });
    const ask = await policy.evaluate(action, { uiAvailable: false, approvalExpiresAt: T1 });
    expect(ask).toMatchObject({
      decision: "ASK",
      approvalRequest: { deliveryState: "queued_no_ui" },
    });
    if (ask.decision !== "ASK") throw new Error("expected ASK");
    expect(ask.approvalRequest.semanticSnapshotHash).toBe(actionIntentFingerprint(action));
    const scope: GovernedGrantScope = {
      capabilityRef: action.capabilityRef,
      capabilityVersion: action.capabilityVersion,
      operations: [action.operation],
      exactResourceRef: action.resourceRef,
      resourceIdentities: [...action.resourceRefs],
      resourcePrefixes: [],
      maxDataClassification: action.dataClassification,
      disclosure: action.disclosure,
      sideEffects: [action.sideEffect],
      recipients: [],
      credentialOrAccessChange: false,
      maxCostMicrosPerUse: action.estimatedCostMicros,
      maxFrequency: action.frequency,
    };
    const grants = new GrantService({ store, clock: capability.clock, ids });
    const grant = grants.create({
      kind: "one_time",
      intent: action,
      approvalRequestId: ask.approvalRequest.id,
      scope,
      expiresAt: T1,
      maxUses: 1,
      maxTotalCostMicros: action.estimatedCostMicros,
    });
    const approvals = new ApprovalService({ store, clock: capability.clock });
    await approvals.respond({
      approvalRequestId: ask.approvalRequest.id,
      expectedRevision: ask.approvalRequest.revision,
      semanticSnapshotHash: ask.approvalRequest.semanticSnapshotHash,
      response: { decision: "approved", grant, recentAuthenticationRef: null },
    });
    await expect(
      policy.evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 }),
    ).resolves.toMatchObject({ decision: "ALLOW", basis: { type: "grant", ref: grant.id } });
    await expect(
      policy.evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 }),
    ).resolves.toMatchObject({ decision: "ALLOW", basis: { type: "grant", ref: grant.id } });
    const stored = (await store.listGrants(OWNER_ID, AGENT_ID))[0];
    expect(stored).toMatchObject({ uses: 0, spentCostMicros: 0 });

    const critical = intent({ id: "critical-approval", actionKind: "PUBLICATION" });
    const criticalAsk = await policy.evaluate(critical, {
      uiAvailable: true,
      approvalExpiresAt: T1,
    });
    if (criticalAsk.decision !== "ASK") throw new Error("expected critical ASK");
    const criticalGrant = grants.create({
      kind: "one_time",
      intent: critical,
      approvalRequestId: criticalAsk.approvalRequest.id,
      scope: {
        ...scope,
        operations: [critical.operation],
        resourceIdentities: critical.resourceRefs,
      },
      expiresAt: T1,
      maxUses: 1,
      maxTotalCostMicros: 100,
    });
    await expect(
      approvals.respond({
        approvalRequestId: criticalAsk.approvalRequest.id,
        expectedRevision: criticalAsk.approvalRequest.revision,
        semanticSnapshotHash: criticalAsk.approvalRequest.semanticSnapshotHash,
        response: { decision: "approved", grant: criticalGrant, recentAuthenticationRef: null },
      }),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
    await expect(
      approvals.respond({
        approvalRequestId: criticalAsk.approvalRequest.id,
        expectedRevision: criticalAsk.approvalRequest.revision,
        semanticSnapshotHash: criticalAsk.approvalRequest.semanticSnapshotHash,
        response: {
          decision: "approved",
          grant: criticalGrant,
          recentAuthenticationRef: "recent-auth:owner:critical",
        },
      }),
    ).resolves.toMatchObject({
      status: "approved",
      recentAuthenticationRef: "recent-auth:owner:critical",
    });
  });

  it("enforces reviewed capability lifecycle and invalidates issued Handles", async () => {
    const { clock, store, lifecycle } = await activeCapability();
    const ids = createReferenceAdapterSet({ clock }).ids;
    const handles = new CapabilityHandleService({ store, clock, ids });
    const permission = {
      decision: "ALLOW" as const,
      basis: { type: "grant" as const, ref: "grant-handle-v2" },
      executionScope: {
        capabilityRef: "governed-tool",
        operations: ["read"],
        exactResourceRef: "repo:approved/project",
        resourcePrefixes: [],
        maxDataClassification: "private" as const,
        sideEffects: ["none" as const],
        maxCostMicrosPerUse: 100,
        maxFrequency: { count: 1, intervalMs: null },
      },
    };
    const handle = await handles.issue({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      authorityFence: 7,
      capabilityRef: "governed-tool",
      capabilityVersion: "1.0.0",
      operation: "read",
      permission,
      inputRefs: ["payload:input"],
      delegatedContextRefs: ["payload:context"],
      secretRefs: [{ secretRef: "provider-token", secretVersion: "v1", purpose: "read" }],
      maxUses: 1,
      maxTotalCostMicros: 100,
      expiresAt: T1,
    });
    await expect(handles.endRun(RUN_ID)).resolves.toBe(1);
    await expect(store.getExecutionHandle(handle.ref)).resolves.toMatchObject({
      revision: 2,
      workerEndedAt: T0,
    });
    await lifecycle.disable("governed-tool");
    await expect(store.getExecutionHandle(handle.ref)).resolves.toMatchObject({
      revokedAt: T0,
      workerEndedAt: T0,
    });
  });

  it("makes the Worker revalidate active Grant, scope and current authority fence before invocation", async () => {
    const { clock, store } = await activeCapability();
    const authorization = new InMemoryAuthorizationStore();
    const ids = createReferenceAdapterSet({ clock }).ids;
    const action = intent({ id: "worker-governed-handle" });
    await authorization.createApproval({
      id: "approval-worker-governed",
      revision: 1,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      intentId: action.id,
      intentSnapshot: action,
      semanticSnapshotHash: actionIntentFingerprint(action),
      status: "pending",
      deliveryState: "deliverable",
      requestedAt: T0,
      expiresAt: T2,
      decidedAt: null,
      grantId: null,
    });
    const grants = new GrantService({ store: authorization, clock, ids });
    const grant = grants.create({
      kind: "one_time",
      intent: action,
      approvalRequestId: "approval-worker-governed",
      scope: {
        capabilityRef: action.capabilityRef,
        capabilityVersion: action.capabilityVersion,
        operations: [action.operation],
        exactResourceRef: action.resourceRef,
        resourceIdentities: action.resourceRefs,
        resourcePrefixes: [],
        maxDataClassification: "private",
        disclosure: "none",
        sideEffects: ["none"],
        recipients: [],
        credentialOrAccessChange: false,
        maxCostMicrosPerUse: 100,
        maxFrequency: action.frequency,
      },
      expiresAt: T2,
      maxUses: 1,
      maxTotalCostMicros: 100,
    });
    await authorization.resolveApproval({
      approvalRequestId: "approval-worker-governed",
      expectedRevision: 1,
      semanticSnapshotHash: actionIntentFingerprint(action),
      resolution: "approved",
      decidedAt: T0,
      grant,
    });
    const handles = new CapabilityHandleService({ store, clock, ids });
    const handle = await handles.issue({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      authorityFence: 7,
      capabilityRef: action.capabilityRef,
      capabilityVersion: action.capabilityVersion,
      operation: action.operation,
      permission: {
        decision: "ALLOW",
        basis: { type: "grant", ref: grant.id },
        executionScope: grant.scope,
      },
      inputRefs: ["payload:worker-input"],
      delegatedContextRefs: [],
      secretRefs: [],
      maxUses: 1,
      maxTotalCostMicros: 0,
      expiresAt: T1,
    });
    const adapters = createReferenceAdapterSet({
      clock,
      capability: {
        descriptors: [
          {
            ref: action.capabilityRef,
            version: action.capabilityVersion,
            integrity: HASH,
            lifecycle: "active",
            permissionRefs: [],
            isolation: "worker",
          },
        ],
        events: [
          {
            type: "capability.completed",
            invocationId: "worker-request-governed",
            resultRef: "payload:worker-result",
            occurredAt: T0,
          },
        ],
      },
    });
    let authorityFence = 7;
    const worker = new ExecutionWorkerService({
      handles: store,
      capability: adapters.capability,
      secrets: adapters.secret,
      authorization,
      authorityFence: () => authorityFence,
      clock,
      ids,
    });
    const request: ExecuteWorkRequest = {
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      kind: "request",
      type: "work.execute",
      messageId: "worker-request-governed",
      correlationId: "worker-correlation-governed",
      causationId: action.id,
      dataClassification: "private",
      scope: {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        workerRunId: "worker-run-governed",
      },
      idempotencyKey: "worker-idempotency-governed",
      payload: {
        capabilityId: action.capabilityRef,
        capabilityVersion: action.capabilityVersion,
        operation: action.operation,
        inputRef: "payload:worker-input",
        capabilityHandleRef: handle.ref,
        delegatedContextRefs: [],
        secretRefs: [],
        requestedAt: T0,
        deadlineAt: T1,
      },
    };
    const events = [];
    for await (const event of worker.execute(request)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "work.result", payload: { outcome: "succeeded" } });
    expect(await store.getExecutionHandle(handle.ref)).toMatchObject({ uses: 1, revision: 2 });

    const stale = await handles.issue({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      authorityFence: 7,
      capabilityRef: action.capabilityRef,
      capabilityVersion: action.capabilityVersion,
      operation: action.operation,
      permission: {
        decision: "ALLOW",
        basis: { type: "grant", ref: grant.id },
        executionScope: grant.scope,
      },
      inputRefs: ["payload:worker-input-stale"],
      delegatedContextRefs: [],
      secretRefs: [],
      maxUses: 1,
      maxTotalCostMicros: 0,
      expiresAt: T1,
    });
    authorityFence = 8;
    await expect(
      (async () => {
        for await (const _event of worker.execute({
          ...request,
          messageId: "worker-request-stale-fence",
          idempotencyKey: "worker-idempotency-stale-fence",
          payload: {
            ...request.payload,
            inputRef: "payload:worker-input-stale",
            capabilityHandleRef: stale.ref,
          },
        })) {
          /* consume */
        }
      })(),
    ).rejects.toMatchObject({ code: PORT_ERROR_CODES.HANDLE_REVOKED });
  });

  it.each(["tool", "skill", "mcp", "program", "remote_api", "adapter"] as const)(
    "applies one manifest conformance contract to %s capabilities",
    (sourceType) => {
      expect(() =>
        validateCapabilityManifest(manifest(sourceType, `capability-${sourceType}`)),
      ).not.toThrow();
    },
  );

  it("rejects undeclared program network scope and untrusted manifest integrity", () => {
    const program = manifest("program", "unsafe-program");
    expect(() =>
      validateCapabilityManifest({
        ...program,
        runtime: { ...program.runtime, network: ["unapproved.example:443"] } as never,
      }),
    ).toThrowError(expect.objectContaining({ code: PORT_ERROR_CODES.INVALID_OPERATION }));
    expect(() =>
      validateCapabilityManifest({
        ...manifest("mcp", "tampered-mcp"),
        artifact: { ...manifest("mcp").artifact, signatureStatus: "invalid" },
      }),
    ).toThrowError(expect.objectContaining({ code: PORT_ERROR_CODES.INVALID_OPERATION }));
  });

  it("keeps current authority live during a compatible automatic update, switches atomically, and rolls back only the version", async () => {
    const capability = await activeCapability();
    const current = manifest();
    const candidate: CapabilityManifest = {
      ...current,
      version: "1.1.0",
      source: { ...current.source, locator: "tool:governed-tool:1.1.0" },
      integrity: `sha256:${"b".repeat(64)}`,
      artifact: { ...current.artifact, digest: `sha256:${"b".repeat(64)}` },
      health: { status: "unknown", checkedAt: null },
      reviewedBy: null,
      reviewedAt: null,
    };
    const handle = await capability.store.createExecutionHandle({
      ref: "capability-handle-before-update",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      capabilityRef: current.ref,
      capabilityVersion: current.version,
      authorization: { type: "policy", ref: "policy-compatible-update" },
      operations: ["read"],
      inputRefs: ["payload:update-input"],
      delegatedContextRefs: [],
      secretRefs: [],
      maxDataClassification: "private",
      issuedAt: T0,
      expiresAt: T2,
      revokedAt: null,
    });

    const proposed = await capability.lifecycle.proposeUpdate(current.ref, candidate, {
      policyRef: "owner-policy-compatible-update",
      allowAutomaticCompatibleUpdates: true,
    });
    expect(proposed).toMatchObject({
      lifecycle: "update_approved",
      declaration: { version: "1.0.0" },
      pendingUpdateAssessment: {
        disposition: "automatic",
        risk: "LOW",
        integrityChanged: true,
        executableCodeChanged: false,
        expansions: [],
      },
    });
    await expect(capability.lifecycle.authorizedManifests()).resolves.toMatchObject([
      { version: "1.0.0" },
    ]);
    await expect(capability.store.getExecutionHandle(handle.ref)).resolves.toMatchObject({
      revokedAt: null,
    });

    const activated = await capability.lifecycle.activateUpdate(current.ref);
    expect(activated).toMatchObject({
      lifecycle: "active",
      declaration: { version: "1.1.0", health: { status: "healthy" } },
      rollbackDeclaration: { version: "1.0.0" },
      lastVersionTransition: {
        outcome: "activated",
        externalEffectsRolledBack: false,
        productStateRolledBack: false,
      },
    });
    await expect(capability.store.getExecutionHandle(handle.ref)).resolves.toMatchObject({
      revokedAt: T0,
    });

    const rolledBack = await capability.lifecycle.rollback(current.ref);
    expect(rolledBack).toMatchObject({
      lifecycle: "active",
      declaration: { version: "1.0.0" },
      rollbackDeclaration: null,
      lastVersionTransition: {
        fromVersion: "1.1.0",
        toVersion: "1.0.0",
        outcome: "rolled_back",
        externalEffectsRolledBack: false,
        productStateRolledBack: false,
      },
    });
  });

  it("requires explicit approval for scope expansion or new executable code and rejection preserves the active version", async () => {
    const capability = await activeCapability();
    const current = manifest();
    const expanded: CapabilityManifest = {
      ...current,
      version: "1.1.0",
      integrity: `sha256:${"b".repeat(64)}`,
      artifact: { ...current.artifact, digest: `sha256:${"b".repeat(64)}` },
      operations: [...current.operations, "write"],
    };
    const proposed = await capability.lifecycle.proposeUpdate(current.ref, expanded, {
      policyRef: "owner-policy-compatible-update",
      allowAutomaticCompatibleUpdates: true,
    });
    expect(proposed).toMatchObject({
      lifecycle: "update_proposed",
      declaration: { version: "1.0.0" },
      pendingUpdateAssessment: {
        disposition: "approval_required",
        risk: "HIGH",
        expansions: ["operation:write"],
      },
    });
    const rejected = await capability.lifecycle.rejectUpdate(current.ref);
    expect(rejected).toMatchObject({
      lifecycle: "active",
      declaration: { version: "1.0.0" },
      pendingDeclaration: null,
      lastVersionTransition: { outcome: "rejected" },
    });

    const executable = manifest("mcp", "executable-update");
    const store = new InMemoryCapabilityRegistryStore();
    const clock = new ManualClock(T0);
    const lifecycle = new CapabilityLifecycleService({
      store,
      clock,
      artifacts: {
        verify: async (value) => ({
          verificationVersion: "capability-artifact-verification.v1",
          artifactDigest: value.integrity,
          signatureStatus: value.artifact.signatureStatus,
          signerRef: value.artifact.signerRef,
          verified: true,
          reasonCodes: [],
          verifiedAt: clock.now(),
        }),
      },
      runtime: {
        qualify: async (value) => ({
          qualificationVersion: "capability-runtime-qualification.v1",
          platform: "linux",
          runtimeIdentity: "mcp-fixture",
          productionSuitable: true,
          artifactDigest: value.integrity,
          enforcement: {
            filesystem: true,
            network: true,
            processes: true,
            secrets: true,
            resourceCeilings: true,
            termination: true,
          },
          reasonCodes: [],
          checkedAt: clock.now(),
        }),
      },
    });
    await lifecycle.discover(executable);
    await lifecycle.reviewRequired(executable.ref);
    await lifecycle.recordSourceReview(executable.ref, { reviewer: "owner", reviewedAt: T0 });
    await lifecycle.approveInstallation(executable.ref, "approval:install-mcp");
    await lifecycle.activate(executable.ref);
    const executableCandidate: CapabilityManifest = {
      ...executable,
      version: "1.0.1",
      integrity: `sha256:${"c".repeat(64)}`,
      artifact: { ...executable.artifact, digest: `sha256:${"c".repeat(64)}` },
    };
    await expect(
      lifecycle.proposeUpdate(executable.ref, executableCandidate, {
        policyRef: "owner-policy-compatible-update",
        allowAutomaticCompatibleUpdates: true,
      }),
    ).resolves.toMatchObject({
      lifecycle: "update_proposed",
      pendingUpdateAssessment: {
        disposition: "approval_required",
        risk: "CRITICAL",
        integrityChanged: true,
        executableCodeChanged: true,
        reasonCodes: ["CAPABILITY_UPDATE_EXECUTABLE_CODE_CHANGED"],
      },
    });
  });

  it("fails closed before a version switch when the rollback artifact is no longer verifiable", async () => {
    let rejectRollbackArtifact = false;
    const capability = await activeCapability({
      verify: async (candidate) => ({
        verificationVersion: "capability-artifact-verification.v1",
        artifactDigest: candidate.integrity,
        signatureStatus: candidate.artifact.signatureStatus,
        signerRef: candidate.artifact.signerRef,
        verified: !(rejectRollbackArtifact && candidate.version === "1.0.0"),
        reasonCodes:
          rejectRollbackArtifact && candidate.version === "1.0.0"
            ? ["CAPABILITY_ARTIFACT_DIGEST_MISMATCH"]
            : [],
        verifiedAt: T0,
      }),
    });
    const current = manifest();
    const candidate: CapabilityManifest = {
      ...current,
      version: "1.1.0",
      integrity: `sha256:${"b".repeat(64)}`,
      artifact: { ...current.artifact, digest: `sha256:${"b".repeat(64)}` },
    };
    await capability.lifecycle.proposeUpdate(current.ref, candidate, {
      policyRef: "owner-policy-compatible-update",
      allowAutomaticCompatibleUpdates: true,
    });
    rejectRollbackArtifact = true;
    await expect(capability.lifecycle.activateUpdate(current.ref)).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
    });
    await expect(capability.store.get(current.ref)).resolves.toMatchObject({
      lifecycle: "update_approved",
      declaration: { version: "1.0.0" },
      pendingDeclaration: { version: "1.1.0" },
    });
    await expect(capability.lifecycle.authorizedManifests()).resolves.toMatchObject([
      { version: "1.0.0" },
    ]);
  });
});

async function continuityFixture(rules: PermissionPolicy["rules"] = POLICY.rules) {
  const capability = await activeCapability();
  const store = new InMemoryAuthorizationStore();
  const ids = createReferenceAdapterSet({ clock: capability.clock }).ids;
  const service = (
    policyRules = rules,
    automaticReview?: {
      review(
        input: {
          readonly intent: GovernedActionIntent;
          readonly policyVersion: string;
          readonly deadlineAt: string;
        },
        signal: AbortSignal,
      ): Promise<void>;
    },
  ) =>
    new ActionPolicyService({
      store,
      clock: capability.clock,
      ids,
      policy: { version: "continuity-policy", rules: policyRules },
      ...(automaticReview ? { automaticReview: { maximumWaitMs: 1000, ...automaticReview } } : {}),
      capabilities: {
        inspect: async (ref) => {
          const record = await capability.store.get(ref);
          return record
            ? { lifecycle: record.lifecycle, manifest: record.declaration as CapabilityManifest }
            : undefined;
        },
      },
    });
  return { ...capability, authorization: store, ids, service };
}

describe("authorization continuity", () => {
  it("denies an expired action even when a current read rule would allow it", async () => {
    const f = await continuityFixture();
    f.clock.set(T2);
    expect(
      await f.service().evaluate(intent({ id: "expired-allowed-read" }), {
        uiAvailable: true,
        approvalExpiresAt: T2,
      }),
    ).toMatchObject({ decision: "DENY", reasonCode: "intent_expired" });
    expect(await f.authorization.listApprovals(OWNER_ID, AGENT_ID)).toEqual([]);
  });
  it("applies a hard denial when any target intersects forbidden resources", async () => {
    const f = await continuityFixture();
    const original = intent({
      id: "mixed-targets",
      actionKind: "DELETE",
      operation: "delete",
      resourceRef: "account:owner",
    });
    const action = { ...original, resourceRefs: ["account:owner", "repo:approved/project"] };
    expect(
      await f.service().evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 }),
    ).toMatchObject({ decision: "DENY", reasonCode: "account_root_denied" });
  });
  it("does not revive a denied action after policy relaxation", async () => {
    const f = await continuityFixture([]);
    const action = intent({ id: "policy-relaxed" });
    const ask = await f.service().evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 });
    if (ask.decision !== "ASK") throw new Error("expected approval");
    const approvals = new ApprovalService({ store: f.authorization, clock: f.clock });
    await approvals.respond({
      approvalRequestId: ask.approvalRequest.id,
      expectedRevision: 1,
      semanticSnapshotHash: ask.approvalRequest.semanticSnapshotHash,
      response: { decision: "denied" },
    });
    expect(
      await f.service(POLICY.rules).evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 }),
    ).toMatchObject({ decision: "DENY", reasonCode: "approval_denied" });
  });
  it("returns the same durable approval when two evaluations race", async () => {
    const f = await continuityFixture([]);
    const action = intent({ id: "racing-approval" });
    const results = await Promise.all([
      f.service().evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 }),
      f.service().evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await f.authorization.listApprovals(OWNER_ID, AGENT_ID)).toHaveLength(1);
  });
  it("acknowledges a repeated denial without another decision or revision", async () => {
    const f = await continuityFixture([]);
    const ask = await f
      .service()
      .evaluate(intent({ id: "repeated-denial" }), { uiAvailable: true, approvalExpiresAt: T1 });
    if (ask.decision !== "ASK") throw new Error("expected approval");
    const approvals = new ApprovalService({ store: f.authorization, clock: f.clock });
    const response = {
      approvalRequestId: ask.approvalRequest.id,
      expectedRevision: 1,
      semanticSnapshotHash: ask.approvalRequest.semanticSnapshotHash,
      response: { decision: "denied" as const },
    };
    const first = await approvals.respond(response);
    expect(await approvals.respond(response)).toEqual(first);
    expect(first.revision).toBe(2);
  });
  it("uses a versioned cryptographic snapshot identity independent of object key order", () => {
    const action = intent({ id: "canonical-hash" });
    expect(actionIntentFingerprint(action)).toMatch(/^intent\.v2\.sha256:[0-9a-f]{64}$/);
    const reordered = {
      ...action,
      frequency: { intervalMs: null, count: 1 },
      targets: action.targets.map((target) => ({ ref: target.ref, type: target.type })),
    };
    expect(actionIntentFingerprint(reordered)).toBe(actionIntentFingerprint(action));
    expect(actionIntentFingerprint({ ...action, estimatedCostMicros: 101 })).not.toBe(
      actionIntentFingerprint(action),
    );
  });
});

describe("authorization snapshot compatibility", () => {
  it("accepts a historical FNV snapshot without accepting a changed request", () => {
    const action = intent({ id: "canonical-hash" });
    expect(legacyActionIntentFingerprint(action)).toBe("intent-2a3329f0");
    expect(actionIntentFingerprintMatches(action, "intent-2a3329f0")).toBe(true);
    expect(
      actionIntentFingerprintMatches({ ...action, threadId: "another-thread" }, "intent-2a3329f0"),
    ).toBe(false);
    expect(actionIntentFingerprintMatches(action, "intent.v3:unknown")).toBe(false);
  });
  it("denies reusing an existing intent identity in another thread even with a read policy", async () => {
    const f = await continuityFixture([]);
    const action = intent({ id: "cross-thread-reuse" });
    await f.service().evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 });
    expect(
      await f
        .service(POLICY.rules)
        .evaluate(
          { ...action, threadId: "other-thread" },
          { uiAvailable: true, approvalExpiresAt: T1 },
        ),
    ).toMatchObject({ decision: "DENY", reasonCode: "approval_hash_mismatch" });
  });
  it("does not turn a recorded approval into policy authority after the grant is revoked", async () => {
    const f = await continuityFixture([]);
    const action = intent({ id: "revoked-approved-read" });
    const ask = await f.service().evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 });
    if (ask.decision !== "ASK") throw new Error("expected ASK");
    const grants = new GrantService({ store: f.authorization, clock: f.clock, ids: f.ids });
    const grant = grants.create({
      kind: "one_time",
      intent: action,
      approvalRequestId: ask.approvalRequest.id,
      expiresAt: T1,
      maxUses: 1,
      maxTotalCostMicros: 100,
      scope: {
        capabilityRef: action.capabilityRef,
        capabilityVersion: action.capabilityVersion,
        operations: [action.operation],
        exactResourceRef: action.resourceRef,
        resourceIdentities: action.resourceRefs,
        resourcePrefixes: [],
        maxDataClassification: action.dataClassification,
        disclosure: action.disclosure,
        sideEffects: [action.sideEffect],
        recipients: [],
        credentialOrAccessChange: false,
        maxCostMicrosPerUse: 100,
        maxFrequency: action.frequency,
      },
    });
    const approvals = new ApprovalService({ store: f.authorization, clock: f.clock });
    const response = {
      approvalRequestId: ask.approvalRequest.id,
      expectedRevision: 1,
      semanticSnapshotHash: ask.approvalRequest.semanticSnapshotHash,
      response: { decision: "approved" as const, grant, recentAuthenticationRef: null },
    };
    const accepted = await approvals.respond(response);
    await grants.revoke(grant.id, "owner-revoked");
    expect(await approvals.respond(response)).toEqual(accepted);
    expect(
      await f.service(POLICY.rules).evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 }),
    ).toMatchObject({ decision: "DENY" });
    expect((await f.authorization.listGrants(OWNER_ID, AGENT_ID))[0]?.revokedAt).toBe(T0);
  });
});

describe("authorization selection boundaries", () => {
  it("rechecks the deadline after asynchronous capability inspection", async () => {
    const f = await continuityFixture();
    const policy = new ActionPolicyService({
      store: f.authorization,
      clock: f.clock,
      ids: f.ids,
      policy: POLICY,
      capabilities: {
        inspect: async (ref) => {
          const record = await f.store.get(ref);
          f.clock.set(T2);
          return record
            ? { lifecycle: record.lifecycle, manifest: record.declaration as CapabilityManifest }
            : undefined;
        },
      },
    });
    expect(
      await policy.evaluate(intent({ id: "expires-during-inspection" }), {
        uiAvailable: true,
        approvalExpiresAt: T1,
      }),
    ).toMatchObject({ decision: "DENY", reasonCode: "intent_expired" });
  });
  it("uses another covering grant when an earlier grant has no remaining quota", async () => {
    const f = await continuityFixture([]);
    const grants = new GrantService({ store: f.authorization, clock: f.clock, ids: f.ids });
    const approvals = new ApprovalService({ store: f.authorization, clock: f.clock });
    const created: GovernedGrantRecord[] = [];
    for (const id of ["spent-scope", "available-scope"]) {
      const action = intent({ id });
      const hash = actionIntentFingerprint(action);
      const approval = await f.authorization.createApproval({
        id: `approval:${id}`,
        revision: 1,
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runId: action.runId,
        intentId: action.id,
        intentSnapshot: action,
        semanticSnapshotHash: hash,
        status: "pending",
        deliveryState: "deliverable",
        requestedAt: T0,
        expiresAt: T1,
        decidedAt: null,
        grantId: null,
      });
      const grant = grants.create({
        kind: "long_term",
        intent: action,
        approvalRequestId: approval.id,
        expiresAt: T2,
        maxUses: 1,
        maxTotalCostMicros: 100,
        scope: {
          capabilityRef: action.capabilityRef,
          capabilityVersion: action.capabilityVersion,
          operations: ["read"],
          exactResourceRef: action.resourceRef,
          resourceIdentities: action.resourceRefs,
          resourcePrefixes: [],
          maxDataClassification: "private",
          sideEffects: ["none"],
          disclosure: "none",
          recipients: [],
          credentialOrAccessChange: false,
          maxCostMicrosPerUse: 100,
          maxFrequency: action.frequency,
        },
      });
      await approvals.respond({
        approvalRequestId: approval.id,
        expectedRevision: 1,
        semanticSnapshotHash: hash,
        response: { decision: "approved", grant, recentAuthenticationRef: null },
      });
      created.push(grant);
    }
    const first = created[0],
      second = created[1];
    if (!first || !second) throw new Error("missing grants");
    await f.authorization.consumeGrant({
      grantId: first.id,
      expectedRevision: 1,
      costMicros: 100,
      consumedAt: T0,
    });
    expect(
      await f.service().evaluate(intent({ id: "covered-by-second-grant" }), {
        uiAvailable: true,
        approvalExpiresAt: T1,
      }),
    ).toMatchObject({ decision: "ALLOW", basis: { type: "grant", ref: second.id } });
    expect(
      await f.service().evaluate(intent({ id: "covered-by-second-grant" }), {
        uiAvailable: true,
        approvalExpiresAt: T1,
      }),
    ).toMatchObject({ decision: "ALLOW", basis: { type: "grant", ref: second.id } });
    expect(
      await f
        .service()
        .evaluate(intent({ id: "no-quota-left" }), { uiAvailable: true, approvalExpiresAt: T1 }),
    ).toMatchObject({ decision: "DENY", reasonCode: "authorization_quota_unavailable" });
  });
});

describe("optional automatic review entry", () => {
  it("does not treat a review return value as execution authority", async () => {
    const f = await continuityFixture([]);
    const review = vi.fn(async () => ({ decision: "ALLOW" }) as unknown as undefined);
    const action = intent({ id: "review-no-authority" });
    expect(
      await f
        .service([], { review })
        .evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 }),
    ).toMatchObject({ decision: "ASK" });
    expect(review).toHaveBeenCalledExactlyOnceWith(
      {
        intent: action,
        policyVersion: "continuity-policy",
        deadlineAt: "2026-08-28T00:00:01.000Z",
        approvalExpiresAt: T1,
      },
      expect.any(AbortSignal),
    );
    expect(await f.authorization.listGrants(OWNER_ID, AGENT_ID)).toEqual([]);
  });
  it("falls back to the original human path when the reviewer fails", async () => {
    const f = await continuityFixture([]);
    const review = vi.fn(async () => {
      throw new Error("private provider diagnostic");
    });
    const result = await f
      .service([], { review })
      .evaluate(intent({ id: "review-unavailable" }), { uiAvailable: true, approvalExpiresAt: T1 });
    expect(result).toMatchObject({ decision: "ASK" });
    expect(review).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private provider diagnostic");
  });
  it.each(["expiry", "disable"] as const)(
    "rechecks %s after review before creating human approval",
    async (change) => {
      const f = await continuityFixture([]);
      const review = vi.fn(async () => {
        if (change === "expiry") f.clock.set(T2);
        else await f.lifecycle.disable("governed-tool");
      });
      expect(
        await f.service([], { review }).evaluate(intent({ id: `review-${change}` }), {
          uiAvailable: true,
          approvalExpiresAt: T1,
        }),
      ).toMatchObject({
        decision: "DENY",
        reasonCode: change === "expiry" ? "intent_expired" : "capability_not_active",
      });
      expect(review).toHaveBeenCalledTimes(1);
      expect(await f.authorization.listApprovals(OWNER_ID, AGENT_ID)).toEqual([]);
    },
  );
  it("keeps hard denial, existing approval and allowed reads ahead of review", async () => {
    const f = await continuityFixture();
    const review = vi.fn(async () => {});
    const service = f.service(POLICY.rules, { review });
    expect(
      await service.evaluate(intent({ id: "review-safe-read" }), {
        uiAvailable: true,
        approvalExpiresAt: T1,
      }),
    ).toMatchObject({ decision: "ALLOW" });
    expect(
      await service.evaluate(
        intent({
          id: "review-hard-deny",
          operation: "delete",
          actionKind: "DELETE",
          resourceRef: "account:owner",
        }),
        { uiAvailable: true, approvalExpiresAt: T1 },
      ),
    ).toMatchObject({ decision: "DENY" });
    const action = intent({ id: "review-pending" });
    await f.service([]).evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 });
    expect(
      await f
        .service([], { review })
        .evaluate(action, { uiAvailable: true, approvalExpiresAt: T1 }),
    ).toMatchObject({ decision: "ASK" });
    expect(review).not.toHaveBeenCalled();
  });
});

it("bounds an unresponsive review and aborts it before falling back to confirmation", async () => {
  vi.useFakeTimers();
  try {
    const f = await continuityFixture([]);
    let signal: AbortSignal | undefined;
    const pending = f
      .service([], {
        review: async (_input, cancellation) => {
          signal = cancellation;
          await new Promise<void>(() => {});
        },
      })
      .evaluate(intent({ id: "review-timeout" }), { uiAvailable: true, approvalExpiresAt: T1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ decision: "ASK" });
    expect(signal?.aborted).toBe(true);
    expect(await f.authorization.listGrants(OWNER_ID, AGENT_ID)).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("reuses a host-persisted review grant through the existing quota reservation boundary", async () => {
  const f = await continuityFixture([]);
  const action = intent({ id: "review-stored-grant" });
  const review = vi.fn(async () => {
    const asked = await f
      .service([])
      .evaluate(action, { uiAvailable: false, approvalExpiresAt: T1 });
    if (asked.decision !== "ASK") throw new Error("expected approval");
    const grant = new GrantService({ store: f.authorization, clock: f.clock, ids: f.ids }).create({
      kind: "one_time",
      intent: action,
      approvalRequestId: asked.approvalRequest.id,
      expiresAt: T1,
      maxUses: 1,
      maxTotalCostMicros: action.estimatedCostMicros,
      scope: {
        capabilityRef: action.capabilityRef,
        capabilityVersion: action.capabilityVersion,
        operations: [action.operation],
        exactResourceRef: action.resourceRef,
        resourceIdentities: action.resourceRefs,
        resourcePrefixes: [],
        maxDataClassification: action.dataClassification,
        disclosure: action.disclosure,
        sideEffects: [action.sideEffect],
        recipients: action.recipients,
        credentialOrAccessChange: false,
        maxCostMicrosPerUse: action.estimatedCostMicros,
        maxFrequency: action.frequency,
      },
    });
    await new ApprovalService({ store: f.authorization, clock: f.clock }).respond({
      approvalRequestId: asked.approvalRequest.id,
      expectedRevision: 1,
      semanticSnapshotHash: asked.approvalRequest.semanticSnapshotHash,
      response: { decision: "approved", grant, recentAuthenticationRef: null },
    });
  });
  const service = f.service([], { review });
  const options = { uiAvailable: true, approvalExpiresAt: T1 };
  const result = await service.evaluate(action, options);
  expect(result).toMatchObject({
    decision: "ALLOW",
    basis: { type: "grant" },
    authorizationReservation: { id: `authorization-reservation:${action.id}` },
  });
  expect(await service.evaluate(action, options)).toEqual(result);
  expect(review).toHaveBeenCalledTimes(1);
  expect(await f.authorization.listGrants(OWNER_ID, AGENT_ID)).toMatchObject([
    { uses: 0, spentCostMicros: 0 },
  ]);
});

it("observes a decision that wins the race while creating the fallback approval", async () => {
  const f = await continuityFixture([]);
  const original = f.authorization.createApproval.bind(f.authorization);
  vi.spyOn(f.authorization, "createApproval").mockImplementation(async (request) => {
    const created = await original(request);
    return f.authorization.resolveApproval({
      approvalRequestId: created.id,
      expectedRevision: created.revision,
      semanticSnapshotHash: created.semanticSnapshotHash,
      resolution: "denied",
      decidedAt: T0,
      grant: null,
    });
  });
  expect(
    await f.service([]).evaluate(intent({ id: "approval-creation-race" }), {
      uiAvailable: true,
      approvalExpiresAt: T1,
    }),
  ).toMatchObject({ decision: "DENY", reasonCode: "approval_denied" });
});

it("does not enter review or create approval for an already cancelled action", async () => {
  const f = await continuityFixture([]);
  const controller = new AbortController();
  controller.abort();
  const review = vi.fn(async () => undefined);
  expect(
    await f.service([], { review }).evaluate(intent({ id: "cancel-before-review" }), {
      uiAvailable: true,
      approvalExpiresAt: T1,
      signal: controller.signal,
    }),
  ).toMatchObject({ decision: "DENY", reasonCode: "action_cancelled" });
  expect(review).not.toHaveBeenCalled();
  expect(await f.authorization.listApprovals(OWNER_ID, AGENT_ID)).toEqual([]);
});

it("ends an unresponsive review on caller cancellation without opening human approval", async () => {
  vi.useFakeTimers();
  try {
    const f = await continuityFixture([]);
    const controller = new AbortController();
    let reviewSignal: AbortSignal | undefined;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = f
      .service([], {
        review: async (_input, signal) => {
          reviewSignal = signal;
          started();
          await new Promise<void>(() => {});
        },
      })
      .evaluate(intent({ id: "cancel-during-review" }), {
        uiAvailable: true,
        approvalExpiresAt: T1,
        signal: controller.signal,
      });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await entered;
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(reviewSignal?.aborted).toBe(true);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ decision: "DENY", reasonCode: "action_cancelled" });
    expect(await f.authorization.listApprovals(OWNER_ID, AGENT_ID)).toEqual([]);
    expect(await f.authorization.listGrants(OWNER_ID, AGENT_ID)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
  }
});

it("does not return permission after cancellation during the final authority trace", async () => {
  const f = await continuityFixture();
  const controller = new AbortController();
  const policy = new ActionPolicyService({
    store: f.authorization,
    clock: f.clock,
    ids: f.ids,
    policy: POLICY,
    capabilities: {
      inspect: async (ref) => {
        const record = await f.store.get(ref);
        return record
          ? { lifecycle: record.lifecycle, manifest: record.declaration as CapabilityManifest }
          : undefined;
      },
    },
    trace: {
      record: async () => {
        controller.abort();
      },
    },
  });
  expect(
    await policy.evaluate(intent({ id: "cancel-in-trace" }), {
      uiAvailable: true,
      approvalExpiresAt: T1,
      signal: controller.signal,
    }),
  ).toMatchObject({ decision: "DENY", reasonCode: "action_cancelled" });
  expect(await f.authorization.listApprovals(OWNER_ID, AGENT_ID)).toEqual([]);
});
