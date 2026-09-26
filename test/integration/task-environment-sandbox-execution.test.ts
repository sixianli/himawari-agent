import { taskEnvironmentCallEvidence } from "@himawari-agent/application";
import {
  PAYLOAD_BROKER_V1_SCHEMA_VERSION,
  payloadBrokerV1MessageSchema,
  type SandboxExecutionPlanV2,
  sandboxExecutionFactsSchema,
  validateSandboxExecutionFacts,
} from "@himawari-agent/execution-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxV2Admission, sandboxV2Call } from "../fixtures/sandbox-execution-v2-fixture.ts";
import { openSandboxJournal, T1 } from "../fixtures/sqlite-capability-invocation-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const BACKEND = "container-local";
const locator = {
  backendRef: BACKEND,
  runtimeInstanceId: "daemon-1",
  runtimeEnvironmentId: "c".repeat(64),
  createIntentId: "environment-create-1",
  effectivePolicyDigest: "e".repeat(64),
};

async function containerPlan(): Promise<SandboxExecutionPlanV2> {
  const f = await openSandboxJournal();
  cleanups.push(f.close);
  const admission = sandboxV2Admission(f);
  const plan = { ...admission.plan, backendRef: BACKEND, environmentId: "environment-task-1" };
  const facts = {
    ...admission.facts,
    environment: {
      ...admission.facts.environment,
      backendRef: BACKEND,
      environmentId: plan.environmentId,
    },
    resource: { ...admission.facts.resource, environmentId: plan.environmentId },
  };
  return sandboxV2Call(f, "admit", { ...admission, plan, facts }).record.plan;
}

function environmentIdentity(plan: SandboxExecutionPlanV2) {
  return {
    schemaVersion: "execution-environment.v1" as const,
    ownerId: plan.identity.ownerId,
    agentId: plan.identity.agentId,
    runId: plan.identity.runId,
    hostId: plan.identity.hostId,
    executionJobId: "execution-job-1",
    environmentId: plan.environmentId,
    environmentGeneration: 1,
    role: "primary" as const,
  };
}

function containerFacts(
  plan: SandboxExecutionPlanV2,
  overrides: {
    environment?: Record<string, unknown>;
    resource?: Record<string, unknown>;
  } = {},
) {
  const supervisor = {
    supervisorId: locator.runtimeEnvironmentId,
    bootId: locator.runtimeInstanceId,
    epoch: 1,
  };
  const environment = {
    schemaVersion: "sandbox-execution.v2",
    kind: "container",
    environmentId: plan.environmentId,
    resourceRef: null,
    creator: plan.identity,
    mode: plan.mode,
    backendRef: plan.backendRef,
    authorizationRef: plan.authorizationRef,
    scopeDigest: plan.binding.scopeDigest,
    policyDigest: locator.effectivePolicyDigest,
    deadlineAt: plan.effectiveDeadlineAt,
    supervisor,
    workspaceConflictRefs: ["workspace"],
    executionJobId: "execution-job-1",
    environmentGeneration: 1,
    runtimeInstanceId: locator.runtimeInstanceId,
    runtimeEnvironmentId: locator.runtimeEnvironmentId,
    createIntentId: locator.createIntentId,
    stopFence: 0,
    ...overrides.environment,
  };
  return {
    schemaVersion: "sandbox-execution.v2",
    environment,
    result: null,
    effect: { kind: "unknown", reasonCode: "SANDBOX_NOT_STARTED" },
    resource: {
      schemaVersion: "sandbox-execution.v2",
      environmentId: plan.environmentId,
      creator: plan.identity,
      policyDigest: locator.effectivePolicyDigest,
      scopeDigest: plan.binding.scopeDigest,
      sequence: 2,
      occurredAt: T1,
      supervisor: environment.supervisor,
      resourceRef: null,
      status: { kind: "foreground" },
      metrics: null,
      supervision: "initializing",
      cleanup: "pending",
      ...overrides.resource,
    },
  };
}

function released(plan: SandboxExecutionPlanV2, subject: Record<string, unknown>) {
  return {
    supervision: "released",
    cleanup: "confirmed",
    sequence: 3,
    evidence: {
      ...taskEnvironmentCallEvidence({
        environmentId: plan.environmentId,
        invocationId: plan.identity.invocationId,
        createIntentId: locator.createIntentId,
        runtimeInstanceId: locator.runtimeInstanceId,
        runtimeEnvironmentId: locator.runtimeEnvironmentId,
      }),
      qualificationRef: plan.binding.qualificationRef,
      profileRef: plan.binding.profileRef,
      validUntil: plan.effectiveDeadlineAt,
      subject,
    },
  };
}

function validate(plan: SandboxExecutionPlanV2, raw: unknown) {
  const facts = sandboxExecutionFactsSchema.parse(raw);
  return validateSandboxExecutionFacts(plan, facts, {
    environment: facts.environment,
    operationContract: plan.operationContract,
  });
}

function resolveReply(
  plan: SandboxExecutionPlanV2,
  environment: unknown,
  resolvedScope: unknown = null,
) {
  return {
    schemaVersion: PAYLOAD_BROKER_V1_SCHEMA_VERSION,
    kind: "response",
    type: "payload.sandbox.execution.result",
    messageId: "reply-1",
    correlationId: "request-1",
    causationId: null,
    payload: {
      handleRef: plan.handleRef,
      invocationId: plan.identity.invocationId,
      workerInstanceId: "worker-1",
      workerBootId: "worker-boot-1",
      authorityEpoch: 1,
      fencingToken: 1,
      agentServiceInstanceId: "agent-1",
      agentServiceBootId: "agent-boot-1",
      record: {
        phase: "reserved",
        plan,
        reservation: {
          schemaVersion: "sandbox-preparation.v1",
          identity: plan.identity,
          environmentId: plan.environmentId,
          resourceRef: null,
          mode: plan.mode,
          workspaceConflictRefs: ["workspace"],
          sequence: 1,
          createdAt: plan.requestedAt,
        },
        startedAt: null,
        operationRevision: 0,
      },
      applied: false,
      resolvedScope,
      environment,
      output: null,
    },
  };
}

function scopeFor(plan: SandboxExecutionPlanV2) {
  return {
    scope: {
      schemaVersion: "sandbox-scope.v1",
      ownerId: plan.identity.ownerId,
      agentId: plan.identity.agentId,
      threadId: plan.identity.threadId,
      runId: plan.identity.runId,
      toolCallId: plan.identity.toolCallId,
      parentToolCallId: null,
      parentRequestId: plan.identity.runId,
      hostId: plan.identity.hostId,
      handleRef: plan.handleRef,
      inputRef: plan.inputRef,
      operation: plan.operation,
      authorizationRef: plan.authorizationRef,
      modelRef: plan.modelRef,
      profileRef: plan.binding.profileRef,
      directoryGrant: {
        ref: "grant-1",
        revision: 1,
        canonicalRootId: "root-fixture",
        authorizationRef: plan.authorizationRef,
        operations: ["read"],
      },
      networkAuthorizationRef: null,
      expiresAt: plan.effectiveDeadlineAt,
    },
    allowedDomains: [],
  };
}

describe("task environment execution facts", () => {
  it("binds a foreground call to the task environment and its runtime identity", async () => {
    const plan = await containerPlan();
    const initial = validate(plan, containerFacts(plan));
    expect(initial.environment.kind).toBe("container");
    const settled = validate(
      plan,
      containerFacts(plan, {
        resource: released(plan, { kind: "task_environment", environmentId: plan.environmentId }),
      }),
    );
    expect(settled.resource.supervision).toBe("released");
  });

  it("rejects a supervisor other than the runtime environment", async () => {
    const plan = await containerPlan();
    for (const supervisor of [
      { supervisorId: "another", bootId: locator.runtimeInstanceId, epoch: 1 },
      { supervisorId: locator.runtimeEnvironmentId, bootId: "daemon-2", epoch: 1 },
    ])
      expect(() =>
        validate(
          plan,
          containerFacts(plan, { environment: { supervisor }, resource: { supervisor } }),
        ),
      ).toThrow("task environment binding mismatch");
  });

  it("rejects background and service calls in a task environment", async () => {
    const foreground = await containerPlan();
    const plan = {
      ...foreground,
      mode: "background" as const,
      operationContract: { kind: "task_start" as const, ref: "task", version: "1" },
    };
    expect(() =>
      validate(
        plan,
        containerFacts(plan, {
          environment: { mode: "background", resourceRef: "resource-1" },
          resource: { resourceRef: "resource-1", status: { kind: "task", state: "starting" } },
        }),
      ),
    ).toThrow("task environment binding mismatch");
  });

  it("requires task environment evidence naming the same environment", async () => {
    const plan = await containerPlan();
    for (const subject of [
      { kind: "local_process", processIdentityRef: "process-1" },
      { kind: "task_environment", environmentId: "environment-other" },
    ])
      expect(() =>
        validate(plan, containerFacts(plan, { resource: released(plan, subject) })),
      ).toThrow("supervision subject mismatch");
  });

  it("rejects task environment evidence for a local sandbox job", async () => {
    const f = await openSandboxJournal();
    cleanups.push(f.close);
    const admitted = sandboxV2Call(f, "admit", sandboxV2Admission(f)).record;
    const facts = {
      ...admitted.facts,
      resource: {
        ...admitted.facts.resource,
        ...released(admitted.plan, {
          kind: "task_environment",
          environmentId: admitted.plan.environmentId,
        }),
        sequence: 2,
      },
    };
    expect(() => validate(admitted.plan, facts)).toThrow("supervision subject mismatch");
  });

  it("rejects a negative stop fence", async () => {
    const plan = await containerPlan();
    expect(() =>
      sandboxExecutionFactsSchema.parse(containerFacts(plan, { environment: { stopFence: -1 } })),
    ).toThrow("$.environment.stopFence");
  });
});

describe("task environment call evidence", () => {
  it("is stable for one call and distinct across calls and creations", () => {
    const base = {
      environmentId: "environment-task-1",
      invocationId: "invocation-1",
      createIntentId: locator.createIntentId,
      runtimeInstanceId: locator.runtimeInstanceId,
      runtimeEnvironmentId: locator.runtimeEnvironmentId,
    };
    const first = taskEnvironmentCallEvidence(base);
    expect(taskEnvironmentCallEvidence({ ...base })).toEqual(first);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    for (const changed of [
      { invocationId: "invocation-2" },
      { createIntentId: "environment-create-2" },
      { runtimeEnvironmentId: "d".repeat(64) },
    ]) {
      const other = taskEnvironmentCallEvidence({ ...base, ...changed });
      expect(other.digest).not.toBe(first.digest);
    }
  });
});

describe("resolve reply environment binding", () => {
  const binding = (plan: SandboxExecutionPlanV2, changes: Record<string, unknown> = {}) => ({
    identity: environmentIdentity(plan),
    createIntentId: locator.createIntentId,
    locator,
    stopFence: 0,
    ...changes,
  });

  it("carries the bound task environment with the resolved scope", async () => {
    const plan = await containerPlan();
    const parsed = payloadBrokerV1MessageSchema.parse(
      resolveReply(plan, binding(plan), scopeFor(plan)),
    );
    expect(parsed.type).toBe("payload.sandbox.execution.result");
    if (parsed.type !== "payload.sandbox.execution.result") return;
    expect(parsed.payload.environment?.identity.environmentId).toBe(plan.environmentId);
    expect(payloadBrokerV1MessageSchema.parse(resolveReply(plan, null, scopeFor(plan))).type).toBe(
      "payload.sandbox.execution.result",
    );
  });

  it("rejects an environment binding without a resolved scope", async () => {
    const plan = await containerPlan();
    expect(() => payloadBrokerV1MessageSchema.parse(resolveReply(plan, binding(plan)))).toThrow(
      "sandbox task environment mismatch",
    );
  });

  it("rejects a binding for another environment, Run, backend or creation", async () => {
    const plan = await containerPlan();
    const identity = environmentIdentity(plan);
    for (const changed of [
      { identity: { ...identity, environmentId: "environment-other" } },
      { identity: { ...identity, runId: "run-other" } },
      { identity: { ...identity, hostId: "host-other" } },
      { identity: { ...identity, role: "network_helper" } },
      { locator: { ...locator, backendRef: "srt" } },
      { createIntentId: "environment-create-2" },
    ])
      expect(() =>
        payloadBrokerV1MessageSchema.parse(
          resolveReply(plan, binding(plan, changed), scopeFor(plan)),
        ),
      ).toThrow("sandbox task environment mismatch");
  });
});
