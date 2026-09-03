import {
  AutonomyGatewayV2ControlPlane,
  AutonomyGatewayV2ReadModel,
  DurableDelegationStateAdapter,
  DurableImprovementStateAdapter,
  DurableProactivityStateAdapter,
  ReflectionService,
  SuggestionService,
  type GatewayAuthenticationContext,
  type GatewayV2ControlPlanePort,
  type GatewayV2ReadModelPort,
  type GovernanceMutationReceipt,
  type GovernanceMutationReceiptStorePort,
  type ImprovementCandidateService,
  type Delegation,
  type ImprovementCandidate,
} from "../src/index.js";
import { createAgentId, createOwnerId, createRunId } from "@himawari-agent/domain";
import {
  gatewayV2MessageSchema,
  type GatewayV2Command,
  type GatewayV2Query,
} from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";
import { TestStateStore, testDigest } from "./test-support.js";

const ownerId = createOwnerId("owner-autonomy-gateway");
const agentId = createAgentId("agent-autonomy-gateway");
const runId = createRunId("run-autonomy-gateway");
const now = "2026-08-29T00:00:00.000Z";

class MemoryReceipts implements GovernanceMutationReceiptStorePort {
  readonly values = new Map<string, GovernanceMutationReceipt>();
  failCompleteOnce = false;
  async get(
    _ownerId: GovernanceMutationReceipt["ownerId"],
    _agentId: GovernanceMutationReceipt["agentId"],
    key: string,
  ) {
    return this.values.get(key);
  }
  async create(receipt: GovernanceMutationReceipt) {
    if (this.values.has(receipt.idempotencyKey)) throw new Error("duplicate");
    this.values.set(receipt.idempotencyKey, receipt);
    return receipt;
  }
  async complete(receipt: GovernanceMutationReceipt, expectedRevision: number) {
    if (this.failCompleteOnce) {
      this.failCompleteOnce = false;
      throw new Error("receipt acknowledgement lost");
    }
    if (this.values.get(receipt.idempotencyKey)?.revision !== expectedRevision)
      throw new Error("conflict");
    this.values.set(receipt.idempotencyKey, receipt);
    return receipt;
  }
}

function envelope(kind: "command" | "query", type: string) {
  return {
    schemaVersion: "gateway.v2",
    kind,
    type,
    messageId: `message:${type}`,
    correlationId: "correlation:autonomy",
    causationId: null,
    dataClassification: "private",
    risk: kind === "command" ? "high" : "low",
    authorizationRef: kind === "command" ? "authorization:owner" : null,
    scope: { ownerId, agentId },
    authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "owner", actorId: ownerId },
  };
}

function command(type: GatewayV2Command["type"], payload: unknown, idempotencyKey: string) {
  const parsed = gatewayV2MessageSchema.parse({
    ...envelope("command", type),
    idempotencyKey,
    payload,
  });
  if (parsed.kind !== "command") throw new TypeError("command fixture invalid");
  return parsed;
}

function query(type: GatewayV2Query["type"], payload: unknown) {
  const parsed = gatewayV2MessageSchema.parse({ ...envelope("query", type), payload });
  if (parsed.kind !== "query") throw new TypeError("query fixture invalid");
  return parsed;
}

describe("Autonomy Gateway v2 adapters", () => {
  it.each(["other-agent", "other-owner"])(
    "keeps foreign detail and review outside the authenticated scope: %s",
    async (foreign) => {
      const store = new TestStateStore();
      const entityScope = {
        ownerId: foreign === "other-owner" ? createOwnerId("owner-foreign") : ownerId,
        agentId: createAgentId("agent-foreign"),
      };
      const delegation: Delegation = {
        ...entityScope,
        id: "delegation:foreign",
        revision: 1,
        parentRunId: runId,
        traceRef: "trace:foreign",
        workerRunId: "worker:foreign",
        subtaskRef: "payload:foreign-subtask",
        outputSchema: { type: "object" },
        contextRefs: [],
        capabilityHandleRefs: [],
        allowedModelRefs: ["model:one"],
        selectedModelRef: "model:one",
        dataClassification: "private",
        budget: { maximumDurationMs: 1000, maximumCostMicros: 10, maximumProgressEvents: 1 },
        progressEventsObserved: 0,
        progressReceipts: [],
        executionGeneration: 0,
        executionClaim: null,
        pendingResultRef: null,
        handlesEndedAt: null,
        workerCancelledAt: null,
        deadlineAt: "2026-09-01T00:00:00.000Z",
        depth: 1,
        status: "created",
        proposalRef: null,
        failureReasonCode: null,
        workerResult: null,
        createdAt: now,
        updatedAt: now,
      };
      const candidate: ImprovementCandidate = {
        ...entityScope,
        id: "candidate:foreign",
        revision: 1,
        generationRunId: runId,
        traceRef: "trace:foreign",
        observableProblemRef: "payload:problem",
        goalRef: "payload:goal",
        invariantRefs: [],
        baseRevision: "base:1",
        baseDigest: "digest:1",
        allowedPaths: ["src"],
        workspaceRef: "workspace:foreign",
        patchRef: "payload:patch",
        patchDigest: "digest:patch",
        reasonRef: "payload:reason",
        risk: "high",
        protectedRootFacts: [],
        validation: [],
        comparison: null,
        artifactRef: null,
        artifactDigest: null,
        status: "review_required",
        reviewRequired: true,
        cleanup: { status: "not_requested" },
        securityResponse: { status: "not_requested" },
        expiresAt: "2026-09-01T00:00:00.000Z",
        spaceBudgetBytes: 1000,
        createdAt: now,
        updatedAt: now,
      };
      const delegations = new DurableDelegationStateAdapter(store);
      const improvements = new DurableImprovementStateAdapter(store);
      await delegations.create(delegation);
      await improvements.create(candidate);
      let protectedReads = 0;
      const reads = new AutonomyGatewayV2ReadModel({
        delegate: {
          query: async () => {
            throw new Error("unexpected delegation");
          },
          async *subscribe() {},
        },
        proactivity: new DurableProactivityStateAdapter(store),
        delegations,
        improvements,
        protectJson: async () => {
          protectedReads += 1;
          return "payload:json";
        },
        clock: { now: () => now },
        ownerId,
        agentId,
      });
      await expect(
        reads.query(query("delegation.detail", { delegationId: delegation.id })),
      ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
      await expect(
        reads.query(query("improvement.detail", { candidateId: candidate.id })),
      ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
      expect(protectedReads).toBe(0);
      const control = new AutonomyGatewayV2ControlPlane({
        delegate: {
          execute: async () => {
            throw new Error("unexpected delegation");
          },
        },
        suggestions: {} as SuggestionService,
        reflections: {} as ReflectionService,
        improvements: {} as ImprovementCandidateService,
        proactivityState: new DurableProactivityStateAdapter(store),
        improvementState: improvements,
        receipts: new MemoryReceipts(),
        clock: { now: () => now },
      });
      await expect(
        control.execute({
          authentication: {
            ownerId,
            subjectId: ownerId,
            deviceId: "device-01",
            authenticatedAt: now,
            authenticationRef: "authentication:owner",
          },
          command: command(
            "improvement.review",
            {
              candidateId: candidate.id,
              expectedRevision: 1,
              decision: "reject",
              reviewEvidenceRef: "payload:review-evidence",
            },
            `review:${foreign}`,
          ),
        }),
      ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
      expect((await improvements.read(entityScope, candidate.id))?.status).toBe("review_required");
      await expect(
        delegations.save({ ...delegation, revision: 2, ownerId, agentId }, 1),
      ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    },
  );

  it("replays Owner suggestion approval without creating a second Task and restores the read model", async () => {
    const store = new TestStateStore();
    const state = new DurableProactivityStateAdapter(store);
    let sequence = 0;
    const tasks: unknown[] = [];
    const suggestion = new SuggestionService({
      state,
      delivery: { enqueue: async ({ suggestion: item }) => `inbox:${item.id}` },
      tasks: {
        createOrdinaryTask: async (input) => {
          tasks.push(input);
          return `task:${input.suggestionId}`;
        },
      },
      digest: {
        digest: (bytes) => testDigest(bytes),
        digestCanonical: (value) => testDigest(value),
      },
      clock: { now: () => now },
      ids: { next: (prefix) => `${prefix}-${++sequence}` },
    });
    const proposed = await suggestion.propose({
      ownerId,
      agentId,
      generationRunId: runId,
      traceRef: "trace:suggestion",
      draft: {
        kind: "goal-follow-up",
        titleRef: "payload:title",
        bodyRef: "payload:body",
        evidenceRefs: ["evidence:1"],
        sourceWatermark: "watermark:1",
        goalRef: "goal:1",
        commitmentRef: null,
        taskDraft: {
          goalRef: "payload:goal",
          trigger: "owner_approved_suggestion",
          capabilityRefs: ["capability:read"],
          dataClassification: "private",
          estimatedCostMicros: 100,
          timezone: "Asia/Tokyo",
          timeoutMs: 1_000,
        },
        confidencePermille: 900,
        noveltyPermille: 800,
        targetEntity: "goal:1",
        proposedAction: "follow-up",
        ownerScopeRevision: 1,
        estimatedDataClasses: ["private"],
        expiresAt: "2026-09-01T00:00:00.000Z",
      },
    });
    if (!proposed.candidate) throw new TypeError("suggestion missing");
    const reflection = new ReflectionService({
      state,
      suggestions: suggestion,
      context: {
        select: async () => ({
          inputRef: "payload:context",
          watermark: "watermark:2",
          itemCount: 1,
        }),
      },
      model: {
        reflect: async () => ({
          outcome: "no_change",
          candidates: [],
          costMicros: 0,
          metadata: {},
        }),
      },
      clock: { now: () => now },
      ids: { next: (prefix) => `${prefix}-${++sequence}` },
    });
    const delegateControl: GatewayV2ControlPlanePort = {
      execute: async () => {
        throw new Error("unexpected delegate");
      },
    };
    const receipts = new MemoryReceipts();
    receipts.failCompleteOnce = true;
    const control = new AutonomyGatewayV2ControlPlane({
      delegate: delegateControl,
      suggestions: suggestion,
      reflections: reflection,
      improvements: {} as ImprovementCandidateService,
      proactivityState: state,
      improvementState: new DurableImprovementStateAdapter(store),
      receipts,
      clock: { now: () => now },
    });
    const authentication: GatewayAuthenticationContext = {
      ownerId,
      subjectId: ownerId,
      deviceId: "device-01",
      authenticatedAt: now,
      authenticationRef: "authentication:owner",
    };
    const approve = command(
      "suggestion.respond",
      {
        suggestionId: proposed.candidate.id,
        expectedRevision: proposed.candidate.revision,
        decision: "approve",
      },
      "suggestion-approval-01",
    );
    await expect(control.execute({ authentication, command: approve })).rejects.toThrow(
      "receipt acknowledgement lost",
    );
    expect(await control.execute({ authentication, command: approve })).toMatchObject({
      replayed: true,
    });
    expect(tasks).toHaveLength(1);

    const delegateReads: GatewayV2ReadModelPort = {
      query: async () => {
        throw new Error("unexpected delegate");
      },
      async *subscribe() {},
    };
    const restoredState = new DurableProactivityStateAdapter(store);
    const reads = new AutonomyGatewayV2ReadModel({
      delegate: delegateReads,
      proactivity: restoredState,
      delegations: new DurableDelegationStateAdapter(store),
      improvements: new DurableImprovementStateAdapter(store),
      protectJson: async () => "payload:json",
      clock: { now: () => now },
      ownerId,
      agentId,
    });
    expect(
      await reads.query(
        query("suggestion.list", { status: "approved", afterCursor: null, limit: 10 }),
      ),
    ).toMatchObject({
      type: "collection.snapshot",
      payload: { itemRefs: [proposed.candidate.id] },
    });
    expect(
      await reads.query(query("suggestion.detail", { suggestionId: proposed.candidate.id })),
    ).toMatchObject({
      type: "suggestion.snapshot",
      payload: { status: "approved", taskRef: `task:${proposed.candidate.id}` },
    });
  });
});
