import {
  projectSandboxExecution,
  projectSandboxRunCompletion,
  type SandboxExecutionProjectionContext,
} from "@himawari-agent/application";
import {
  type SandboxExecutionFacts,
  type SandboxExecutionPlanV2,
  type SandboxOperationContract,
  sandboxExecutionFactsSchema,
  sandboxExecutionPlanCandidateV2Schema,
  sandboxExecutionPlanV2Schema,
  sandboxJobReceiptSchema,
  sandboxResourceOutputPageSchema,
  sandboxResourceOutputQuerySchema,
  validateSandboxExecutionFacts,
  versionedSandboxExecutionPlanSchema,
} from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";

const at = "2026-09-09T00:00:01.000Z";
const deadline = "2026-09-09T00:01:00.000Z";
const hash = "a".repeat(64);
const ref = { ref: "evidence", digest: hash };
const output = { ref: "payload", digest: hash, byteLength: 0 };
const identity = {
  jobId: "job",
  attemptId: "attempt",
  invocationId: "invocation",
  receiptRef: "receipt",
  hostId: "host",
  ownerId: "owner",
  agentId: "agent",
  threadId: null,
  runId: "run",
  toolCallId: "call",
};
const contracts = {
  read: { ref: "read", version: "1", kind: "fixed_read" },
  write: {
    ref: "write",
    version: "1",
    kind: "verified_effect",
    verifierRef: "content",
    verifierVersion: "1",
    targetRef: "file",
  },
  shell: { ref: "shell", version: "1", kind: "command" },
  background: { ref: "background", version: "1", kind: "task_start" },
  service: {
    ref: "service",
    version: "1",
    kind: "service_start",
    readinessProbeRef: "mcp-initialize",
  },
} as const satisfies Record<string, SandboxOperationContract>;
function fixture(kind: keyof typeof contracts = "read") {
  const mode = kind === "background" ? "background" : kind === "service" ? "service" : "foreground";
  const contract = contracts[kind];
  const plan = sandboxExecutionPlanV2Schema.parse({
    schemaVersion: "sandbox-execution.v2",
    identity,
    handleRef: "handle",
    inputRef: "input",
    operation: kind,
    capabilityRef: kind,
    capabilityVersion: "1",
    semanticFingerprint: `sha256:${hash}`,
    authorizationRef: "grant",
    modelRef: "model",
    executionLease: {
      executionLeaseId: "lease",
      expectedLeaseRevision: 1,
      authorityLeaseId: "authority",
      authorityFencingToken: 1,
      deploymentId: "deployment",
      authorityEpoch: 1,
      fencingToken: 1,
      consumerId: "consumer",
    },
    requestedAt: "2026-09-09T00:00:00.000Z",
    originalDeadlineAt: deadline,
    effectiveDeadlineAt: deadline,
    resourceCeiling: {
      maxWallTimeMs: 60_000,
      maxCpuTimeMs: 60_000,
      maxMemoryBytes: 1_000_000,
      maxOutputBytes: 1024,
      maxProgressEvents: 20,
    },
    binding: {
      scopeRef: "scope",
      scopeDigest: hash,
      profileRef: "profile",
      runtimeDigest: hash,
      runnerDigest: hash,
      qualificationRef: "qualification",
      requiredGuarantees: ["supervision"],
    },
    mode,
    operationContract: contract,
    backendRef: "backend",
    environmentId: "environment",
  });
  const environment = {
    schemaVersion: "sandbox-execution.v2",
    environmentId: "environment",
    resourceRef: mode === "foreground" ? null : "resource",
    creator: identity,
    mode,
    backendRef: "backend",
    authorizationRef: "grant",
    scopeDigest: hash,
    policyDigest: hash,
    deadlineAt: deadline,
    supervisor: { supervisorId: "supervisor", bootId: "boot", epoch: 1 },
    workspaceConflictRefs: ["workspace"],
    kind: "local",
    privateDirectoryRef: "private",
    privateDirectoryOwnerRef: "host",
  };
  const common = {
    schemaVersion: "sandbox-execution.v2",
    identity,
    environmentId: "environment",
    policyDigest: hash,
    contract: { ref: contract.ref, version: "1" },
    occurredAt: at,
  };
  const handleFields = {
    ref: "resource",
    environmentId: "environment",
    creator: identity,
    backendRef: "backend",
    authorizationRef: "grant",
    scopeDigest: hash,
    deadlineAt: deadline,
  };
  const result =
    kind === "background" || kind === "service"
      ? {
          ...common,
          kind: "started",
          output,
          handle:
            kind === "background"
              ? { ...handleFields, kind: "task", state: "running" }
              : { ...handleFields, kind: "service", readiness: "ready" },
          readinessEvidence: kind === "service" ? ref : null,
        }
      : {
          ...common,
          kind: "result",
          output,
          completion: kind === "shell" ? { type: "exit", exitCode: 0 } : { type: "value" },
        };
  const facts = sandboxExecutionFactsSchema.parse({
    schemaVersion: "sandbox-execution.v2",
    environment,
    result,
    effect:
      kind === "read"
        ? { kind: "not_applicable" }
        : kind === "write"
          ? {
              kind: "verified",
              verifierRef: "content",
              verifierVersion: "1",
              targetRef: "file",
              evidence: ref,
              occurredAt: at,
            }
          : { kind: "not_asserted" },
    resource: {
      schemaVersion: "sandbox-execution.v2",
      environmentId: "environment",
      creator: identity,
      policyDigest: hash,
      scopeDigest: hash,
      sequence: 1,
      occurredAt: at,
      supervisor: environment.supervisor,
      resourceRef: mode === "foreground" ? null : "resource",
      status:
        mode === "foreground"
          ? { kind: "foreground" }
          : mode === "background"
            ? { kind: "task", state: "running" }
            : { kind: "service", readiness: "ready" },
      metrics: null,
      supervision: "controlled",
      cleanup: "pending",
      evidence: {
        ...ref,
        qualificationRef: "qualification",
        profileRef: "profile",
        validUntil: deadline,
        subject: { kind: "local_process", processIdentityRef: "process-start" },
      },
    },
  });
  return { plan, facts };
}
function context(
  plan: SandboxExecutionPlanV2,
  facts: SandboxExecutionFacts,
): SandboxExecutionProjectionContext & {
  readonly verification: NonNullable<SandboxExecutionProjectionContext["verification"]>;
} {
  return {
    now: at,
    environment: facts.environment,
    operationContract: plan.operationContract,
    verification: {
      facts,
      identity: plan.identity,
      environmentId: plan.environmentId,
      policyDigest: hash,
      resourceSequence: facts.resource.sequence,
      checkedAt: at,
      validUntil: deadline,
      evidence: [ref],
      outputs: [output],
    },
    currentResourceSequence: facts.resource.sequence,
    runState: "active",
    currentAuthority: true,
    currentFence: true,
    userDisclosureAllowed: true,
    modelDisclosureAllowed: true,
    conflictingWorkspaceRisk: false,
    pendingApprovalOrReconciliation: false,
    resultAlreadyDelivered: false,
  };
}
function project(f = fixture(), override: Partial<SandboxExecutionProjectionContext> = {}) {
  return projectSandboxExecution(f.plan, f.facts, { ...context(f.plan, f.facts), ...override });
}
function loss(f: ReturnType<typeof fixture>): SandboxExecutionFacts {
  const { evidence: _evidence, ...resource } = f.facts.resource as Extract<
    SandboxExecutionFacts["resource"],
    { supervision: "controlled" }
  >;
  return sandboxExecutionFactsSchema.parse({
    ...f.facts,
    resource: {
      ...resource,
      supervision: "lost",
      cleanup: "unknown",
      reasonCode: "worker_lost",
      sequence: 2,
    },
  });
}
function released(f: ReturnType<typeof fixture>): SandboxExecutionFacts {
  return sandboxExecutionFactsSchema.parse({
    ...f.facts,
    resource: { ...f.facts.resource, supervision: "released", cleanup: "confirmed", sequence: 3 },
  });
}

describe("R1 six operation scenarios and independent completion gates", () => {
  it.each([
    ["read", "succeeded"],
    ["write", "succeeded"],
    ["shell", "succeeded"],
    ["background", "started"],
    ["service", "started"],
  ] as const)("%s publishes its own result while cleanup remains pending", (kind, conclusion) => {
    expect(project(fixture(kind))).toMatchObject({
      conclusion,
      showResult: true,
      deliverToolResult: true,
      continuePi: true,
      reuseEnvironment: false,
      resourceObligationReleased: false,
      resourcePending: true,
    });
  });
  it("cancelled unknown operation never continues or reports that nothing happened", () => {
    const f = fixture("shell");
    const {
      output: _output,
      completion: _completion,
      ...binding
    } = f.facts.result as Extract<NonNullable<SandboxExecutionFacts["result"]>, { kind: "result" }>;
    f.facts = sandboxExecutionFactsSchema.parse({
      ...loss(f),
      result: { ...binding, kind: "unknown", reasonCode: "cancel_race" },
      effect: { kind: "unknown", reasonCode: "interrupted" },
    });
    expect(project(f, { runState: "cancelled" })).toMatchObject({
      conclusion: "unknown",
      showResult: false,
      deliverToolResult: false,
      continuePi: false,
      reuseEnvironment: false,
      needsReconciliation: true,
    });
  });
  it("two MCP requests share a connection but have distinct invocation and Handle identities", () => {
    const service = fixture("service");
    for (const id of ["request-1", "request-2"]) {
      const plan = sandboxExecutionPlanV2Schema.parse({
        ...service.plan,
        operationContract: contracts.read,
        identity: { ...identity, jobId: id, invocationId: id, receiptRef: id, toolCallId: id },
        handleRef: id,
      });
      const read = fixture();
      const facts = sandboxExecutionFactsSchema.parse({
        ...service.facts,
        effect: read.facts.effect,
        result: { ...read.facts.result, identity: plan.identity },
      });
      expect(projectSandboxExecution(plan, facts, context(plan, facts))).toMatchObject({
        conclusion: "succeeded",
        invokeService: true,
      });
      const unavailable = sandboxExecutionFactsSchema.parse({
        ...facts,
        resource: { ...facts.resource, status: { kind: "service", readiness: "unavailable" } },
      });
      expect(
        projectSandboxExecution(plan, unavailable, context(plan, unavailable)).invokeService,
      ).toBe(false);
      expect(() =>
        validateSandboxExecutionFacts(
          plan,
          { ...facts, result: read.facts.result },
          context(plan, facts),
        ),
      ).toThrow("result invocation");
    }
  });
});

describe("R1 independent output, effect and supervision facts", () => {
  it("preserves v1 terminal semantics and parses both plan versions without default upgrades", () => {
    const { plan } = fixture();
    const {
      mode: _mode,
      operationContract: _contract,
      backendRef: _backend,
      environmentId: _env,
      ...old
    } = plan;
    const v1 = { ...old, schemaVersion: "sandbox-execution.v1" };
    expect(versionedSandboxExecutionPlanSchema.parse(v1)).toEqual(v1);
    expect(versionedSandboxExecutionPlanSchema.parse(plan)).toEqual(plan);
    const receipt = {
      schemaVersion: "sandbox-execution.v1",
      identity,
      sequence: 1,
      state: "completed",
      policyDigest: hash,
      occurredAt: at,
      outcome: "succeeded",
      cleanup: "pending",
      effect: "confirmed",
      outputRef: "payload",
      outputDigest: hash,
      reasonCode: null,
    };
    expect(() => sandboxJobReceiptSchema.parse(receipt)).toThrow(
      "terminal result requires confirmed cleanup",
    );
    expect(sandboxJobReceiptSchema.parse({ ...receipt, cleanup: "confirmed" }).outcome).toBe(
      "succeeded",
    );
    expect(project()).toMatchObject({ showResult: true, resourcePending: true });
  });
  it("accepts protected empty output, rejects unverified output and bytes beyond the frozen budget", () => {
    expect(project().showResult).toBe(true);
    const f = fixture();
    const c = context(f.plan, f.facts);
    expect(project(f, { verification: { ...c.verification, outputs: [] } })).toMatchObject({
      conclusion: "unknown",
      showResult: false,
      continuePi: false,
    });
    const largeOutput = { ...output, byteLength: 1025 };
    f.facts = sandboxExecutionFactsSchema.parse({
      ...f.facts,
      result: { ...f.facts.result, output: largeOutput },
    });
    expect(
      project(f, { verification: { ...c.verification, outputs: [largeOutput] } }).showResult,
    ).toBe(false);
  });
  it("retains known result after lost supervision and never redelivers already delivered results", () => {
    const f = fixture("write");
    f.facts = loss(f);
    expect(project(f)).toMatchObject({
      conclusion: "succeeded",
      showResult: true,
      continuePi: false,
      deliverToolResult: false,
      reuseEnvironment: false,
      needsReconciliation: true,
    });
    expect(project(fixture(), { resultAlreadyDelivered: true })).toMatchObject({
      showResult: true,
      deliverToolResult: false,
    });
  });
  it.each(["cancelled", "expired", "terminated"] as const)(
    "late known result does not revive %s Run",
    (runState) => {
      expect(project(fixture(), { runState })).toMatchObject({
        showResult: true,
        deliverToolResult: false,
        continuePi: false,
      });
    },
  );
  it.each(["currentAuthority", "currentFence", "modelDisclosureAllowed"] as const)(
    "requires current %s for continuation",
    (field) => {
      expect(project(fixture(), { [field]: false }).continuePi).toBe(false);
    },
  );
  it.each(["conflictingWorkspaceRisk", "pendingApprovalOrReconciliation"] as const)(
    "blocks continued execution on %s",
    (field) => {
      expect(project(fixture(), { [field]: true }).continuePi).toBe(false);
    },
  );
  it("does not treat syntactically valid supervision claims as authenticated evidence", () => {
    const f = fixture();
    for (const facts of [f.facts, released(f)]) {
      expect(project({ ...f, facts }, { verification: null })).toMatchObject({
        continuePi: false,
        reuseEnvironment: false,
        resourceObligationReleased: false,
      });
    }
  });
  it("requires fresh sequence, boot identity, policy, verified digest and supervision window", () => {
    const f = fixture();
    const c = context(f.plan, f.facts);
    for (const verification of [
      { ...c.verification, policyDigest: "b".repeat(64) },
      { ...c.verification, identity: { ...identity, invocationId: "other" } },
      { ...c.verification, evidence: [{ ...ref, digest: "b".repeat(64) }] },
      { ...c.verification, validUntil: at },
    ])
      expect(project(f, { verification }).continuePi).toBe(false);
    expect(project(f, { currentResourceSequence: 2 }).continuePi).toBe(false);
    expect(project(f, { now: deadline }).continuePi).toBe(false);
    expect(() =>
      projectSandboxExecution(
        f.plan,
        {
          ...f.facts,
          resource: {
            ...f.facts.resource,
            supervisor: { ...f.facts.resource.supervisor, bootId: "replacement" },
          },
        },
        c,
      ),
    ).toThrow("resource binding");
  });
  it("requires write/push verifier evidence; unknown effects cannot be weakened to command semantics", () => {
    const f = fixture("write");
    const c = context(f.plan, f.facts);
    for (const effect of [
      { kind: "not_asserted" },
      { kind: "not_applicable" },
      { ...f.facts.effect, verifierRef: "stdout-success" },
    ]) {
      expect(() => validateSandboxExecutionFacts(f.plan, { ...f.facts, effect }, c)).toThrow();
    }
    const unknown = sandboxExecutionFactsSchema.parse({
      ...f.facts,
      effect: { kind: "unknown", reasonCode: "postcondition_missing" },
    });
    expect(project({ ...f, facts: unknown })).toMatchObject({
      conclusion: "unknown",
      showResult: true,
      continuePi: false,
    });
    const weak = sandboxExecutionPlanV2Schema.parse({
      ...f.plan,
      operationContract: contracts.shell,
    });
    expect(() => validateSandboxExecutionFacts(weak, f.facts, c)).toThrow("frozen binding");
  });
  it("normal nonzero exit is a failure with unasserted effects; interruption requires unknown effects", () => {
    const f = fixture("shell");
    const { completion: _completion, ...r } = f.facts.result as Extract<
      NonNullable<SandboxExecutionFacts["result"]>,
      { kind: "result" }
    >;
    f.facts = sandboxExecutionFactsSchema.parse({
      ...f.facts,
      result: {
        ...r,
        kind: "error",
        reasonCode: "exit_failed",
        termination: { type: "exit", exitCode: 1 },
      },
    });
    expect(project(f)).toMatchObject({ conclusion: "failed", continuePi: true });
    const interrupted = {
      ...f.facts,
      result: { ...f.facts.result, termination: { type: "interrupted", signal: "SIGTERM" } },
    };
    expect(() =>
      validateSandboxExecutionFacts(f.plan, interrupted, context(f.plan, f.facts)),
    ).toThrow("missing normal result");
    expect(
      project({
        ...f,
        facts: sandboxExecutionFactsSchema.parse({
          ...interrupted,
          effect: { kind: "unknown", reasonCode: "signal" },
        }),
      }).continuePi,
    ).toBe(false);
  });
  it("Run completion aggregates all required operations and resources, without deciding goal success", () => {
    const f = fixture();
    const done = project({ ...f, facts: released(f) });
    const input = {
      runState: "active" as const,
      inventoryComplete: true,
      currentFence: true,
      pendingApprovalOrReconciliation: false,
      operations: [done],
    };
    expect(projectSandboxRunCompletion(input).canCompleteNormally).toBe(true);
    for (const overrides of [
      { operations: [done, project()] },
      { inventoryComplete: false },
      { pendingApprovalOrReconciliation: true },
      { runState: "cancelled" as const },
    ]) {
      expect(projectSandboxRunCompletion({ ...input, ...overrides }).canCompleteNormally).toBe(
        false,
      );
    }
  });
});

describe("R1 strict branches, bindings and observation history", () => {
  it("candidate rejects a supplied fingerprint and plan rejects unknown keys and invalid mode", () => {
    const { plan } = fixture();
    const { semanticFingerprint: _fingerprint, ...candidate } = plan;
    expect(sandboxExecutionPlanCandidateV2Schema.parse(candidate)).toEqual(candidate);
    expect(() => sandboxExecutionPlanCandidateV2Schema.parse(plan)).toThrow("unknown field");
    for (const invalid of [
      { ...plan, surprise: true },
      { ...plan, mode: "background" },
      { ...plan, effectiveDeadlineAt: plan.requestedAt },
      { ...plan, resourceCeiling: { ...plan.resourceCeiling, maxMemoryBytes: Infinity } },
    ]) {
      expect(() => sandboxExecutionPlanV2Schema.parse(invalid)).toThrow();
    }
  });
  it("rejects branch mixing, fabricated readiness, handle substitution and raw output", () => {
    const f = fixture("service");
    const c = context(f.plan, f.facts);
    for (const result of [
      { ...f.facts.result, exitCode: 0 },
      { ...f.facts.result, output: "raw text" },
      { ...f.facts.result, readinessEvidence: null },
      {
        ...f.facts.result,
        handle: {
          ...(
            f.facts.result as Extract<
              NonNullable<SandboxExecutionFacts["result"]>,
              { kind: "started" }
            >
          ).handle,
          ref: "invented",
        },
      },
      {
        ...f.facts.result,
        handle: {
          ...(
            f.facts.result as Extract<
              NonNullable<SandboxExecutionFacts["result"]>,
              { kind: "started" }
            >
          ).handle,
          readiness: "starting",
        },
      },
    ])
      expect(() => validateSandboxExecutionFacts(f.plan, { ...f.facts, result }, c)).toThrow();
    const read = fixture();
    expect(() =>
      validateSandboxExecutionFacts(
        read.plan,
        { ...read.facts, result: f.facts.result },
        context(read.plan, read.facts),
      ),
    ).toThrow();
  });
  it("remote connection cannot claim local directory or PID fields", () => {
    const f = fixture("service");
    const {
      privateDirectoryRef: _dir,
      privateDirectoryOwnerRef: _owner,
      ...env
    } = f.facts.environment as Extract<SandboxExecutionFacts["environment"], { kind: "local" }>;
    const remote = { ...env, kind: "remote", connectionRef: "connection" };
    expect(() =>
      validateSandboxExecutionFacts(
        f.plan,
        { ...f.facts, environment: remote },
        {
          ...context(f.plan, f.facts),
          environment: remote as SandboxExecutionFacts["environment"],
        },
      ),
    ).toThrow("supervision subject");

    expect(
      sandboxExecutionFactsSchema.parse({ ...f.facts, environment: remote }).environment.kind,
    ).toBe("remote");
    expect(() =>
      sandboxExecutionFactsSchema.parse({ ...f.facts, environment: { ...remote, pid: 123 } }),
    ).toThrow("unknown field");
  });
  it("keeps known results immutable and requires lost -> reconciling -> released", () => {
    const f = fixture();
    const c = context(f.plan, f.facts);
    const lost = loss(f);
    expect(validateSandboxExecutionFacts(f.plan, lost, c, f.facts).result).toEqual(f.facts.result);
    expect(() => validateSandboxExecutionFacts(f.plan, released(f), c, lost)).toThrow("transition");
    const reconciling = sandboxExecutionFactsSchema.parse({
      ...lost,
      resource: { ...lost.resource, supervision: "reconciling", sequence: 3 },
    });
    const end = sandboxExecutionFactsSchema.parse({
      ...released(f),
      resource: { ...released(f).resource, sequence: 4 },
    });
    validateSandboxExecutionFacts(f.plan, reconciling, c, lost);
    validateSandboxExecutionFacts(f.plan, end, c, reconciling);
    expect(() =>
      validateSandboxExecutionFacts(
        f.plan,
        { ...lost, result: { ...lost.result, output: { ...output, ref: "replacement" } } },
        c,
        f.facts,
      ),
    ).toThrow("immutable");
    expect(() =>
      validateSandboxExecutionFacts(
        f.plan,
        { ...f.facts, resource: { ...f.facts.resource, sequence: 3 } },
        c,
        lost,
      ),
    ).toThrow("transition");
  });
  it("pending preparation is not a failed operation and cannot continue the model", () => {
    const f = fixture();
    const { evidence: _evidence, ...resource } = f.facts.resource as Extract<
      SandboxExecutionFacts["resource"],
      { supervision: "controlled" }
    >;
    f.facts = sandboxExecutionFactsSchema.parse({
      ...f.facts,
      result: null,
      effect: { kind: "unknown", reasonCode: "not_observed" },
      resource: { ...resource, supervision: "initializing" },
    });
    expect(project(f)).toMatchObject({
      conclusion: "pending",
      continuePi: false,
      needsReconciliation: false,
    });
  });
  it("accepts remote connection evidence only for the bound connection", () => {
    const f = fixture("service");
    const {
      privateDirectoryRef: _dir,
      privateDirectoryOwnerRef: _owner,
      ...env
    } = f.facts.environment as Extract<SandboxExecutionFacts["environment"], { kind: "local" }>;
    const resource = f.facts.resource as Extract<
      SandboxExecutionFacts["resource"],
      { supervision: "controlled" }
    >;
    const facts = sandboxExecutionFactsSchema.parse({
      ...f.facts,
      environment: { ...env, kind: "remote", connectionRef: "connection" },
      resource: {
        ...resource,
        evidence: {
          ...resource.evidence,
          subject: { kind: "remote_connection", connectionRef: "connection" },
        },
      },
    });
    expect(project({ ...f, facts }).invokeService).toBe(true);
    expect(() =>
      validateSandboxExecutionFacts(
        f.plan,
        {
          ...facts,
          resource: {
            ...resource,
            evidence: {
              ...resource.evidence,
              subject: { kind: "remote_connection", connectionRef: "other" },
            },
          },
        },
        context(f.plan, facts),
      ),
    ).toThrow("supervision subject");
  });
  it("records a late known result after unknown ack without reviving a cancelled Run", () => {
    const f = fixture();
    const r = f.facts.result as Extract<
      NonNullable<SandboxExecutionFacts["result"]>,
      { kind: "result" }
    >;
    const { output: _output, completion: _completion, ...binding } = r;
    const unknown = sandboxExecutionFactsSchema.parse({
      ...f.facts,
      result: { ...binding, kind: "unknown", reasonCode: "ack_lost" },
    });
    const late = sandboxExecutionFactsSchema.parse({
      ...f.facts,
      resource: { ...f.facts.resource, sequence: 2 },
    });
    validateSandboxExecutionFacts(f.plan, late, context(f.plan, late), unknown);
    expect(project({ ...f, facts: late }, { runState: "cancelled" })).toMatchObject({
      showResult: true,
      deliverToolResult: false,
      continuePi: false,
    });
  });
  it("rejects result policy and resource handle ownership substitution", () => {
    const f = fixture("background");
    const c = context(f.plan, f.facts);
    expect(() =>
      validateSandboxExecutionFacts(
        f.plan,
        { ...f.facts, result: { ...f.facts.result, policyDigest: "b".repeat(64) } },
        c,
      ),
    ).toThrow("policy mismatch");
    const r = f.facts.result as Extract<
      NonNullable<SandboxExecutionFacts["result"]>,
      { kind: "started" }
    >;
    expect(() =>
      validateSandboxExecutionFacts(
        f.plan,
        {
          ...f.facts,
          resource: { ...f.facts.resource, resourceRef: "replacement" },
          result: { ...r, handle: { ...r.handle, ref: "replacement" } },
        },
        c,
      ),
    ).toThrow("resource binding");

    expect(() =>
      validateSandboxExecutionFacts(
        f.plan,
        {
          ...f.facts,
          result: { ...r, handle: { ...r.handle, creator: { ...identity, runId: "other" } } },
        },
        c,
      ),
    ).toThrow("handle binding");
  });
  it("cannot reuse a verified snapshot for a changed process identity claim", () => {
    const f = fixture();
    const c = context(f.plan, f.facts);
    const resource = f.facts.resource as Extract<
      SandboxExecutionFacts["resource"],
      { supervision: "controlled" }
    >;
    const edited = sandboxExecutionFactsSchema.parse({
      ...f.facts,
      resource: {
        ...resource,
        evidence: {
          ...resource.evidence,
          subject: { kind: "local_process", processIdentityRef: "replacement" },
        },
      },
    });
    expect(projectSandboxExecution(f.plan, edited, c)).toMatchObject({
      continuePi: false,
      resourceObligationReleased: false,
    });
  });
  it("output pages are bounded and never carry raw content or credentials", () => {
    expect(
      sandboxResourceOutputPageSchema.parse({
        resourceRef: "resource",
        cursor: null,
        nextCursor: null,
        output,
        truncated: false,
        end: true,
      }).output.byteLength,
    ).toBe(0);
    for (const limit of [0, Infinity, 1_048_577])
      expect(() =>
        sandboxResourceOutputQuerySchema.parse({ resourceRef: "resource", cursor: null, limit }),
      ).toThrow();
    expect(() =>
      sandboxResourceOutputPageSchema.parse({
        resourceRef: "resource",
        cursor: null,
        nextCursor: null,
        output,
        truncated: false,
        end: true,
        content: "secret",
      }),
    ).toThrow();
  });
});
