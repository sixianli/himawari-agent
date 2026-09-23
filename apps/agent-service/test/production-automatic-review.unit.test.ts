import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ActionPolicyService,
  actionIntentFingerprint,
  type CapabilityManifest,
  claimFromRunExecutionLease,
  type GovernedActionIntent,
  type ModelDescriptor,
  type ModelInvocationRequest,
  type ProductConfiguration,
  type RunExecutionLeaseClaim,
  ThreadCommandService,
} from "@himawari-agent/application";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  EnvelopePayloadProtector,
  EphemeralSecretPort,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";

import { createProductionAutomaticReview } from "../src/production-automatic-review.js";

// The app layer owns no identifier constructors; branded values are plain strings here.
const OWNER_ID = "owner-review-wiring" as GovernedActionIntent["ownerId"];
const AGENT_ID = "agent-review-wiring" as GovernedActionIntent["agentId"];
const RUN_ID = "run-review-wiring" as GovernedActionIntent["runId"];
const THREAD_ID = "thread-review-wiring";
const DEPLOYMENT_ID = "deployment-review-wiring" as ProductConfiguration["deploymentId"];
const LEASE_ID = "lease-review-wiring" as Parameters<
  typeof claimFromRunExecutionLease
>[0]["authorityLeaseId"];
const EXECUTION_LEASE_ID = "execution-lease-review-wiring" as Parameters<
  typeof claimFromRunExecutionLease
>[0]["executionLeaseId"];
const INPUT_REF = "payload-review-wiring-input";
const DELEGATION_KEY = "automatic-review-delegation";
/** The durable review transaction uses the repository's real writer clock while the
 * product policy clock is injected. The policy clock starts far enough after wall time
 * that loaded runs still observe "now is inside the committed Grant window"; the whole
 * review then has to fit inside the remaining approval window. */
const WALL_NOW = Date.now();
const NOW = new Date(WALL_NOW + 30_000).toISOString();
const EXPIRES_AT = new Date(WALL_NOW + 300_000).toISOString();
const MAXIMUM_WAIT_MS = 10_000;
const REVIEW_MODEL = "fallback";
const AUTHORITY = Object.freeze({
  product: Object.freeze({ deploymentId: DEPLOYMENT_ID, authorityEpoch: 1, fencingToken: 1 }),
  lease: Object.freeze({ leaseId: LEASE_ID, fencingToken: 1 }),
  agentServiceInstanceId: "agent-service-instance-review-wiring",
  agentServiceBootId: "agent-service-boot-review-wiring",
  workerInstanceId: "worker-instance-review-wiring",
  workerBootId: "worker-boot-review-wiring",
});
const REVIEW_KEK = new Uint8Array(32).fill(7);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function action(): GovernedActionIntent {
  return {
    contractVersion: "authorization.v2",
    id: "coding:review-wiring",
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    capabilityRef: "file:review",
    capabilityVersion: "1.0.0",
    operation: "write",
    resourceRef: "coding:review-wiring",
    resourceRefs: ["coding:review-wiring"],
    targets: [
      { type: "host", ref: "host-review-wiring" },
      { type: "tool", ref: "write" },
      { type: "input-digest", ref: "digest-review-wiring" },
    ],
    dataClassification: "private",
    sideEffect: "reversible",
    estimatedCostMicros: 0,
    frequency: { count: 1, intervalMs: null },
    idempotencyKey: "coding:review-wiring" as GovernedActionIntent["idempotencyKey"],
    reversible: true,
    requestedAt: NOW,
    expiresAt: EXPIRES_AT,
    actionKind: "CREATE_OR_UPDATE",
    disclosure: "none",
    recipients: [],
    credentialOrAccessChange: false,
    modelClassification: {
      actionKind: "CREATE_OR_UPDATE",
      suggestedRisk: "HIGH",
      reasonCode: "product_governed_coding",
    },
    deterministicFacts: [
      { code: "external_model_disclosure", minimumRisk: "HIGH", source: "product" },
    ],
    finalRisk: "HIGH",
  };
}

function reviewConfiguration(): NonNullable<
  NonNullable<ProductConfiguration["runPolicy"]>["automaticReview"]
> {
  return {
    delegationKey: DELEGATION_KEY,
    configurationVersion: "review-config:1",
    modelRef: REVIEW_MODEL,
    maximumWaitMs: MAXIMUM_WAIT_MS,
    maxOutputBytes: 4096,
    confidenceThreshold: 0.8,
  };
}

function reviewDescriptor(): ModelDescriptor {
  return {
    ref: REVIEW_MODEL,
    provider: "fixture",
    model: "review-fixture",
    version: "1",
    routingClass: "specialist",
    priority: 1,
    disclosure: "trusted_remote",
    capabilities: ["text"],
    allowedDataClassifications: ["private"],
    secretRequirement: null,
  };
}

function generationDescriptor(ref: "primary" | "fallback", priority: number) {
  return {
    ref,
    role: ref,
    provider: "fixture",
    model: `${ref}-fixture`,
    version: "1",
    priority,
    allowedDataClassifications: ["private" as const],
    disclosure: "trusted_remote" as const,
    secretRef: null,
    capabilities: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    name: "fixture",
    api: "openai-completions" as const,
    reasoning: false,
    input: ["text" as const],
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

function configuration(configured: boolean): ProductConfiguration {
  return {
    schemaVersion: "configuration.v2",
    deploymentId: DEPLOYMENT_ID,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    stateRoot: "/unused",
    runtimeDirectory: "/unused",
    cacheDirectory: "/unused",
    publicOrigin: "https://example.invalid",
    publicMode: true,
    modelDescriptors: [
      generationDescriptor("primary", 1),
      generationDescriptor("fallback", 2),
      {
        ref: "embedding",
        role: "embedding",
        provider: "fixture",
        model: "embedding-fixture",
        version: "1",
        dimensions: 16,
        allowedDataClassifications: ["private"],
        disclosure: "local_only",
        secretRef: null,
        capabilities: ["embedding"],
        cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    memory: { adapter: "mem0-oss", version: "1", storagePath: "/unused", dimensions: 16 },
    repositoryAllowlistRefs: [],
    secretReferences: [],
    budgets: {
      globalCostMicros: 1000,
      perRunCostMicros: 1000,
      perClassificationCostMicros: { public: 1000, private: 1000, sensitive: 0, restricted: 0 },
    },
    concurrency: { totalRuns: 1, foregroundReserved: 0, perCategory: {} },
    deadlines: { runMs: 1000, workerRequestMs: 1000, providerRequestMs: 1000 },
    loadedAt: NOW,
    runPolicy: {
      version: "review-policy:1",
      systemInstruction: "fixture",
      memoryLimit: 1,
      maxSelectedMemories: 0,
      maxMemoryClassification: "private",
      ...(configured ? { automaticReview: reviewConfiguration() } : {}),
    },
  };
}

async function fixture() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-review-wiring-"));
  const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
  const migrations = await loadBundledMigrations();
  database.transaction(() => applyMigrations(database, migrations)).immediate();
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
       VALUES (?, ?, ?, 0, 'active', 1, 1)`,
    )
    .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);
  database
    .prepare(
      `INSERT INTO authority_leases (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
         fencing_token, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, 'holder-review-wiring', 1, 1, ?, '2999-12-31T23:59:59.999Z')`,
    )
    .run(LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, NOW);
  database.close();
  let repository = await SqliteProductStateRepository.open({ stateRoot, minimumFreeBytes: 0 });
  const protector = new EnvelopePayloadProtector({
    keys: new InMemoryDevelopmentSecretSource({ "review-kek@v1": REVIEW_KEK }),
    activeKey: { keyRef: "review-kek", kekVersion: "v1", dekVersion: "dek-v1" },
  });
  cleanups.push(async () => {
    await repository.close();
    await rm(stateRoot, { recursive: true });
  });
  let identifier = 0;
  const ids = { next: (scope: string) => `${scope}:${++identifier}` };
  const handles = new EphemeralSecretPort({
    ids: { next: (scope: string) => `${scope}:handle:${++identifier}` },
    clock: { now: () => NOW },
  });
  /** Keys and the input payload are written through the real protector, not raw SQL. */
  await repository.payloadStore(OWNER_ID, AGENT_ID).put(
    await protector.protect({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      ref: INPUT_REF,
      dataClassification: "private",
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("执行已授权的写入"),
      createdAt: NOW,
    }),
  );
  /** The Run, its trigger and its message are created through the real admission path. */
  const commands = new ThreadCommandService({
    repository: repository.threadRepository(),
    clock: { now: () => NOW },
    authority: () => AUTHORITY.product,
  });
  const thread = await commands.create({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: THREAD_ID as NonNullable<Parameters<ThreadCommandService["create"]>[0]["threadId"]>,
    idempotencyKey: "review-wiring-thread",
    resultRef: INPUT_REF,
  });
  await commands.admitOwnerMessage({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: thread.thread.id,
    expectedThreadRevision: thread.thread.revision,
    sessionId: "session-review-wiring" as Parameters<
      ThreadCommandService["admitOwnerMessage"]
    >[0]["sessionId"],
    runId: RUN_ID,
    idempotencyKey: "review-wiring-message",
    contentRef: INPUT_REF,
    sourceProofRef: "fixture-owner",
    dataClassification: "private",
    resultRef: INPUT_REF,
  });
  await repository.close();
  // Admission seeds the Run as accepted and the Thread at revision 0; the shared
  // review observation writer joins the live Run and advances the Thread itself.
  {
    const writable = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    writable
      .prepare("UPDATE runs SET status='running' WHERE id=? AND status='accepted'")
      .run(RUN_ID);
    writable.prepare("UPDATE threads SET revision=1 WHERE id=?").run(THREAD_ID);
    writable
      .prepare(
        `INSERT INTO run_execution_leases (owner_id, agent_id, run_id, revision, authority_lease_id,
           deployment_id, authority_epoch, fencing_token, consumer_id, execution_lease_id, claimed_at,
           initial_expires_at, expires_at)
         VALUES (?, ?, ?, 1, ?, ?, 1, 1, 'review-consumer', ?, ?, ?, ?)`,
      )
      .run(
        OWNER_ID,
        AGENT_ID,
        RUN_ID,
        LEASE_ID,
        DEPLOYMENT_ID,
        EXECUTION_LEASE_ID,
        NOW,
        EXPIRES_AT,
        EXPIRES_AT,
      );
    writable.close();
  }
  repository = await SqliteProductStateRepository.open({ stateRoot, minimumFreeBytes: 0 });
  const reopened = repository;
  const executionLease = async (): Promise<RunExecutionLeaseClaim> => {
    const lease = await reopened
      .runDispatch(OWNER_ID, AGENT_ID, AUTHORITY.product, AUTHORITY.lease, "review-consumer")
      .currentExecutionLease?.({ runId: RUN_ID, at: NOW });
    if (!lease) throw new Error("AUTOMATIC_REVIEW_LEASE_UNAVAILABLE");
    return claimFromRunExecutionLease(lease);
  };
  return { repository: reopened, protector, handles, ids, executionLease };
}

function manifest(): CapabilityManifest {
  return {
    manifestVersion: "capability.v2" as const,
    ref: "file:review",
    displayName: "Review fixture",
    version: "1.0.0",
    source: { type: "tool" as const, locator: "tool:file-review:1.0.0" },
    sourceIdentity: "tool:trusted-publisher",
    integrity: `sha256:${"a".repeat(64)}`,
    artifact: {
      digest: `sha256:${"a".repeat(64)}`,
      signatureStatus: "not_applicable" as const,
      signerRef: null,
      rollbackArtifactRef: null,
    },
    operations: ["write"],
    permissionRefs: [],
    scopes: { dataClassifications: ["private"], network: [], filesystem: [], secrets: [] },
    isolation: "worker" as const,
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy" as const, checkedAt: NOW },
    reviewedBy: null,
    reviewedAt: null,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: { kind: "pi_tool" as const, piBuiltinDefinition: "write" },
  };
}

function policy(
  store: ReturnType<SqliteProductStateRepository["authorizationStore"]>,
  review?: ReturnType<typeof createProductionAutomaticReview>,
) {
  return new ActionPolicyService({
    store,
    capabilities: {
      inspect: async () => ({ lifecycle: "active" as const, manifest: manifest() }),
    },
    policy: { version: "review-policy:1", rules: [] },
    clock: { now: () => NOW },
    ids: { next: (scope: string) => `${scope}:policy:1` },
    ...(review ? { automaticReview: review } : {}),
  });
}

async function seedDelegation(
  repository: SqliteProductStateRepository,
  intentFingerprints: readonly string[],
): Promise<void> {
  await repository.commitStateAndEvents({
    command: {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      idempotencyKey: "seed-review-delegation" as Parameters<
        SqliteProductStateRepository["commitStateAndEvents"]
      >[0]["command"]["idempotencyKey"],
      commandType: "fixture.seedReviewDelegation",
      commandFingerprint: "seed-review-delegation",
      authority: { leaseId: LEASE_ID, fencingToken: 1 },
    },
    state: {
      key: DELEGATION_KEY,
      expectedRevision: null,
      value: {
        kind: "automatic-review.v1",
        enabled: true,
        configurationVersion: "review-config:1",
        modelRef: REVIEW_MODEL,
        policyVersion: "review-policy:1",
        intentFingerprints: [...intentFingerprints],
        expiresAt: EXPIRES_AT,
      },
    },
    events: [],
    resultRef: "fixture-review-delegation",
    committedAt: NOW,
  });
}

function reviewerResponse(
  request: ModelInvocationRequest,
  decision: "approve" | "deny" | "human" | "alternative",
): Record<string, unknown> {
  return {
    schemaVersion: "automatic-review.v1",
    reviewId: request.invocationId,
    intentFingerprint: actionIntentFingerprint(action()),
    policyVersion: "review-policy:1",
    configurationVersion: "review-config:1",
    modelRef: REVIEW_MODEL,
    reasonCode: "WITHIN_DELEGATION",
    // Approvals carry a calibrated confidence above the configured 0.8 boundary.
    ...(decision === "alternative"
      ? { decision, suggestion: "改为只读取目标文件，不做写入。" }
      : decision === "approve"
        ? { decision, confidence: 0.93 }
        : { decision }),
  };
}

function modelDouble(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  decision: "approve" | "deny" | "human" | "alternative",
  calls: ModelInvocationRequest[],
  readInput?: (payloadRef: string) => Promise<string>,
  omitConfidence = false,
) {
  return {
    listAvailable: async () => [reviewDescriptor()],
    select: async () => reviewDescriptor(),
    async *invoke(request: ModelInvocationRequest) {
      calls.push(request);
      if (readInput && request.inputRef) await readInput(request.inputRef);
      const outputRef = `review-model-output:${calls.length}:${request.invocationId}`;
      const response = reviewerResponse(request, decision);
      // biome-ignore lint/complexity/useLiteralKeys: the fixture response is index typed
      if (omitConfidence) delete response["confidence"];
      const output = await fixtureValue.protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: outputRef,
        dataClassification: "private",
        contentType: "application/json",
        plaintext: new TextEncoder().encode(JSON.stringify(response)),
        createdAt: NOW,
      });
      await fixtureValue.repository.payloadStore(OWNER_ID, AGENT_ID).put(output);
      yield {
        type: "model.output" as const,
        invocationId: request.invocationId,
        sequence: 1,
        payloadRef: output.ref,
        occurredAt: NOW,
      };
      yield {
        type: "model.completed" as const,
        invocationId: request.invocationId,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicros: 1,
        latencyMs: 1,
        occurredAt: NOW,
      };
    },
  };
}

describe("production automatic review composition", () => {
  it("composes no reviewer when review is unconfigured", async () => {
    const f = await fixture();
    const review = createProductionAutomaticReview({
      configuration: configuration(false),
      model: modelDouble(f, "approve", []),
      descriptors: [reviewDescriptor()],
      handles: f.handles,
      payloads: f.repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: f.protector,
      store: f.repository.automaticReviewStore(),
      executionLease: f.executionLease,
      clock: { now: () => NOW },
      ids: f.ids,
    });
    expect(review).toBeUndefined();
    expect(await f.repository.authorizationStore().listApprovals(OWNER_ID, AGENT_ID)).toEqual([]);
    expect(await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).toEqual([]);
  });

  it("reviews a delegated request through the configured model and commits one bounded Grant", async () => {
    const f = await fixture();
    const calls: ModelInvocationRequest[] = [];
    const inputs: string[] = [];
    await seedDelegation(f.repository, [actionIntentFingerprint(action())]);
    const review = createProductionAutomaticReview({
      configuration: configuration(true),
      model: modelDouble(f, "approve", calls, async (ref) => {
        const stored = await f.repository.payloadStore(OWNER_ID, AGENT_ID).get(ref);
        if (!stored) throw new Error("REVIEW_INPUT_MISSING");
        inputs.push(
          new TextDecoder().decode(
            await f.protector.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload: stored }),
          ),
        );
        return "fixture";
      }),
      descriptors: [reviewDescriptor()],
      handles: f.handles,
      payloads: f.repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: f.protector,
      store: f.repository.automaticReviewStore(),
      executionLease: f.executionLease,
      clock: { now: () => NOW },
      ids: f.ids,
    });
    if (!review) throw new Error("expected a composed reviewer");
    const result = await policy(f.repository.authorizationStore(), review).evaluate(action(), {
      uiAvailable: true,
      approvalExpiresAt: EXPIRES_AT,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ modelRef: REVIEW_MODEL });
    expect(inputs).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ modelRef: REVIEW_MODEL });
    expect(inputs).toHaveLength(1);
    // Only the frozen host summary is disclosed: identity, versions, the operation
    // and target kinds. Never file contents, local paths, credentials or recipients.
    const disclosedText = inputs[0];
    if (disclosedText === undefined) throw new Error("review input was not prepared");
    const disclosed = JSON.parse(disclosedText) as Record<string, unknown>;
    expect(disclosed).toMatchObject({
      schemaVersion: "automatic-review-input.v1",
      runId: RUN_ID,
      modelRef: REVIEW_MODEL,
      dataClassification: "private",
      action: {
        operation: "write",
        finalRisk: "HIGH",
        targetKinds: ["host", "input-digest", "tool"],
      },
    });
    expect(disclosedText).not.toContain("执行已授权的写入");
    expect(disclosedText).not.toContain("review-kek");
    expect(disclosedText).not.toContain("host-review-wiring");
    expect(disclosedText).not.toContain("digest-review-wiring");
    const call = calls[0];
    if (!call) throw new Error("review model was not called");
    const record = await f.repository.automaticReviewStore().get(call.invocationId);
    expect(record).toMatchObject({
      status: "finished",
      result: { decision: "approve", reasonCode: "WITHIN_DELEGATION" },
    });
    const grants = await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID);
    const grant = grants[0];
    if (!grant) throw new Error("automatic Grant was not committed");
    expect(grants).toHaveLength(1);
    expect(grant).toMatchObject({
      id: `automatic-grant:${call.invocationId}`,
      kind: "one_time",
      maxUses: 1,
      uses: 0,
      intentFingerprint: actionIntentFingerprint(action()),
      scope: { operations: ["write"], exactResourceRef: action().resourceRef },
    });
    const approvals = await f.repository.authorizationStore().listApprovals(OWNER_ID, AGENT_ID);
    expect(approvals).toMatchObject([
      {
        status: "approved",
        automaticReview: { reviewId: call.invocationId, modelRef: REVIEW_MODEL },
        policyAuthorization: { key: DELEGATION_KEY, revision: 1 },
      },
    ]);
    expect(result).toMatchObject({ decision: "ALLOW", basis: { type: "grant" } });
    // Review allocates no executable invocation; the Grant stays unconsumed here.
    expect(grant.uses).toBe(0);
  });

  it("routes an approval without calibrated confidence to human confirmation", async () => {
    const f = await fixture();
    const calls: ModelInvocationRequest[] = [];
    await seedDelegation(f.repository, [actionIntentFingerprint(action())]);
    const review = createProductionAutomaticReview({
      configuration: configuration(true),
      model: modelDouble(f, "approve", calls, undefined, true),
      descriptors: [reviewDescriptor()],
      handles: f.handles,
      payloads: f.repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: f.protector,
      store: f.repository.automaticReviewStore(),
      executionLease: f.executionLease,
      clock: { now: () => NOW },
      ids: f.ids,
    });
    if (!review) throw new Error("expected a composed reviewer");
    const result = await policy(f.repository.authorizationStore(), review).evaluate(action(), {
      uiAvailable: true,
      approvalExpiresAt: EXPIRES_AT,
    });
    expect(result).toMatchObject({ decision: "ASK" });
    expect(calls).toHaveLength(1);
    expect(await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).toEqual([]);
    const call = calls[0];
    if (!call) throw new Error("review model was not called");
    expect(await f.repository.automaticReviewStore().get(call.invocationId)).toMatchObject({
      result: { decision: "human", reasonCode: "LOW_CONFIDENCE" },
    });
  });

  it("turns a review alternative into a failed, non-authorizing result without a Grant", async () => {
    const f = await fixture();
    const calls: ModelInvocationRequest[] = [];
    await seedDelegation(f.repository, [actionIntentFingerprint(action())]);
    const review = createProductionAutomaticReview({
      configuration: configuration(true),
      model: modelDouble(f, "alternative", calls),
      descriptors: [reviewDescriptor()],
      handles: f.handles,
      payloads: f.repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: f.protector,
      store: f.repository.automaticReviewStore(),
      executionLease: f.executionLease,
      clock: { now: () => NOW },
      ids: f.ids,
    });
    if (!review) throw new Error("expected a composed reviewer");
    const result = await policy(f.repository.authorizationStore(), review).evaluate(action(), {
      uiAvailable: true,
      approvalExpiresAt: EXPIRES_AT,
    });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({
      decision: "DENY",
      reasonCode: "automatic_review_suggested_alternative",
      automaticReview: {
        outcome: "alternative",
        reasonCode: "WITHIN_DELEGATION",
        suggestionRef: expect.any(String),
      },
    });
    const call = calls[0];
    if (!call) throw new Error("review model was not called");
    const record = await f.repository.automaticReviewStore().get(call.invocationId);
    expect(record).toMatchObject({
      status: "finished",
      result: { decision: "alternative", approvalRequestId: null },
    });
    expect(await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).toEqual([]);
    expect(await f.repository.authorizationStore().listApprovals(OWNER_ID, AGENT_ID)).toEqual([]);
    // The untrusted suggestion stays in its protected payload, out of the denial object.
    expect(JSON.stringify(result)).not.toContain("改为只读取目标文件");
  });
});
