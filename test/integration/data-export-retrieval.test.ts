import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DurableMemoryService } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import { type Embedder, HybridMemoryProvider } from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  buildPortableExport,
  importPortableExport,
  LATEST_MIGRATION_SEQUENCE,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createDataExportTextPolicy } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { newProtector, putPayload, type Side } from "./data-export-fixture.ts";
import {
  type RetrievalOutcome,
  type RetrievalQuery,
  retrievalMetrics,
} from "./memory-retrieval-eval/metrics.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

interface DatasetMemory {
  readonly id: string;
  readonly text: string;
  readonly category: string;
  readonly importancePermille: number;
  readonly entities: readonly string[];
}
interface Dataset {
  readonly today: string;
  readonly memories: readonly DatasetMemory[];
  readonly queries: readonly RetrievalQuery[];
}

const DIMENSIONS = 128;
const AT = "2026-11-09T00:00:00.000Z";
const directories: string[] = [];

class HashingEmbedder implements Embedder {
  embedQuery(query: string): Promise<Float32Array> {
    return this.embed(query);
  }

  embedDocument(text: string): Promise<Float32Array> {
    return this.embed(text);
  }

  readonly model = "test-hashing-embedder";
  readonly dimensions = DIMENSIONS;
  async embed(text: string): Promise<Float32Array> {
    const vector = new Float32Array(DIMENSIONS);
    const characters = [...text.replace(/\s+/gu, "")];
    for (let index = 0; index + 1 < characters.length; index += 1) {
      const gram = `${characters[index]}${characters[index + 1]}`;
      let hash = 2166136261;
      for (const code of gram) hash = Math.imul(hash ^ (code.codePointAt(0) ?? 0), 16777619);
      vector[Math.abs(hash) % DIMENSIONS] = (vector[Math.abs(hash) % DIMENSIONS] ?? 0) + 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  }
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function stateRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-export-retrieval-"));
  directories.push(directory);
  return directory;
}

function prepare(root: string, suffix: string): Side {
  const database = openQualifiedDatabase(path.join(root, "product.sqlite"));
  return {
    database,
    ownerId: createOwnerId(`owner-retrieval-${suffix}`),
    agentId: createAgentId(`agent-retrieval-${suffix}`),
    protector: newProtector(),
    migrationSequence: LATEST_MIGRATION_SEQUENCE,
    directory: root,
  };
}

async function migrated(root: string, suffix: string): Promise<Side> {
  const side = prepare(root, suffix);
  applyMigrations(side.database, await loadBundledMigrations());
  side.database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(side.ownerId);
  side.database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(side.agentId, side.ownerId);
  return side;
}

async function searchAll(
  side: Side,
  root: string,
  dataset: Dataset,
  rebuild: "rebuild" | "pending" | "none",
) {
  const repository = await SqliteProductStateRepository.open({
    stateRoot: root,
    minimumFreeBytes: 0,
    now: () => AT,
  });
  try {
    const payloads = repository.payloadStore(side.ownerId, side.agentId);
    let queryText = "";
    const service = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider: new HybridMemoryProvider({
        index: repository.memoryIndex(),
        embedder: new HashingEmbedder(),
        embeddableClassifications: ["public", "private"],
        minimumSimilarity: 0.3,
        now: () => dataset.today,
        timeZone: "Asia/Tokyo",
      }),
      content: {
        readText: async (ref: string) => {
          if (ref === "payload-query") return queryText;
          const payload = await payloads.get(ref);
          if (!payload) throw new Error(`CONTENT_MISSING ${ref}`);
          return new TextDecoder().decode(
            await side.protector.unprotect({
              ownerId: side.ownerId,
              agentId: side.agentId,
              payload,
            }),
          );
        },
      },
      workerId: "data-export-retrieval",
      now: () => dataset.today,
      maximumProjectionAttempts: 1,
      projectionLeaseMs: 60_000,
    });
    if (rebuild === "rebuild") {
      const generation = side.database
        .prepare("SELECT id FROM memory_generations LIMIT 1")
        .pluck()
        .get() as string;
      await service.rebuild(side.ownerId, side.agentId, generation as never);
    }
    if (rebuild === "pending") while ((await service.runProjectionBatch(50)).length > 0);
    const outcomes: RetrievalOutcome[] = [];
    for (const query of dataset.queries) {
      queryText = query.text;
      const found = await service.search({
        ownerId: side.ownerId,
        agentId: side.agentId,
        queryRef: "payload-query",
        policy: { limit: 5, allowedClassifications: ["public", "private"] },
      });
      outcomes.push({
        query,
        returned: found.map(({ memory, score }) => ({ id: memory.id, score })),
      });
    }
    return { outcomes, metrics: retrievalMetrics(outcomes) };
  } finally {
    await repository.close();
  }
}

describe("data export: retrieval evaluation is unchanged by export and import", () => {
  useSqliteContractExecution("worker");

  async function scenario() {
    const dataset = JSON.parse(
      await readFile(path.resolve("evals/memory-retrieval/dataset.json"), "utf8"),
    ) as Dataset;
    const sourceRoot = await stateRoot();
    const source = await migrated(sourceRoot, "a");
    source.database
      .prepare(
        `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at) VALUES ('t-eval', ?, ?, 1, 'open', ?, ?)`,
      )
      .run(source.ownerId, source.agentId, AT, AT);
    source.database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark, policy_version, status, attempt_count, requested_at)
      VALUES ('cp-eval', 'gen-eval', ?, ?, 't-eval', 1, 1, 'p', 'completed', 1, ?)`,
      )
      .run(source.ownerId, source.agentId, AT);
    source.database
      .prepare(
        `INSERT INTO memory_generations (id, checkpoint_job_id, owner_id, agent_id, thread_id, status, model_descriptor_ref, policy_version)
      VALUES ('gen-eval', 'cp-eval', ?, ?, 't-eval', 'completed', 'm', 'p')`,
      )
      .run(source.ownerId, source.agentId);
    for (const memory of dataset.memories) {
      const ref = await putPayload(source, `payload-${memory.id}`, memory.text);
      source.database
        .prepare(
          `INSERT INTO memory_records (id, owner_id, agent_id, revision, status, content_ref, classification, inference, confidence_permille, policy_version, updated_at, category, importance_permille, evidence_verified, recorded_at)
        VALUES (?, ?, ?, 1, 'active', ?, 'private', 0, 1000, 'memory-policy-v1', ?, ?, ?, 1, ?)`,
        )
        .run(
          memory.id,
          source.ownerId,
          source.agentId,
          ref,
          AT,
          memory.category,
          memory.importancePermille,
          AT,
        );
      for (const entity of memory.entities)
        source.database
          .prepare("INSERT OR IGNORE INTO memory_entities (memory_id, name) VALUES (?, ?)")
          .run(memory.id, entity.toLowerCase());
    }
    const before = await searchAll(source, sourceRoot, dataset, "rebuild");
    const files = (
      await buildPortableExport({
        database: source.database,
        scope: { ownerId: source.ownerId, agentId: source.agentId },
        migrationSequence: LATEST_MIGRATION_SEQUENCE,
        protector: source.protector,
        policy: createDataExportTextPolicy(),
        now: () => AT,
      })
    ).files;
    const targetRoot = await stateRoot();
    const target = await migrated(targetRoot, "b");
    await importPortableExport(files, {
      database: target.database,
      scope: { ownerId: target.ownerId, agentId: target.agentId },
      migrationSequence: LATEST_MIGRATION_SEQUENCE,
      protector: target.protector,
      now: () => AT,
    });
    return { dataset, before, target, targetRoot, source };
  }

  it("[P1-6] gives the same hits and scores after import once the index is built", async () => {
    const { dataset, before, target, targetRoot, source } = await scenario();
    source.database.close();
    target.database.close();
    expect(before.metrics.hitRate).toBeGreaterThan(0);
    const after = await searchAll(target, targetRoot, dataset, "pending");
    expect(after.metrics).toEqual(before.metrics);
    expect(after.outcomes).toEqual(before.outcomes);
  });

  it("[P1-6][reverse] without the index being built the scores differ and the test notices", async () => {
    const { dataset, before, target, targetRoot, source } = await scenario();
    source.database.close();
    target.database.close();
    const after = await searchAll(target, targetRoot, dataset, "none");
    expect(after.metrics).not.toEqual(before.metrics);
    expect(after.metrics.hitRate).toBe(0);
  });
});
