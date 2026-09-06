import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  MemoryContentPort,
  MemoryProviderHit,
  MemoryProviderProjectionPort,
  ProductMemoryRecord,
} from "@himawari-agent/application";
import { DurableMemoryService } from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-memory-integration");
const AGENT_ID = createAgentId("agent-memory-integration");
const THREAD_ID = createThreadId("thread-memory-integration");
const GENERATION_ID = createMemoryGenerationId("generation-memory-integration");
const T0 = "2026-08-27T00:00:00.000Z";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

class MapMemoryContent implements MemoryContentPort {
  private readonly values = new Map<string, string>();

  set(ref: string, value: string): void {
    this.values.set(ref, value);
  }

  async readText(ref: string): Promise<string> {
    const value = this.values.get(ref);
    if (value === undefined) throw new Error(`Missing content ${ref}`);
    return value;
  }
}

class DeterministicProjectionProvider implements MemoryProviderProjectionPort {
  readonly records = new Map<
    string,
    { readonly memory: ProductMemoryRecord; readonly content: string }
  >();
  readonly upsertedRevisions: number[] = [];
  readonly extraHits: MemoryProviderHit[] = [];
  failNextUpsert = false;
  failNextDelete = false;
  clearCount = 0;

  async upsert(input: { readonly memory: ProductMemoryRecord; readonly content: string }) {
    if (this.failNextUpsert) {
      this.failNextUpsert = false;
      throw new Error("injected projection failure");
    }
    const providerRecordId = input.memory.providerRecordId ?? `provider-${input.memory.id}`;
    this.records.set(providerRecordId, input);
    this.upsertedRevisions.push(input.memory.revision);
    return providerRecordId;
  }

  async delete(providerRecordId: string) {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("injected cleanup failure");
    }
    this.records.delete(providerRecordId);
  }

  async search(): Promise<readonly MemoryProviderHit[]> {
    return [
      ...[...this.records.entries()].map(([providerRecordId, { memory }]) => ({
        providerRecordId,
        productMemoryId: memory.id,
        score: 0.9,
      })),
      ...this.extraHits,
    ];
  }

  async clearScope() {
    this.clearCount += 1;
    this.records.clear();
  }
}

async function seedRepository(databasePath: string): Promise<void> {
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'open', ?, ?)`,
    )
    .run(THREAD_ID, OWNER_ID, AGENT_ID, T0, T0);
  const insertPayload = database.prepare(
    `INSERT INTO payloads (
      ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
      encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
    ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
      'active', ?, 'text/plain')`,
  );
  for (const ref of [
    "payload-memory-v1",
    "payload-memory-v2",
    "payload-memory-v3",
    "payload-query",
  ]) {
    insertPayload.run(ref, OWNER_ID, AGENT_ID, `sha256:${ref}`, T0);
  }
  database
    .prepare(
      `INSERT INTO thread_checkpoint_jobs (
        id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
        policy_version, status, attempt_count, requested_at
      ) VALUES ('checkpoint-memory-integration', ?, ?, ?, ?, 1, 1,
        'memory-policy-v1', 'completed', 1, ?)`,
    )
    .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, T0);
  database
    .prepare(
      `INSERT INTO memory_generations (
        id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
        model_descriptor_ref, policy_version, output_ref
      ) VALUES (?, 'checkpoint-memory-integration', ?, ?, ?, 'completed',
        'model-memory-fixture', 'memory-policy-v1', NULL)`,
    )
    .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
  database.close();
}

async function createRepository() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-memory-projection-"));
  temporaryDirectories.push(stateRoot);
  await seedRepository(path.join(stateRoot, "product.sqlite"));
  return {
    stateRoot,
    repository: await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    }),
  };
}

function service(input: {
  repository: SqliteProductStateRepository;
  provider: DeterministicProjectionProvider;
  content: MapMemoryContent;
  now: () => string;
}) {
  return new DurableMemoryService({
    state: input.repository.productMemoryState(),
    jobs: input.repository.memoryProjectionJobs(),
    provider: input.provider,
    content: input.content,
    workerId: "memory-worker-integration",
    now: input.now,
    maximumProjectionAttempts: 3,
    projectionLeaseMs: 10_000,
  });
}

function createProposal(memoryId = createMemoryId("memory-integration-01")) {
  return {
    decision: "create" as const,
    memory: {
      id: memoryId,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      contentRef: "payload-memory-v1",
      dataClassification: "private" as const,
      sourceThreadId: THREAD_ID,
      sourceRefs: ["message-memory-01"],
      inference: false,
      confidencePermille: 1000,
      policyVersion: "memory-policy-v1",
    },
  };
}

describe("durable product Memory projection", () => {
  it.each(["create", "update", "correct", "archive", "delete"] as const)(
    "rolls back %s when projection insertion fails and permits retry",
    async (operation) => {
      const resource = await createRepository();
      const memory = service({
        repository: resource.repository,
        provider: new DeterministicProjectionProvider(),
        content: new MapMemoryContent(),
        now: () => T0,
      });
      const proposal = createProposal();
      const before =
        operation === "create" ? undefined : await memory.applyProposal(proposal, GENERATION_ID);
      const database = openQualifiedDatabase(path.join(resource.stateRoot, "product.sqlite"));
      try {
        database.exec(`CREATE TRIGGER fail_projection BEFORE INSERT ON memory_projection_jobs
          BEGIN SELECT RAISE(ABORT, 'fixture projection insertion failure'); END`);
        const mutate = () => {
          switch (operation) {
            case "create":
              return memory.applyProposal(proposal, GENERATION_ID);
            case "update":
              return memory.applyProposal(
                {
                  decision: "update",
                  memoryId: proposal.memory.id,
                  contentRef: "payload-memory-v2",
                  sourceRefs: ["message-update"],
                  dataClassification: "private",
                  inference: false,
                  confidencePermille: 1000,
                  policyVersion: "memory-policy-v1",
                },
                GENERATION_ID,
              );
            case "correct":
              return memory.correct({
                memoryId: proposal.memory.id,
                contentRef: "payload-memory-v2",
                sourceRef: "message-correction",
                generationId: GENERATION_ID,
              });
            case "archive":
              return memory.archive(proposal.memory.id, GENERATION_ID);
            case "delete":
              return memory.delete(proposal.memory.id, GENERATION_ID);
          }
        };
        await expect(mutate()).rejects.toThrow();
        expect(await resource.repository.productMemoryState().read(proposal.memory.id)).toEqual(
          before,
        );
        expect(
          await resource.repository.memoryProjectionJobs().listByMemory(proposal.memory.id),
        ).toHaveLength(before ? 1 : 0);
        database.exec("DROP TRIGGER fail_projection");
        const saved = await mutate();
        expect(saved.revision).toBe(before ? 2 : 1);
        expect(
          await resource.repository.memoryProjectionJobs().listByMemory(saved.id),
        ).toHaveLength(before ? 2 : 1);
      } finally {
        database.close();
        await resource.repository.close();
      }
    },
  );

  it("repairs legacy missing create and deletion jobs on replay without changing revision", async () => {
    const resource = await createRepository();
    const provider = new DeterministicProjectionProvider();
    const content = new MapMemoryContent();
    content.set("payload-memory-v1", "memory fixture");
    const memory = service({ repository: resource.repository, provider, content, now: () => T0 });
    const database = openQualifiedDatabase(path.join(resource.stateRoot, "product.sqlite"));
    try {
      const created = await memory.applyProposal(createProposal(), GENERATION_ID);
      database.prepare("DELETE FROM memory_projection_jobs WHERE memory_id = ?").run(created.id);
      expect(await memory.applyProposal(createProposal(), GENERATION_ID)).toEqual(created);
      expect(
        await resource.repository.memoryProjectionJobs().listByMemory(created.id),
      ).toHaveLength(1);
      await memory.runProjectionBatch(10);
      const pending = await memory.delete(created.id, GENERATION_ID);
      database
        .prepare("DELETE FROM memory_projection_jobs WHERE memory_id = ? AND operation = 'delete'")
        .run(created.id);
      expect(await memory.delete(created.id, GENERATION_ID)).toEqual(pending);
      await memory.runProjectionBatch(10);
      expect((await resource.repository.productMemoryState().read(created.id))?.status).toBe(
        "deleted_verified",
      );
      expect(provider.records.size).toBe(0);
    } finally {
      database.close();
      await resource.repository.close();
    }
  });

  it("commits independently, deduplicates proposals and skips stale projection revisions", async () => {
    const resource = await createRepository();
    const provider = new DeterministicProjectionProvider();
    const content = new MapMemoryContent();
    content.set("payload-memory-v1", "偏好安静的餐厅");
    content.set("payload-memory-v2", "偏好安静且禁烟的餐厅");
    content.set("payload-query", "安静餐厅");
    const now = T0;
    const memory = service({ repository: resource.repository, provider, content, now: () => now });

    const created = await memory.applyProposal(createProposal(), GENERATION_ID);
    expect(provider.records.size).toBe(0);
    expect(await memory.applyProposal(createProposal(), GENERATION_ID)).toEqual(created);
    expect(await resource.repository.memoryProjectionJobs().listByMemory(created.id)).toHaveLength(
      1,
    );

    await memory.applyProposal(
      {
        decision: "update",
        memoryId: created.id,
        contentRef: "payload-memory-v2",
        sourceRefs: ["message-memory-02"],
        dataClassification: "private",
        inference: false,
        confidencePermille: 1000,
        policyVersion: "memory-policy-v1",
      },
      GENERATION_ID,
    );
    expect(await memory.runProjectionBatch(10)).toMatchObject([
      { memoryRevision: 1, status: "completed", providerRecordId: null },
      {
        memoryRevision: 2,
        status: "completed",
        providerRecordId: "provider-memory-integration-01",
      },
    ]);
    expect(provider.upsertedRevisions).toEqual([2]);
    expect(await resource.repository.productMemoryState().read(created.id)).toMatchObject({
      revision: 2,
      providerRecordId: "provider-memory-integration-01",
      sourceRefs: ["message-memory-01", "message-memory-02"],
    });

    provider.extraHits.push({
      providerRecordId: "provider-stale",
      productMemoryId: createMemoryId("memory-stale-provider-only"),
      score: 1,
    });
    expect(
      await memory.search({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        queryRef: "payload-query",
        policy: { allowedClassifications: ["private"], limit: 5 },
      }),
    ).toMatchObject([
      {
        providerRecordId: "provider-memory-integration-01",
        memory: { id: "memory-integration-01", status: "active" },
      },
    ]);
    expect((await resource.repository.productMemoryState().read(created.id))?.lastUsedAt).toBe(T0);

    await resource.repository.close();
  });

  it("recovers retries and restart, keeps deletion immediately unsearchable, and rebuilds equivalently", async () => {
    const resource = await createRepository();
    const provider = new DeterministicProjectionProvider();
    const content = new MapMemoryContent();
    content.set("payload-memory-v1", "长期项目为 Himawari");
    content.set("payload-memory-v3", "长期项目为 Himawari Agent");
    content.set("payload-query", "Himawari");
    let now = T0;
    let memory = service({ repository: resource.repository, provider, content, now: () => now });
    const memoryId = createMemoryId("memory-recovery-01");

    await memory.applyProposal(createProposal(memoryId), GENERATION_ID);
    provider.failNextUpsert = true;
    expect(await memory.runProjectionBatch(10)).toMatchObject([
      { status: "retry_wait", attemptCount: 1, errorCode: "MEMORY_PROJECTION_FAILED" },
    ]);
    await resource.repository.close();

    now = "2026-08-27T00:00:03.000Z";
    const reopened = await SqliteProductStateRepository.open({
      stateRoot: resource.stateRoot,
      minimumFreeBytes: 0,
      now: () => now,
    });
    memory = service({ repository: reopened, provider, content, now: () => now });
    expect(await memory.runProjectionBatch(10)).toMatchObject([
      { status: "completed", attemptCount: 2, providerRecordId: "provider-memory-recovery-01" },
    ]);

    await memory.correct({
      memoryId,
      contentRef: "payload-memory-v3",
      sourceRef: "message-correction-01",
      generationId: GENERATION_ID,
    });
    expect(await memory.runProjectionBatch(10)).toMatchObject([{ status: "completed" }]);
    expect(provider.records.get("provider-memory-recovery-01")?.content).toBe(
      "长期项目为 Himawari Agent",
    );

    provider.records.clear();
    expect(await memory.rebuild(OWNER_ID, AGENT_ID, GENERATION_ID)).toMatchObject([
      { status: "completed", memoryRevision: 2 },
    ]);
    expect(provider.clearCount).toBe(1);
    expect(provider.records.get("provider-memory-recovery-01")?.memory.id).toBe(memoryId);

    await memory.delete(memoryId, GENERATION_ID);
    provider.failNextDelete = true;
    expect(
      await memory.search({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        queryRef: "payload-query",
        policy: { allowedClassifications: ["private"], limit: 5 },
      }),
    ).toEqual([]);
    expect(await memory.runProjectionBatch(10)).toMatchObject([{ status: "retry_wait" }]);
    expect(await reopened.productMemoryState().read(memoryId)).toMatchObject({
      status: "deletion_pending",
      providerRecordId: "provider-memory-recovery-01",
    });

    now = "2026-08-27T00:00:10.000Z";
    expect(await memory.runProjectionBatch(10)).toMatchObject([{ status: "completed" }]);
    expect(await reopened.productMemoryState().read(memoryId)).toMatchObject({
      status: "deleted_verified",
      providerRecordId: null,
    });
    expect(provider.records.size).toBe(0);

    await reopened.close();
  });
});

describe("Memory projection unified model budget", () => {
  it("requires the current projection claim and preserves unknown spend across retries", async () => {
    const { stateRoot, repository } = await createRepository();
    try {
      const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
      database
        .prepare(`INSERT INTO deployments (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
        VALUES ('memory-deployment', ?, ?, 1, 'active', 1, 1)`)
        .run(OWNER_ID, AGENT_ID);
      database
        .prepare(`INSERT INTO authority_leases (id, owner_id, agent_id, deployment_id, holder_id,
        authority_epoch, fencing_token, acquired_at, expires_at)
        VALUES ('memory-authority', ?, ?, 'memory-deployment', 'memory-host', 1, 1, ?, '2999-01-01T00:00:00.000Z')`)
        .run(OWNER_ID, AGENT_ID, T0);
      database.close();
      const provider = new DeterministicProjectionProvider();
      const content = new MapMemoryContent();
      const memory = service({ repository, provider, content, now: () => T0 });
      await memory.applyProposal(createProposal(), GENERATION_ID);
      const jobs = repository.memoryProjectionJobs();
      const pending = await jobs.listPending(T0, 10);
      const job = pending[0];
      expect(job).toBeDefined();
      if (!job) throw new Error("PROJECTION_MISSING");
      const claimed = await jobs.claim({
        jobId: job.id,
        claimedBy: "budget-worker",
        claimedAt: T0,
        expiresAt: "2026-08-27T00:00:10.000Z",
      });
      if (!claimed) throw new Error("CLAIM_MISSING");
      const budget = repository.modelBudgetPort(
        OWNER_ID,
        AGENT_ID,
        {
          deploymentId: createDeploymentId("memory-deployment"),
          authorityEpoch: 1,
          fencingToken: 1,
        },
        { leaseId: createAuthorityLeaseId("memory-authority"), fencingToken: 1 },
      );
      const parent = {
        kind: "memory-projection" as const,
        jobId: claimed.id,
        claimedBy: "budget-worker",
        attemptCount: claimed.attemptCount,
      };
      const input = {
        parent,
        operationKey: "embedding:one",
        modelRef: "embedding",
        dataClassification: "private" as const,
        estimatedCostMicros: 60,
        reservedAt: T0,
        limits: {
          accountCostMicros: 100,
          globalCostMicros: 100,
          perClassificationCostMicros: {
            public: 100,
            private: 100,
            sensitive: 100,
            restricted: 100,
          },
        },
      };
      await expect(
        budget.reserve({ ...input, parent: { ...parent, claimedBy: "stale-worker" } }),
      ).rejects.toThrow("lease is not held");
      await expect(budget.reserve({ ...input, dataClassification: "public" })).rejects.toThrow(
        "classification mismatch",
      );
      expect((await budget.reserve(input)).replayed).toBe(false);
      await expect(budget.reserve({ ...input, operationKey: "embedding:two" })).rejects.toThrow(
        "budget limit",
      );
      await expect(
        budget.markStarted({
          parent: { ...parent, attemptCount: parent.attemptCount + 1 },
          operationKey: input.operationKey,
          startedAt: T0,
        }),
      ).rejects.toThrow("lease is not held");
      await budget.markStarted({ parent, operationKey: input.operationKey, startedAt: T0 });
      await budget.markUnknown({
        parent,
        operationKey: input.operationKey,
        observedAt: T0,
        reasonCode: "transport_unresolved",
      });
      expect((await budget.reserve(input)).allocation.status).toBe("unknown");
      await expect(budget.reserve({ ...input, operationKey: "embedding:retry" })).rejects.toThrow(
        "not available",
      );
      const snapshot = await budget.read({ parent, limit: 10 });
      expect(snapshot?.account).toMatchObject({
        reservedCostMicros: 60,
        spentCostMicros: 0,
        status: "reconcile_required",
      });
      await budget.settle({
        parent,
        operationKey: input.operationKey,
        actualCostMicros: 20,
        settledAt: T0,
      });
      expect((await budget.read({ parent, limit: 10 }))?.account).toMatchObject({
        reservedCostMicros: 0,
        spentCostMicros: 20,
        status: "active",
      });
    } finally {
      await repository.close();
    }
  });
});
