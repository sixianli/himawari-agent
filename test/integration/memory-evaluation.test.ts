import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DurableMemoryService, type MemoryCategory } from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  type Embedder,
  HybridMemoryProvider,
  indexTerms,
  instructedQuery,
  QWEN3_MEMORY_QUERY_INSTRUCTION,
} from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const FIXTURE_ROOT = path.resolve(import.meta.dirname, "../fixtures/memory-evaluation");
const REPORT_ROOT = path.resolve(import.meta.dirname, "../../.ci-output/memory-evaluation");
const OWNER_ID = createOwnerId("owner-memory-evaluation");
const AGENT_ID = createAgentId("agent-memory-evaluation");
const THREAD_ID = createThreadId("thread-memory-evaluation");
const GENERATION_ID = createMemoryGenerationId("generation-memory-evaluation");
const TOP_K = 5;
const HASH_DIMENSIONS = 256;

interface DatasetMemory {
  readonly id: string;
  readonly text: string;
  readonly category: MemoryCategory;
  readonly importance: number;
  readonly entities: readonly string[];
  readonly updatedAt: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

interface DatasetQuestion {
  readonly id: string;
  readonly ability: string;
  readonly query: string;
  readonly relevant: readonly string[];
  readonly stale: readonly string[];
}

interface Dataset {
  readonly now: string;
  readonly memories: readonly DatasetMemory[];
  readonly questions: readonly DatasetQuestion[];
}

interface AbilityScore {
  readonly questions: number;
  readonly recallAt5: number | null;
  readonly mrr: number | null;
  readonly staleFree: number | null;
}

const dataset = JSON.parse(
  readFileSync(path.join(FIXTURE_ROOT, "dataset.json"), "utf8"),
) as Dataset;
const ABILITIES = [...new Set(dataset.questions.map(({ ability }) => ability))];

function float32(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const fraction = half & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function cachedVectors(dimensions: number): ReadonlyMap<string, Float32Array> | null {
  const file = path.join(FIXTURE_ROOT, `embeddings-${dimensions}.json`);
  if (!existsSync(file)) return null;
  const cache = JSON.parse(readFileSync(file, "utf8")) as {
    readonly dimensions: number;
    readonly vectors: Readonly<Record<string, string>>;
  };
  if (cache.dimensions !== dimensions) throw new Error("EVALUATION_CACHE_DIMENSIONS_MISMATCH");
  return new Map(
    Object.entries(cache.vectors).map(([text, encoded]) => {
      const bytes = Buffer.from(encoded, "base64");
      const halves = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      return [text, Float32Array.from(halves, float32)];
    }),
  );
}

function hashVector(text: string): Float32Array {
  const vector = new Float32Array(HASH_DIMENSIONS);
  for (const term of indexTerms(text)) {
    let hash = 2166136261;
    for (const character of term)
      hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
    const slot = (hash >>> 0) % HASH_DIMENSIONS;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

class EvaluationEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly #vectors: ReadonlyMap<string, Float32Array> | null;

  constructor(dimensions: number, vectors: ReadonlyMap<string, Float32Array> | null) {
    this.model = vectors ? "alibaba/qwen3-embedding-8b" : "evaluation-term-hash";
    this.dimensions = dimensions;
    this.#vectors = vectors;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.#vectors) return hashVector(text);
    const vector = this.#vectors.get(text);
    if (!vector) throw new Error(`EVALUATION_EMBEDDING_MISSING:${text}`);
    return vector;
  }
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1)
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  return dot;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function score(rankings: ReadonlyMap<string, readonly string[]>): Record<string, AbilityScore> {
  return Object.fromEntries(
    ABILITIES.map((ability) => {
      const questions = dataset.questions.filter((question) => question.ability === ability);
      const recall: number[] = [];
      const reciprocal: number[] = [];
      const staleFree: number[] = [];
      for (const question of questions) {
        const ranked = (rankings.get(question.id) ?? []).slice(0, TOP_K);
        const rank = (ids: readonly string[]) => {
          const found = ranked.findIndex((id) => ids.includes(id));
          return found < 0 ? Number.POSITIVE_INFINITY : found;
        };
        if (question.relevant.length > 0) {
          recall.push(
            question.relevant.filter((id) => ranked.includes(id)).length / question.relevant.length,
          );
          const first = rank(question.relevant);
          reciprocal.push(Number.isFinite(first) ? 1 / (first + 1) : 0);
        }
        if (question.stale.length > 0) {
          const stale = rank(question.stale);
          staleFree.push(
            question.relevant.length > 0
              ? Number(stale > rank(question.relevant) || !Number.isFinite(stale))
              : Number(stale >= 3),
          );
        }
      }
      return [
        ability,
        {
          questions: questions.length,
          recallAt5: mean(recall),
          mrr: mean(reciprocal),
          staleFree: mean(staleFree),
        },
      ];
    }),
  );
}

describe("memory retrieval evaluation", () => {
  useSqliteContractExecution("worker");
  const directories: string[] = [];
  const report: Record<string, unknown> = {};

  afterAll(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
    await mkdir(REPORT_ROOT, { recursive: true });
    await writeFile(path.join(REPORT_ROOT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  });

  async function evaluate(dimensions: number, vectors: ReadonlyMap<string, Float32Array> | null) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-memory-evaluation-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
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
      .run(THREAD_ID, OWNER_ID, AGENT_ID, dataset.now, dataset.now);
    const insertPayload = database.prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
        encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
      ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
        'active', ?, 'text/plain')`,
    );
    for (const memory of dataset.memories)
      insertPayload.run(
        `payload-${memory.id}`,
        OWNER_ID,
        AGENT_ID,
        `sha256:${memory.id}`,
        dataset.now,
      );
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (
          id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
          policy_version, status, attempt_count, requested_at
        ) VALUES ('checkpoint-memory-evaluation', ?, ?, ?, ?, 1, 1,
          'memory-policy-v1', 'completed', 1, ?)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, dataset.now);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES (?, 'checkpoint-memory-evaluation', ?, ?, ?, 'completed',
          'model-memory-fixture', 'memory-policy-v1', NULL)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => dataset.now,
    });
    try {
      const embedder = new EvaluationEmbedder(dimensions, vectors);
      const texts = new Map(
        dataset.memories.map((memory) => [`payload-${memory.id}`, memory.text]),
      );
      let clock = dataset.now;
      const instructed =
        vectors !== null &&
        dataset.questions.every(({ query }) =>
          vectors.has(instructedQuery(QWEN3_MEMORY_QUERY_INSTRUCTION, query)),
        );
      const provider = new HybridMemoryProvider({
        index: repository.memoryIndex(),
        embedder,
        embeddableClassifications: ["public", "private"],
        now: () => dataset.now,
        ...(instructed ? { queryInstruction: QWEN3_MEMORY_QUERY_INSTRUCTION } : {}),
      });
      const service = new DurableMemoryService({
        state: repository.productMemoryState(),
        jobs: repository.memoryProjectionJobs(),
        provider,
        content: {
          readText: async (ref) => {
            const text = texts.get(ref);
            if (text === undefined) throw new Error(`EVALUATION_CONTENT_MISSING:${ref}`);
            return text;
          },
        },
        workerId: "memory-evaluation",
        now: () => clock,
        maximumProjectionAttempts: 1,
        projectionLeaseMs: 60_000,
      });
      for (const memory of [...dataset.memories].sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt),
      )) {
        clock = memory.updatedAt;
        await service.applyProposal(
          {
            decision: "create",
            memory: {
              id: createMemoryId(memory.id),
              ownerId: OWNER_ID,
              agentId: AGENT_ID,
              contentRef: `payload-${memory.id}`,
              dataClassification: "private",
              sourceThreadId: THREAD_ID,
              sourceRefs: [`message-${memory.id}`],
              inference: false,
              confidencePermille: 950,
              policyVersion: "memory-capture:v2",
              attributes: {
                category: memory.category,
                importancePermille: memory.importance,
                entities: memory.entities,
                validFrom: memory.validFrom,
                validTo: memory.validTo,
                supersededBy: null,
                evidenceVerified: true,
              },
            },
          },
          GENERATION_ID,
        );
      }
      clock = dataset.now;
      while ((await service.runProjectionBatch(100)).length > 0);
      const memoryVectors = await Promise.all(
        dataset.memories.map(async (memory) => ({
          id: memory.id,
          vector: await embedder.embed(memory.text),
        })),
      );
      const engine = new Map<string, readonly string[]>();
      const baseline = new Map<string, readonly string[]>();
      for (const question of dataset.questions) {
        const hits = await provider.search({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          query: question.query,
          limit: TOP_K,
        });
        engine.set(
          question.id,
          hits.map(({ productMemoryId }) => productMemoryId),
        );
        const query = await embedder.embed(question.query);
        baseline.set(
          question.id,
          memoryVectors
            .map(({ id, vector }) => ({ id, similarity: cosine(query, vector) }))
            .sort(
              (left, right) =>
                right.similarity - left.similarity || left.id.localeCompare(right.id),
            )
            .slice(0, TOP_K)
            .map(({ id }) => id),
        );
      }
      return {
        mode: vectors ? "qwen3-embedding-8b" : "term-hash",
        queryInstruction: instructed,
        dimensions,
        engine: score(engine),
        baseline: score(baseline),
        rankings: Object.fromEntries(
          dataset.questions.map(({ id }) => [
            id,
            { engine: engine.get(id), baseline: baseline.get(id) },
          ]),
        ),
      };
    } finally {
      await repository.close();
    }
  }

  function assertNotBelowBaseline(result: Awaited<ReturnType<typeof evaluate>>) {
    for (const ability of ABILITIES) {
      const engine = result.engine[ability];
      const baseline = result.baseline[ability];
      if (!engine || !baseline) throw new Error(`EVALUATION_ABILITY_MISSING:${ability}`);
      for (const metric of ["recallAt5", "staleFree"] as const)
        expect(
          engine[metric] ?? 0,
          `${result.mode}/${result.dimensions} ${ability} ${metric}`,
        ).toBeGreaterThanOrEqual(baseline[metric] ?? 0);
    }
  }

  it("covers five abilities with labelled memories", () => {
    expect(ABILITIES.sort()).toEqual([
      "abstention",
      "extraction",
      "knowledge_update",
      "multi_session",
      "temporal",
    ]);
    expect(dataset.memories.length).toBeGreaterThanOrEqual(150);
    expect(dataset.questions.length).toBeGreaterThanOrEqual(100);
  });

  it("does not fall below the Mem0 baseline in any ability", async () => {
    const results = [];
    for (const dimensions of [4096, 1024]) {
      const vectors = cachedVectors(dimensions);
      if (vectors) results.push(await evaluate(dimensions, vectors));
    }
    if (results.length === 0) results.push(await evaluate(HASH_DIMENSIONS, null));
    for (const result of results) {
      report[`${result.mode}-${result.dimensions}`] = result;
      assertNotBelowBaseline(result);
    }
    const full = results.find(({ dimensions }) => dimensions === 4096);
    const reduced = results.find(({ dimensions }) => dimensions === 1024);
    if (full && reduced)
      report["reducedDimensionsWithoutLoss"] = ABILITIES.every((ability) =>
        (["recallAt5", "mrr", "staleFree"] as const).every(
          (metric) =>
            (reduced.engine[ability]?.[metric] ?? 0) >= (full.engine[ability]?.[metric] ?? 0),
        ),
      );
  });
});
