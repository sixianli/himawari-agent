import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ActionPolicyService,
  actionIntentFingerprint,
  claimFromRunExecutionLease,
  type GovernedActionIntent,
  type ModelDescriptor,
  ModelInvocationAdmissionService,
  type ProductConfiguration,
  type RunExecutionLeaseClaim,
  ThreadCommandService,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
} from "@himawari-agent/domain";
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
  TrustedModelProviderAdapter,
  TypeSafeJevTransport,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionAutomaticReview } from "../../apps/agent-service/src/production-automatic-review.js";

const OWNER_ID = createOwnerId("owner-jev-review");
const AGENT_ID = createAgentId("agent-jev-review");
const RUN_ID = createRunId("run-jev-review");
const THREAD_ID = createThreadId("thread-jev-review");
const DEPLOYMENT_ID = createDeploymentId("deployment-jev-review");
const LEASE_ID = createAuthorityLeaseId("lease-jev-review");
const EXECUTION_LEASE_ID = "execution-lease-jev-review";
const INPUT_REF = "payload-jev-review-input";
const DELEGATION_KEY = "automatic-review-delegation";
const REVIEW_MODEL = "review-model";
const WALL_NOW = Date.now();
const NOW = new Date(WALL_NOW + 30_000).toISOString();
const EXPIRES_AT = new Date(WALL_NOW + 300_000).toISOString();
const AUTHORITY = Object.freeze({
  product: Object.freeze({ deploymentId: DEPLOYMENT_ID, authorityEpoch: 1, fencingToken: 1 }),
  lease: Object.freeze({ leaseId: LEASE_ID, fencingToken: 1 }),
  consumerId: "jev-review-consumer",
});
const REVIEW_KEK = new Uint8Array(32).fill(9);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function action(): GovernedActionIntent {
  return {
    contractVersion: "authorization.v2",
    id: "coding:jev-review",
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    capabilityRef: "file:review",
    capabilityVersion: "1.0.0",
    operation: "write",
    resourceRef: "coding:jev-review",
    resourceRefs: ["coding:jev-review"],
    targets: [
      { type: "host", ref: "host-jev-review" },
      { type: "tool", ref: "write" },
      { type: "input-digest", ref: "digest-jev-review" },
    ],
    dataClassification: "private",
    sideEffect: "reversible",
    estimatedCostMicros: 0,
    frequency: { count: 1, intervalMs: null },
    idempotencyKey: "coding:jev-review" as GovernedActionIntent["idempotencyKey"],
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

const REVIEW_DESCRIPTOR = {
  ref: REVIEW_MODEL,
  provider: "typesafe",
  model: "jev-latest",
  version: "jev-1.13.0",
  routingClass: "specialist" as const,
  priority: 2,
  disclosure: "external_remote" as const,
  capabilities: ["text"],
  allowedDataClassifications: ["private" as const],
  secretRequirement: { secretRef: "provider-reviewer", secretVersion: "v1", purpose: "model-auth" },
};

/**
 * Test-local protected boundary over the real protector and payload store. It
 * mirrors the product model boundary's contract (protected text in, protected
 * ref out) without importing the pinned Pi runtime.
 */
function protectedBoundary(
  protector: EnvelopePayloadProtector,
  payloads: { put(payload: never): Promise<void>; get(ref: string): Promise<unknown> },
  ids: { next(scope: string): string },
) {
  return {
    async readText(ref: string): Promise<string> {
      const payload = (await payloads.get(ref)) as Parameters<
        EnvelopePayloadProtector["unprotect"]
      >[0]["payload"];
      if (!payload) throw new Error("REVIEW_PAYLOAD_MISSING");
      const bytes = await protector.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload });
      return new TextDecoder().decode(bytes);
    },
    async writeText(input: {
      readonly invocationId: string;
      readonly sequence: number;
      readonly dataClassification: "private";
      readonly content: string;
      readonly occurredAt: string;
    }): Promise<string> {
      const ref = ids.next("model-output");
      const payload = await protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref,
        dataClassification: input.dataClassification,
        contentType: "application/json",
        plaintext: new TextEncoder().encode(input.content),
        createdAt: input.occurredAt,
      });
      await payloads.put(payload as never);
      return ref;
    },
  };
}

function manifest() {
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
    scopes: { dataClassifications: ["private" as const], network: [], filesystem: [], secrets: [] },
    isolation: "worker" as const,
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy" as const, checkedAt: NOW },
    reviewedBy: null,
    reviewedAt: null,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: { kind: "pi_tool" as const, piBuiltinDefinition: "write" as const },
  };
}

function jevReply(answers: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers,
      usage: { input_tokens: 412, output_tokens: 31 },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function answer(choice: string, confidence = 0.95) {
  return { type: "choice", choice, probabilities: { [choice]: 1 }, confidence };
}

async function fixture(response: () => Response, budgetMicros = 10_000) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-jev-review-"));
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
       VALUES (?, ?, ?, ?, 'holder-jev-review', 1, 1, ?, '2999-12-31T23:59:59.999Z')`,
    )
    .run(LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, NOW);
  database.close();
  let repository = await SqliteProductStateRepository.open({
    stateRoot,
    minimumFreeBytes: 0,
    now: () => NOW,
  });
  cleanups.push(async () => {
    await repository.close();
    await rm(stateRoot, { recursive: true });
  });
  const protector = new EnvelopePayloadProtector({
    keys: new InMemoryDevelopmentSecretSource({ "review-kek@v1": REVIEW_KEK }),
    activeKey: { keyRef: "review-kek", kekVersion: "v1", dekVersion: "dek-v1" },
  });
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
  const commands = new ThreadCommandService({
    repository: repository.threadRepository(),
    clock: { now: () => NOW },
    authority: () => AUTHORITY.product,
  });
  const thread = await commands.create({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    idempotencyKey: "jev-review-thread",
    resultRef: INPUT_REF,
  });
  await commands.admitOwnerMessage({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: thread.thread.id,
    expectedThreadRevision: thread.thread.revision,
    sessionId: createSessionId("session-jev-review"),
    runId: RUN_ID,
    idempotencyKey: "jev-review-message",
    contentRef: INPUT_REF,
    sourceProofRef: "fixture-owner",
    dataClassification: "private",
    resultRef: INPUT_REF,
  });
  await repository.close();
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
         VALUES (?, ?, ?, 1, ?, ?, 1, 1, 'jev-review-consumer', ?, ?, ?, ?)`,
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
  repository = await SqliteProductStateRepository.open({
    stateRoot,
    minimumFreeBytes: 0,
    now: () => NOW,
  });
  const clock = { now: () => NOW };
  let identifier = 0;
  const ids = { next: (scope: string) => `${scope}:${++identifier}` };
  const dispatcher = repository.runDispatch(
    OWNER_ID,
    AGENT_ID,
    AUTHORITY.product,
    AUTHORITY.lease,
    AUTHORITY.consumerId,
  );
  const handles = new EphemeralSecretPort({
    ids: { next: (scope: string) => `${scope}:handle:${++identifier}` },
    clock,
  });
  const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
  const boundary = protectedBoundary(protector, payloads, ids);
  const calls: unknown[] = [];
  const transport = new TypeSafeJevTransport({
    secrets: { resolve: async (ref: string) => `${ref}-secret-value` },
    payloads: boundary,
    clock,
    pricingFor: () => ({ input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 }),
    fetch: (async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return response();
    }) as unknown as typeof globalThis.fetch,
  });
  const gate = new ModelInvocationAdmissionService({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    executionLease: await executionLease(),
    dispatch: dispatcher,
    invocations: repository.modelInvocationIdentityPort(
      OWNER_ID,
      AGENT_ID,
      AUTHORITY.product,
      AUTHORITY.lease,
    ),
    clock,
    registry: [
      {
        ...REVIEW_DESCRIPTOR,
        ...TypeSafeJevTransport.estimatedAdmissionCost({
          cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
      },
    ],
    limits: {
      accountCostMicros: budgetMicros,
      globalCostMicros: budgetMicros,
      perClassificationCostMicros: {
        public: 10_000,
        private: budgetMicros,
        sensitive: 0,
        restricted: 0,
      },
    },
  });
  const model = new TrustedModelProviderAdapter({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    descriptors: [REVIEW_DESCRIPTOR as ModelDescriptor],
    handles,
    secretSource: { resolve: async (ref: string) => `${ref}-secret-value` },
    transport,
    clock,
    admission: async () => gate,
    admissionCost: () =>
      TypeSafeJevTransport.estimatedAdmissionCost({
        cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
  });
  async function executionLease(): Promise<RunExecutionLeaseClaim> {
    const lease = await dispatcher.currentExecutionLease?.({ runId: RUN_ID, at: NOW });
    if (!lease) throw new Error("AUTOMATIC_REVIEW_LEASE_UNAVAILABLE");
    return claimFromRunExecutionLease(lease);
  }
  const review = createProductionAutomaticReview({
    configuration: {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      modelDescriptors: [
        {
          ...REVIEW_DESCRIPTOR,
          role: "specialist",
          api: "typesafe-systemone",
          secretRef: "provider-reviewer",
        },
      ],
      runPolicy: {
        automaticReview: {
          maximumWaitMs: 30_000,
          configurationVersion: "review-config:1",
          modelRef: REVIEW_MODEL,
          delegationKey: DELEGATION_KEY,
          confidenceThreshold: 0.8,
          maxOutputBytes: 32_768,
        },
      },
    } as unknown as ProductConfiguration,
    model,
    descriptors: [REVIEW_DESCRIPTOR as ModelDescriptor],
    handles,
    payloads,
    protector,
    store: repository.automaticReviewStore(),
    executionLease,
    clock,
    ids,
  });
  if (!review) throw new Error("REVIEW_CONFIGURATION_MISSING");
  const policy = new ActionPolicyService({
    store: repository.authorizationStore(),
    capabilities: { inspect: async () => ({ lifecycle: "active", manifest: manifest() }) },
    policy: { version: "review-policy:1", rules: [] },
    clock,
    ids,
    automaticReview: review,
  });
  await repository.commitStateAndEvents({
    command: {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      idempotencyKey: "seed-jev-review-delegation" as Parameters<
        SqliteProductStateRepository["commitStateAndEvents"]
      >[0]["command"]["idempotencyKey"],
      commandType: "fixture.seedReviewDelegation",
      commandFingerprint: "seed-jev-review-delegation",
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
        intentFingerprints: [actionIntentFingerprint(action())],
        expiresAt: EXPIRES_AT,
      },
    },
    events: [],
    resultRef: "fixture-jev-review-delegation",
    committedAt: NOW,
  });
  return { repository, policy, calls, review };
}

const options = { uiAvailable: true, approvalExpiresAt: EXPIRES_AT };

describe("production JEV automatic review", () => {
  it("approves through the real model boundary, budget and SQLite when confident", async () => {
    const f = await fixture(() =>
      jevReply({
        within_delegated_scope: answer("within", 0.97),
        decision: answer("approve", 0.93),
        reason_code: answer("WITHIN_DELEGATION"),
      }),
    );
    const result = await f.policy.evaluate(action(), options);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ url: "https://api.typesafe.ai/v1/systemone" });
    expect(result).toMatchObject({ decision: "ALLOW", basis: { type: "grant" } });
    expect(await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).toMatchObject([
      {
        kind: "one_time",
        maxUses: 1,
        uses: 0,
        intentFingerprint: actionIntentFingerprint(action()),
      },
    ]);
    expect(await f.repository.authorizationStore().listApprovals(OWNER_ID, AGENT_ID)).toMatchObject(
      [{ status: "approved", automaticReview: { modelRef: REVIEW_MODEL } }],
    );
    // The decision call settled a real budget allocation.
    const budget = await f.repository
      .modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY.product, AUTHORITY.lease)
      .read({ parent: { kind: "run", runId: RUN_ID }, limit: 10 });
    expect(budget?.allocations).toEqual([
      expect.objectContaining({ status: "settled", actualCostMicros: Math.ceil(412 * 0.042) }),
    ]);
  });

  it("routes a low-confidence approval to the human path without creating a Grant", async () => {
    const f = await fixture(() =>
      jevReply({
        within_delegated_scope: answer("within", 0.9),
        decision: answer("approve", 0.55),
        reason_code: answer("WITHIN_DELEGATION"),
      }),
    );
    const result = await f.policy.evaluate(action(), options);
    expect(result).toMatchObject({ decision: "ASK" });
    expect(await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).toEqual([]);
    expect(await f.repository.authorizationStore().listApprovals(OWNER_ID, AGENT_ID)).toMatchObject(
      [{ status: "pending" }],
    );
    const call = f.calls[0] as { body: { state: { reviewId: string } } };
    expect(await f.repository.automaticReviewStore().get(call.body.state.reviewId)).toMatchObject({
      result: { decision: "human", reasonCode: "LOW_CONFIDENCE", confidence: 0.55 },
    });
  });

  it("keeps budget unresolved and creates no Grant when provider usage is missing", async () => {
    const f = await fixture(
      () =>
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              within_delegated_scope: answer("within"),
              decision: answer("approve", 0.99),
              reason_code: answer("WITHIN_DELEGATION"),
            },
          }),
          { status: 200 },
        ),
    );
    const result = await f.policy.evaluate(action(), options);
    expect(result).toMatchObject({ decision: "ASK" });
    expect(f.calls).toHaveLength(1);
    expect(await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).toEqual([]);
    const budget = await f.repository
      .modelBudgetPort(OWNER_ID, AGENT_ID, AUTHORITY.product, AUTHORITY.lease)
      .read({ parent: { kind: "run", runId: RUN_ID }, limit: 10 });
    expect(budget?.allocations).toEqual([
      expect.objectContaining({ status: "unknown", actualCostMicros: null }),
    ]);
  });

  it("does not call TypeSafe or issue a Grant when the Run has no model budget", async () => {
    const f = await fixture(
      () =>
        jevReply({
          within_delegated_scope: answer("within"),
          decision: answer("approve", 0.99),
          reason_code: answer("WITHIN_DELEGATION"),
        }),
      0,
    );
    const result = await f.policy.evaluate(action(), options);
    expect(result).toMatchObject({ decision: "ASK" });
    expect(f.calls).toEqual([]);
    expect(await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).toEqual([]);
  });

  it("treats an out-of-delegation answer as human review without a second call", async () => {
    const f = await fixture(() =>
      jevReply({
        within_delegated_scope: answer("outside", 0.99),
        decision: answer("approve", 0.99),
        reason_code: answer("WITHIN_DELEGATION"),
      }),
    );
    const result = await f.policy.evaluate(action(), options);
    expect(result).toMatchObject({ decision: "ASK" });
    expect(await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });
});
