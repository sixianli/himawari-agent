import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MemoryContentPort, ProductMemoryAttributes } from "@himawari-agent/application";
import { DurableMemoryService } from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createThreadId,
  type MemoryId,
} from "@himawari-agent/domain";
import { type Embedder, HybridMemoryProvider, indexTerms } from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-memory-engine");
const AGENT_ID = createAgentId("agent-memory-engine");
const THREAD_ID = createThreadId("thread-memory-engine");
const GENERATION_ID = createMemoryGenerationId("generation-memory-engine");
const T0 = "2026-10-25T00:00:00.000Z";
const DIMENSIONS = 16;

class TermEmbedder implements Embedder {
  embedQuery(query: string): Promise<Float32Array> {
    return this.embed(query);
  }

  embedDocument(text: string): Promise<Float32Array> {
    return this.embed(text);
  }

  readonly model = "fixture-term-embedding";
  readonly dimensions = DIMENSIONS;
  calls = 0;
  fail = false;

  async embed(text: string): Promise<Float32Array> {
    this.calls += 1;
    if (this.fail) throw new Error("fixture embedding outage");
    const vector = new Float32Array(DIMENSIONS);
    for (const term of indexTerms(text)) {
      let hash = 0;
      for (const character of term) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
      vector[hash % DIMENSIONS] = (vector[hash % DIMENSIONS] ?? 0) + 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  }
}

class MapMemoryContent implements MemoryContentPort {
  readonly values = new Map<string, string>();

  async readText(ref: string): Promise<string> {
    const value = this.values.get(ref);
    if (value === undefined) throw new Error(`Missing content ${ref}`);
    return value;
  }
}

const MEMORIES: ReadonlyArray<{
  readonly id: string;
  readonly text: string;
  readonly classification: "private" | "sensitive";
  readonly attributes: Partial<ProductMemoryAttributes>;
}> = [
  {
    id: "memory-engine-daughter",
    text: "主人的女儿叫小葵，今年六岁",
    classification: "private",
    attributes: { category: "relationship", importancePermille: 900, entities: ["小葵"] },
  },
  {
    id: "memory-engine-coffee",
    text: "主人早上只喝美式咖啡，不加糖",
    classification: "private",
    attributes: { category: "preference", importancePermille: 600, entities: [] },
  },
  {
    id: "memory-engine-hermes",
    text: "Hermes 是主人的测试机，生产机在 Contabo",
    classification: "private",
    attributes: { category: "project", importancePermille: 700, entities: ["Hermes", "Contabo"] },
  },
  {
    id: "memory-engine-expired",
    text: "主人这周在东京出差",
    classification: "private",
    attributes: {
      category: "event",
      importancePermille: 500,
      entities: ["东京"],
      validFrom: "2026-10-01",
      validTo: "2026-10-07",
    },
  },
  {
    id: "memory-engine-allergy",
    text: "主人对青霉素过敏",
    classification: "sensitive",
    attributes: { category: "health", importancePermille: 950, entities: ["青霉素"] },
  },
];

describe.each(["worker", "direct"] as const)("memory engine index through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-memory-engine-"));
    directories.push(stateRoot);
    const databasePath = path.join(stateRoot, "product.sqlite");
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
      ) VALUES (?, ?, ?, ?, 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
        'active', ?, 'text/plain')`,
    );
    for (const memory of MEMORIES)
      insertPayload.run(
        `payload-${memory.id}`,
        OWNER_ID,
        AGENT_ID,
        memory.classification,
        `sha256:${memory.id}`,
        T0,
      );
    for (const ref of [
      "payload-query",
      "payload-memory-engine-daughter-v2",
      "payload-memory-engine-coffee-v2",
    ])
      insertPayload.run(ref, OWNER_ID, AGENT_ID, "private", `sha256:${ref}`, T0);
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (
          id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
          policy_version, status, attempt_count, requested_at
        ) VALUES ('checkpoint-memory-engine', ?, ?, ?, ?, 1, 1,
          'memory-policy-v1', 'completed', 1, ?)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, T0);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES (?, 'checkpoint-memory-engine', ?, ?, ?, 'completed',
          'model-memory-fixture', 'memory-policy-v1', NULL)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    const content = new MapMemoryContent();
    for (const memory of MEMORIES) content.values.set(`payload-${memory.id}`, memory.text);
    const embedder = new TermEmbedder();
    const vectorFailures: unknown[] = [];
    const provider = new HybridMemoryProvider({
      index: repository.memoryIndex(),
      embedder,
      embeddableClassifications: ["public", "private"],
      now: () => T0,
      onVectorFailure: (error) => vectorFailures.push(error),
    });
    const service = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider,
      content,
      workerId: "memory-engine-worker",
      now: () => T0,
      maximumProjectionAttempts: 3,
      projectionLeaseMs: 10_000,
    });
    for (const memory of MEMORIES)
      await service.applyProposal(
        {
          decision: "create",
          memory: {
            id: createMemoryId(memory.id),
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            contentRef: `payload-${memory.id}`,
            dataClassification: memory.classification,
            sourceThreadId: THREAD_ID,
            sourceRefs: [`message-${memory.id}`],
            inference: false,
            confidencePermille: 1000,
            policyVersion: "memory-policy-v1",
            attributes: {
              category: "other",
              importancePermille: 500,
              entities: [],
              validFrom: null,
              validTo: null,
              supersededBy: null,
              evidenceVerified: true,
              ...memory.attributes,
            },
          },
        },
        GENERATION_ID,
      );
    await service.runProjectionBatch(20);
    return { stateRoot, repository, content, embedder, vectorFailures, service };
  }

  async function search(
    resource: Awaited<ReturnType<typeof fixture>>,
    query: string,
    classifications: ReadonlyArray<"public" | "private" | "sensitive"> = ["public", "private"],
    includeHistory?: boolean,
  ): Promise<readonly MemoryId[]> {
    resource.content.values.set("payload-query", query);
    const found = await resource.service.search({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      queryRef: "payload-query",
      policy: { limit: 3, allowedClassifications: classifications },
      ...(includeHistory === undefined ? {} : { scope: { includeHistory, from: null, to: null } }),
    });
    return found.map(({ memory }) => memory.id);
  }

  it("stores attributes and entities and indexes every active memory", async () => {
    const resource = await fixture();
    try {
      const daughter = await resource.repository
        .productMemoryState()
        .read(createMemoryId("memory-engine-daughter"));
      expect(daughter?.attributes).toEqual({
        category: "relationship",
        importancePermille: 900,
        entities: ["小葵"],
        validFrom: null,
        validTo: null,
        supersededBy: null,
        evidenceVerified: true,
      });
      expect(daughter?.providerRecordId).toBe("memory-index:memory-engine-daughter");
      expect(
        await resource.repository.memoryIndex().listUnindexed({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          model: resource.embedder.model,
          dimensions: DIMENSIONS,
          embeddableClassifications: ["public", "private"],
          afterMemoryId: null,
          limit: 50,
        }),
      ).toEqual([]);
      const database = openQualifiedDatabase(path.join(resource.stateRoot, "product.sqlite"));
      try {
        expect(
          database
            .prepare(
              "SELECT memory_id, embedding_model FROM memory_search_index ORDER BY memory_id",
            )
            .all(),
        ).toEqual([
          { memory_id: "memory-engine-allergy", embedding_model: null },
          { memory_id: "memory-engine-coffee", embedding_model: "fixture-term-embedding" },
          { memory_id: "memory-engine-daughter", embedding_model: "fixture-term-embedding" },
          { memory_id: "memory-engine-expired", embedding_model: "fixture-term-embedding" },
          { memory_id: "memory-engine-hermes", embedding_model: "fixture-term-embedding" },
        ]);
        expect(
          database
            .prepare("SELECT count(*) FROM memory_search_terms WHERE memory_search_terms MATCH ?")
            .pluck()
            .get('"青霉素"'),
        ).toBe(1);
      } finally {
        database.close();
      }
    } finally {
      await resource.repository.close();
    }
  });

  it("[RULE-memory-visible] recalls by meaning, keyword and entity, skips expired facts and finds an unembedded sensitive fact by its words only when sensitive is allowed", async () => {
    const resource = await fixture();
    try {
      expect((await search(resource, "我女儿今年多大了？"))[0]).toBe("memory-engine-daughter");
      expect((await search(resource, "小葵喜欢什么"))[0]).toBe("memory-engine-daughter");
      expect((await search(resource, "hermes 在哪"))[0]).toBe("memory-engine-hermes");
      expect(await search(resource, "主人在东京吗")).not.toContain("memory-engine-expired");
      expect(await search(resource, "青霉素")).not.toContain("memory-engine-allergy");
      expect(await search(resource, "青霉素", ["public", "private", "sensitive"])).toContain(
        "memory-engine-allergy",
      );
    } finally {
      await resource.repository.close();
    }
  });

  it("gives keyword and entity candidates the same similarity the vector path computes, even when the vector path filtered them out", async () => {
    const resource = await fixture();
    try {
      const index = resource.repository.memoryIndex();
      const query = "美式咖啡 小葵";
      const embedding = {
        model: resource.embedder.model,
        dimensions: DIMENSIONS,
        vector: await resource.embedder.embed(query),
      };
      const base = {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        embedding,
        terms: ["美式", "咖啡"],
        queryText: query,
        limit: 50,
        now: T0,
      };
      const open = await index.search({ ...base, minimumSimilarity: 0 });
      const strict = await index.search({ ...base, minimumSimilarity: 0.999 });
      const vectorSimilarity = new Map(
        open.vector.map(({ memoryId, signal }) => [memoryId, signal]),
      );
      const others = [...strict.lexical, ...strict.entity];
      expect(strict.vector).toEqual([]);
      expect(others.map(({ memoryId }) => memoryId).sort()).toEqual([
        "memory-engine-coffee",
        "memory-engine-daughter",
      ]);
      for (const candidate of others)
        expect(candidate.similarity).toBeCloseTo(vectorSimilarity.get(candidate.memoryId) ?? -1, 5);
      const unembedded = await index.search({
        ...base,
        terms: ["青霉素"],
        queryText: "青霉素",
        minimumSimilarity: 0,
      });
      expect(unembedded.lexical.map(({ memoryId }) => memoryId)).toEqual(["memory-engine-allergy"]);
      expect(unembedded.lexical[0]?.similarity).toBeUndefined();
      const otherModel = await index.search({
        ...base,
        embedding: { ...embedding, model: `${embedding.model}-next` },
        minimumSimilarity: 0,
      });
      expect(otherModel.vector).toEqual([]);
      expect(otherModel.lexical.length).toBeGreaterThan(0);
      for (const candidate of otherModel.lexical) expect(candidate.similarity).toBeUndefined();
    } finally {
      await resource.repository.close();
    }
  });

  it("falls back to keyword and entity recall when embeddings fail", async () => {
    const resource = await fixture();
    try {
      resource.embedder.fail = true;
      expect((await search(resource, "美式咖啡"))[0]).toBe("memory-engine-coffee");
      expect(resource.vectorFailures).toHaveLength(1);
    } finally {
      await resource.repository.close();
    }
  });

  it("reindexes an update, removes deleted memories and requeues missing vectors", async () => {
    const resource = await fixture();
    try {
      resource.content.values.set("payload-memory-engine-daughter-v2", "主人的女儿小葵今年七岁");
      await resource.service.applyProposal(
        {
          decision: "update",
          memoryId: createMemoryId("memory-engine-daughter"),
          contentRef: "payload-memory-engine-daughter-v2",
          sourceRefs: ["message-update"],
          dataClassification: "private",
          inference: false,
          confidencePermille: 1000,
          policyVersion: "memory-policy-v1",
        },
        GENERATION_ID,
      );
      expect(await search(resource, "七岁")).not.toContain("memory-engine-daughter");
      await resource.service.runProjectionBatch(20);
      expect((await search(resource, "七岁"))[0]).toBe("memory-engine-daughter");
      await resource.service.delete(createMemoryId("memory-engine-coffee"), GENERATION_ID);
      await resource.service.runProjectionBatch(20);
      expect(await search(resource, "美式咖啡")).not.toContain("memory-engine-coffee");
      const database = openQualifiedDatabase(path.join(resource.stateRoot, "product.sqlite"));
      try {
        expect(
          database
            .prepare("SELECT count(*) FROM memory_search_index WHERE memory_id = ?")
            .pluck()
            .get("memory-engine-coffee"),
        ).toBe(0);
        database
          .prepare(
            "UPDATE memory_search_index SET embedding_model = NULL, embedding_dimensions = NULL, embedding = NULL WHERE memory_id = ?",
          )
          .run("memory-engine-hermes");
      } finally {
        database.close();
      }
      const index = resource.repository.memoryIndex();
      const missing = await index.listUnindexed({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        model: resource.embedder.model,
        dimensions: DIMENSIONS,
        embeddableClassifications: ["public", "private"],
        afterMemoryId: null,
        limit: 50,
      });
      expect(missing).toEqual([createMemoryId("memory-engine-hermes")]);
      expect(await resource.service.requeueProjection(missing)).toBe(1);
      await resource.service.runProjectionBatch(20);
      expect(
        await index.listUnindexed({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          model: resource.embedder.model,
          dimensions: DIMENSIONS,
          embeddableClassifications: ["public", "private"],
          afterMemoryId: null,
          limit: 50,
        }),
      ).toEqual([]);
    } finally {
      await resource.repository.close();
    }
  });
  it("keeps a superseded fact as history, recalls it only when asked about the past and restores it", async () => {
    const resource = await fixture();
    try {
      resource.content.values.set("payload-memory-engine-coffee-v2", "主人现在早上改喝燕麦拿铁");
      const replacement = await resource.service.applyProposal(
        {
          decision: "create",
          memory: {
            id: createMemoryId("memory-engine-coffee-v2"),
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            contentRef: "payload-memory-engine-coffee-v2",
            dataClassification: "private",
            sourceThreadId: THREAD_ID,
            sourceRefs: ["message-coffee-v2"],
            inference: false,
            confidencePermille: 1000,
            policyVersion: "memory-policy-v1",
            attributes: {
              category: "preference",
              importancePermille: 600,
              entities: [],
              validFrom: null,
              validTo: null,
              supersededBy: null,
              evidenceVerified: true,
            },
          },
          supersedes: createMemoryId("memory-engine-coffee"),
        },
        GENERATION_ID,
      );
      await resource.service.runProjectionBatch(20);
      const old = await resource.repository
        .productMemoryState()
        .read(createMemoryId("memory-engine-coffee"));
      expect(old?.attributes).toMatchObject({ supersededBy: replacement.id, validTo: T0 });
      expect(old?.recordedAt).toBe(T0);
      expect(await search(resource, "我早上喝什么咖啡")).toEqual(
        expect.arrayContaining([replacement.id]),
      );
      expect(await search(resource, "我早上喝什么咖啡")).not.toContain("memory-engine-coffee");
      expect(await search(resource, "我以前早上喝什么咖啡", ["public", "private"], true)).toEqual(
        expect.arrayContaining([replacement.id, "memory-engine-coffee"]),
      );
      expect(await search(resource, "我以前早上喝什么咖啡")).not.toContain("memory-engine-coffee");
      await resource.service.restore(createMemoryId("memory-engine-coffee"), GENERATION_ID);
      await resource.service.runProjectionBatch(20);
      const state = resource.repository.productMemoryState();
      expect((await state.read(createMemoryId("memory-engine-coffee")))?.attributes).toMatchObject({
        supersededBy: null,
        validTo: null,
      });
      expect((await state.read(replacement.id))?.status).toBe("archived");
      expect(await search(resource, "我早上喝什么咖啡")).toContain("memory-engine-coffee");
    } finally {
      await resource.repository.close();
    }
  });
});
