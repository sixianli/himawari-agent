import { createAgentId, createOwnerId, createRunId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import {
  type CandidateWorkspacePort,
  type CommandProfile,
  candidateSecurityAttentionKey,
  DurableImprovementStateAdapter,
  ImprovementCandidateService,
  type JsonObject,
} from "../src/index.js";
import { TestStateStore, testDigest } from "./test-support.js";

const scope = {
  ownerId: createOwnerId("owner-candidate-regression"),
  agentId: createAgentId("agent-candidate-regression"),
};

function fixture() {
  const store = new TestStateStore();
  const state = new DurableImprovementStateAdapter(store);
  let disposalAttempts = 0;
  let failDisposal = false;
  let quarantineAttempts = 0;
  let failQuarantine = false;
  let failAttention = false;
  const attentionKeys: string[] = [];
  const workspace: CandidateWorkspacePort = {
    qualify: async () => ({
      qualified: true,
      platform: "linux",
      runtimeIdentity: "fixture",
      evidenceRefs: [],
      reasonCodes: [],
    }),
    create: async () => "/candidate/root",
    patch: async () => ({ patchDigest: testDigest("patch"), changedPaths: ["src/a.ts"] }),
    validate: async ({ profiles }) =>
      profiles.map(({ id }) => ({
        profileId: id,
        commandObservationRef: "observation:validation",
        outcome: "passed",
      })),
    compare: async ({ inputSetDigest }) => ({
      inputSetDigest,
      baseResultRef: "payload:base",
      candidateResultRef: "payload:candidate",
      qualityDeltaPermille: 1,
      performanceDeltaPermille: 0,
      resourceDeltaPermille: 0,
      regressionRefs: [],
    }),
    packageArtifact: async () => ({
      artifactRef: "payload:artifact",
      artifactDigest: testDigest("artifact"),
    }),
    quarantine: async () => {
      quarantineAttempts += 1;
      if (failQuarantine && quarantineAttempts === 1)
        throw new Error("temporary quarantine failure");
    },
    dispose: async () => {
      disposalAttempts += 1;
      if (failDisposal && disposalAttempts === 1) throw new Error("temporary disposal failure");
    },
  };
  const dependencies = {
    state,
    workspace,
    digest: { digest: testDigest, digestCanonical: testDigest },
    clock: { now: () => "2026-08-28T00:00:00.000Z" },
    ids: { next: () => "candidate-regression" },
    attention: {
      raise: async ({ idempotencyKey }: { readonly idempotencyKey: string }) => {
        attentionKeys.push(idempotencyKey);
        if (failAttention && attentionKeys.length === 1)
          throw new Error("uncertain attention failure");
      },
    },
  };
  return {
    store,
    state,
    createService: () =>
      new ImprovementCandidateService({
        ...dependencies,
        state: new DurableImprovementStateAdapter(store),
      }),
    disposalAttempts: () => disposalAttempts,
    quarantineAttempts: () => quarantineAttempts,
    attentionKeys,
    failFirstQuarantine: () => {
      failQuarantine = true;
    },
    failFirstAttention: () => {
      failAttention = true;
    },
    failFirstDisposal: () => {
      failDisposal = true;
    },
  };
}

async function propose(service: ImprovementCandidateService) {
  return service.propose({
    ...scope,
    generationRunId: createRunId("run-candidate-regression"),
    traceRef: "trace:candidate",
    observableProblemRef: "payload:problem",
    goalRef: "payload:goal",
    invariantRefs: ["invariant:scope"],
    baseRevision: "base",
    baseDigest: testDigest("base"),
    allowedPaths: ["src"],
    reasonRef: "payload:reason",
    risk: "low",
    expiresAt: "2026-08-29T00:00:00.000Z",
    spaceBudgetBytes: 1_000_000,
  });
}

describe("ImprovementCandidateService durable boundaries", () => {
  it("normalizes and resumes a legacy durable security failure without recovery fields", async () => {
    const f = fixture();
    const candidate = await propose(f.createService());
    const record = await f.store.read("improvement");
    if (!record) throw new Error("fixture missing durable record");
    const {
      cleanup: _cleanup,
      securityResponse: _securityResponse,
      ...legacyCandidate
    } = candidate;
    const legacy: JsonObject = {
      ...JSON.parse(JSON.stringify(legacyCandidate)),
      status: "security_failure",
      protectedRootFacts: ["security-failure:LEGACY_FAILURE"],
    };
    await f.store.compareAndSet({
      key: "improvement",
      expectedRevision: record.revision,
      value: { entities: [legacy] },
    });
    const restored = await f.state.read(scope, candidate.id);
    expect(restored).toMatchObject({
      cleanup: { status: "not_requested" },
      securityResponse: {
        status: "quarantine_pending",
        reasonCode: "LEGACY_FAILURE",
        requestedAt: candidate.updatedAt,
        attentionIdempotencyKey: candidateSecurityAttentionKey(candidate),
      },
    });
    await f.createService().expire(scope.ownerId, scope.agentId, "2026-08-28T01:00:00.000Z");
    expect(f.quarantineAttempts()).toBe(1);
    expect(f.attentionKeys).toEqual([candidateSecurityAttentionKey(candidate)]);
    expect(await f.state.read(scope, candidate.id)).toMatchObject({
      securityResponse: { status: "completed", reasonCode: "LEGACY_FAILURE" },
    });
  });

  it("recovers quarantine before expiry after a failure and service restart", async () => {
    const f = fixture();
    const candidate = await propose(f.createService());
    f.failFirstQuarantine();
    await expect(
      f.createService().rejectSelfActivation(scope, candidate.id, "apply"),
    ).rejects.toThrow("temporary quarantine failure");
    expect(await f.state.read(scope, candidate.id)).toMatchObject({
      status: "security_failure",
      securityResponse: { status: "quarantine_pending" },
    });
    await f.createService().expire(scope.ownerId, scope.agentId, "2026-08-28T01:00:00.000Z");
    expect(f.quarantineAttempts()).toBe(2);
    expect(f.attentionKeys).toHaveLength(1);
    expect(f.disposalAttempts()).toBe(0);
    expect(await f.state.read(scope, candidate.id)).toMatchObject({
      status: "security_failure",
      securityResponse: { status: "completed" },
    });
  });

  it("replays pending attention with the same key without repeating successful quarantine", async () => {
    const f = fixture();
    const candidate = await propose(f.createService());
    f.failFirstAttention();
    await expect(
      f.createService().rejectSelfActivation(scope, candidate.id, "apply"),
    ).rejects.toThrow("uncertain attention failure");
    expect(await f.state.read(scope, candidate.id)).toMatchObject({
      status: "security_failure",
      securityResponse: { status: "attention_pending" },
    });
    await expect(
      f.createService().rejectSelfActivation(scope, candidate.id, "apply"),
    ).rejects.toThrow("cannot apply");
    expect(f.quarantineAttempts()).toBe(1);
    expect(f.attentionKeys).toHaveLength(2);
    expect(f.attentionKeys[0]).toBeTruthy();
    expect(f.attentionKeys[0]).toBe(f.attentionKeys[1]);
    expect(await f.state.read(scope, candidate.id)).toMatchObject({
      securityResponse: { status: "completed" },
    });
  });

  it("accepts directory-relative change scope with an absolute sandbox root", async () => {
    const f = fixture();
    const service = f.createService();
    const candidate = await propose(service);
    const profile: CommandProfile = {
      id: "candidate-profile",
      revision: 1,
      workspaceId: candidate.workspaceRef,
      argvPattern: ["npm", "test"],
      workdir: candidate.workspaceRef,
      environmentNames: [],
      fileScopes: [candidate.workspaceRef],
      network: "none",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      resources: { maxCpuTimeMs: 1_000, maxMemoryBytes: 1_000_000, maxProcesses: 2 },
      sandboxTier: "isolated-high-risk",
      sandboxRuntimeIdentity: "fixture",
      scriptDigest: null,
      scriptSource: null,
      authorizationRef: "authorization:profile",
      expiresAt: "2026-08-29T00:00:00.000Z",
      revokedAt: null,
    };
    const result = await service.patchValidateCompare({
      scope,
      candidateId: candidate.id,
      patchRef: "payload:patch",
      profiles: [profile],
      inputSetDigest: testDigest("inputs"),
      comparisonDefinition: {},
    });
    expect(result.status).toBe("review_required");
  });

  it("retries failed cleanup after rebuilding the service from durable expired state", async () => {
    const f = fixture();
    const candidate = await propose(f.createService());
    f.failFirstDisposal();
    await expect(
      f.createService().expire(scope.ownerId, scope.agentId, "2026-08-30T00:00:00.000Z"),
    ).rejects.toThrow("temporary disposal");
    await f.createService().expire(scope.ownerId, scope.agentId, "2026-08-30T00:00:00.000Z");
    expect(f.disposalAttempts()).toBe(2);
    expect(await f.state.read(scope, candidate.id)).toMatchObject({
      status: "expired",
      cleanup: { status: "completed" },
    });
  });
});
