import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DurableMemoryService,
  type EmbeddingProfile,
  embeddingIdentity,
  findEmbeddingProfile,
  GATEWAY_EMBEDDING_PROVIDER,
  JINA_V5_SMALL_INT8_PROFILE,
  LOCAL_ONNX_EMBEDDING_PROVIDER,
  type MemoryCategory,
  QWEN3_EMBEDDING_8B_PROFILE,
  type MemoryIndexSearchResult,
  type MemoryIndexStorePort,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  AI_GATEWAY_BASE_URL,
  EgressEmbedder,
  DEFAULT_RELEVANCE_TUNING,
  type Embedder,
  embeddingUsageFor,
  HybridMemoryProvider,
  LOCAL_ONNX_BASE_URL,
  QWEN3_EMBEDDING_8B_DIMENSIONS,
} from "@himawari-agent/memory-engine";
import { LocalOnnxEmbeddingRuntime } from "@himawari-agent/platform-node";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { beforeAll, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "../sqlite-contract-execution.fixture.ts";
import { type RetrievalOutcome, type RetrievalQuery, retrievalMetrics } from "./metrics.ts";
import { testModelEgress } from "@himawari-agent/testing";

interface LiveEnvironment {
  readonly HIMAWARI_MEMORY_EVAL_LIVE?: string;
  readonly HIMAWARI_MEMORY_EVAL_OUTPUT?: string;
  readonly HIMAWARI_MEMORY_EVAL_COST_LIMIT_MICROS?: string;
  readonly HIMAWARI_MEMORY_EVAL_THRESHOLDS?: string;
  readonly HIMAWARI_MEMORY_EVAL_PROVIDER?: string;
  readonly HIMAWARI_MEMORY_EVAL_MODEL?: string;
  readonly HIMAWARI_MEMORY_EVAL_STATE_ROOT?: string;
  readonly HIMAWARI_MEMORY_EVAL_ARTIFACT?: string;
  readonly HIMAWARI_MEMORY_EVAL_DATASET?: string;
  readonly AI_GATEWAY_API_KEY?: string;
}

interface DatasetMemory {
  readonly id: string;
  readonly text: string;
  readonly category: MemoryCategory;
  readonly importancePermille: number;
  readonly entities: readonly string[];
}

interface Dataset {
  readonly schema: string;
  readonly today: string;
  readonly memories: readonly DatasetMemory[];
  readonly queries: readonly RetrievalQuery[];
}

const environment = process.env as unknown as LiveEnvironment;
const LIVE = environment.HIMAWARI_MEMORY_EVAL_LIVE === "1";
const DATASET = path.resolve(
  environment.HIMAWARI_MEMORY_EVAL_DATASET ?? "evals/memory-retrieval/dataset.json",
);
const PRODUCTION_MEMORY_LIMIT = 20;
const PROXY_INJECTED_KEY = "proxy-injected";
const OWNER_ID = createOwnerId("owner-memory-retrieval-eval");
const AGENT_ID = createAgentId("agent-memory-retrieval-eval");
const THREAD_ID = createThreadId("thread-memory-retrieval-eval");
const GENERATION_ID = createMemoryGenerationId("generation-memory-retrieval-eval");

class CachedEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly #inner: Embedder;
  readonly #cache = new Map<string, Promise<Float32Array>>();

  constructor(inner: Embedder) {
    this.#inner = inner;
    this.model = inner.model;
    this.dimensions = inner.dimensions;
  }

  embedQuery(query: string): Promise<Float32Array> {
    return this.#cached(`query\u0000${query}`, () => this.#inner.embedQuery(query));
  }

  embedDocument(text: string): Promise<Float32Array> {
    return this.#cached(`document\u0000${text}`, () => this.#inner.embedDocument(text));
  }

  #cached(key: string, compute: () => Promise<Float32Array>): Promise<Float32Array> {
    let vector = this.#cache.get(key);
    if (!vector) {
      vector = compute();
      this.#cache.set(key, vector);
    }
    return vector;
  }
}

function evaluatedProfile(): EmbeddingProfile {
  const provider = environment.HIMAWARI_MEMORY_EVAL_PROVIDER ?? GATEWAY_EMBEDDING_PROVIDER;
  const model =
    environment.HIMAWARI_MEMORY_EVAL_MODEL ??
    (provider === LOCAL_ONNX_EMBEDDING_PROVIDER
      ? JINA_V5_SMALL_INT8_PROFILE.model
      : QWEN3_EMBEDDING_8B_PROFILE.model);
  const profile = findEmbeddingProfile(provider, model);
  if (!profile) throw new Error(`MEMORY_EVAL_PROFILE_UNKNOWN ${provider} ${model}`);
  return profile;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? null;
}

function recordingIndex(
  index: MemoryIndexStorePort,
  recorded: Map<string, MemoryIndexSearchResult>,
): MemoryIndexStorePort {
  return {
    upsert: (document) => index.upsert(document),
    delete: (memoryId) => index.delete(memoryId),
    clearScope: (ownerId, agentId) => index.clearScope(ownerId, agentId),
    listUnindexed: (input) => index.listUnindexed(input),
    search: async (input) => {
      const result = await index.search(input);
      if (input.minimumSimilarity === 0) recorded.set(input.queryText, result);
      return result;
    },
  };
}

async function repositoryFor(dataset: Dataset, stateRoot: string) {
  const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
  applyMigrations(database, await loadBundledMigrations());
  const at = dataset.today;
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'open', ?, ?)`,
    )
    .run(THREAD_ID, OWNER_ID, AGENT_ID, at, at);
  const insertPayload = database.prepare(
    `INSERT INTO payloads (
      ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
      encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
    ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
      'active', ?, 'text/plain')`,
  );
  for (const ref of [...dataset.memories.map(({ id }) => `payload-${id}`), "payload-query"])
    insertPayload.run(ref, OWNER_ID, AGENT_ID, `sha256:${ref}`, at);
  database
    .prepare(
      `INSERT INTO thread_checkpoint_jobs (
        id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
        policy_version, status, attempt_count, requested_at
      ) VALUES ('checkpoint-memory-retrieval-eval', ?, ?, ?, ?, 1, 1,
        'memory-policy-v1', 'completed', 1, ?)`,
    )
    .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, at);
  database
    .prepare(
      `INSERT INTO memory_generations (
        id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
        model_descriptor_ref, policy_version, output_ref
      ) VALUES (?, 'checkpoint-memory-retrieval-eval', ?, ?, ?, 'completed',
        'model-memory-eval', 'memory-policy-v1', NULL)`,
    )
    .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
  database.close();
  return SqliteProductStateRepository.open({ stateRoot, minimumFreeBytes: 0, now: () => at });
}

describe.skipIf(!LIVE)("memory retrieval live evaluation", () => {
  useSqliteContractExecution("worker");
  beforeAll(() => {
    if (process.env["HTTPS_PROXY"] || process.env["https_proxy"])
      setGlobalDispatcher(new EnvHttpProxyAgent());
  });

  it(
    "measures what the production memory search brings for related and unrelated sentences",
    async () => {
      const raw = await readFile(DATASET, "utf8");
      const dataset = JSON.parse(raw) as Dataset;
      const costLimitMicros = Number(environment.HIMAWARI_MEMORY_EVAL_COST_LIMIT_MICROS ?? 0);
      const profile = evaluatedProfile();
      const local = profile.provider === LOCAL_ONNX_EMBEDDING_PROVIDER;
      const dimensions = local ? (profile.dimensions[0] ?? 0) : QWEN3_EMBEDDING_8B_DIMENSIONS;
      const artifactSha256 = environment.HIMAWARI_MEMORY_EVAL_ARTIFACT?.trim();
      const identity = embeddingIdentity({
        provider: profile.provider,
        model: profile.model,
        dimensions,
        ...(local && artifactSha256 ? { artifactSha256 } : {}),
      });
      const thresholds = (
        environment.HIMAWARI_MEMORY_EVAL_THRESHOLDS ?? `0,${profile.chatMinimumSimilarity}`
      )
        .split(",")
        .map(Number);
      const key = environment.AI_GATEWAY_API_KEY?.trim();
      const usage = { requests: 0, inputTokens: 0, costMicros: 0 };
      const latencies: number[] = [];
      let runtime: LocalOnnxEmbeddingRuntime | undefined;
      let loadMs: number | null = null;
      if (local) {
        const stateRoot = environment.HIMAWARI_MEMORY_EVAL_STATE_ROOT;
        if (!stateRoot || !artifactSha256) throw new Error("MEMORY_EVAL_LOCAL_ARTIFACT_REQUIRED");
        runtime = new LocalOnnxEmbeddingRuntime({ stateRoot, profile, dimensions, artifactSha256 });
        const started = performance.now();
        await runtime.start();
        loadMs = Math.round(performance.now() - started);
        expect(runtime.state).toBe("ready");
      }
      const settle = embeddingUsageFor(profile.provider);
      const inner = new EgressEmbedder({
        egress: testModelEgress(),
        baseUrl: local ? LOCAL_ONNX_BASE_URL : AI_GATEWAY_BASE_URL,
        profile,
        identity,
        dimensions,
        ...(runtime
          ? { fetch: runtime.fetch as typeof fetch }
          : { apiKey: async () => (key && key.length > 0 ? key : PROXY_INJECTED_KEY) }),
      });
      inner.bindBoundary(async (_request, send) => {
        if (!local && usage.costMicros >= costLimitMicros)
          throw new Error(`MEMORY_EVAL_COST_LIMIT_REACHED ${usage.costMicros}`);
        const started = performance.now();
        const response = await send();
        latencies.push(performance.now() - started);
        const settled = settle(response, profile.model, dimensions);
        usage.requests += 1;
        usage.inputTokens += settled.inputTokens;
        usage.costMicros += settled.reportedCostMicros ?? 0;
        return response;
      }, 60_000);
      const embedder = new CachedEmbedder(inner);
      const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-memory-retrieval-eval-"));
      const repository = await repositoryFor(dataset, stateRoot);
      const candidates = new Map<string, MemoryIndexSearchResult>();
      try {
        const texts = new Map(
          dataset.memories.map((memory) => [`payload-${memory.id}`, memory.text]),
        );
        const content = {
          readText: async (ref: string) => {
            const text = texts.get(ref);
            if (text === undefined) throw new Error(`MEMORY_EVAL_CONTENT_MISSING ${ref}`);
            return text;
          },
        };
        const service = (minimumSimilarity: number) =>
          new DurableMemoryService({
            state: repository.productMemoryState(),
            jobs: repository.memoryProjectionJobs(),
            provider: new HybridMemoryProvider({
              index: recordingIndex(repository.memoryIndex(), candidates),
              embedder,
              embeddableClassifications: ["public", "private"],
              minimumSimilarity,
              now: () => dataset.today,
              timeZone: "Asia/Tokyo",
            }),
            content,
            workerId: "memory-retrieval-eval",
            dedupeSameSource: true,
            now: () => dataset.today,
            maximumProjectionAttempts: 1,
            projectionLeaseMs: 60_000,
          });
        if (!local) expect(costLimitMicros).toBeGreaterThan(0);
        const ingest = service(profile.chatMinimumSimilarity);
        for (const memory of dataset.memories)
          await ingest.applyProposal(
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
                confidencePermille: 1000,
                policyVersion: "memory-policy-v1",
                attributes: {
                  category: memory.category,
                  importancePermille: memory.importancePermille,
                  entities: [...memory.entities],
                  validFrom: null,
                  validTo: null,
                  supersededBy: null,
                  evidenceVerified: true,
                },
              },
            },
            GENERATION_ID,
          );
        await ingest.runProjectionBatch(dataset.memories.length + 5);

        const runs = [];
        for (const minimumSimilarity of thresholds) {
          const search = service(minimumSimilarity);
          const outcomes: RetrievalOutcome[] = [];
          for (const query of dataset.queries) {
            texts.set("payload-query", query.text);
            const found = await search.search({
              ownerId: OWNER_ID,
              agentId: AGENT_ID,
              queryRef: "payload-query",
              policy: {
                limit: PRODUCTION_MEMORY_LIMIT,
                allowedClassifications: ["public", "private"],
              },
            });
            outcomes.push({
              query,
              returned: found.map(({ memory, score }) => ({ id: memory.id, score })),
            });
          }
          runs.push({
            minimumSimilarity,
            relevance: DEFAULT_RELEVANCE_TUNING,
            dedupeSameSource: true,
            production: minimumSimilarity === profile.chatMinimumSimilarity,
            metrics: retrievalMetrics(outcomes),
            outcomes: outcomes.map(({ query, returned }) => ({
              id: query.id,
              text: query.text,
              kind: query.kind,
              expected: query.expected,
              returned,
            })),
          });
        }

        const output =
          environment.HIMAWARI_MEMORY_EVAL_OUTPUT ??
          path.resolve(
            ".ci-output/memory-retrieval",
            new Date().toISOString().replace(/[:.]/gu, "-"),
          );
        await mkdir(output, { recursive: true });
        const round = {
          schema: "himawari-memory-retrieval-round.v1",
          recordedAt: new Date().toISOString(),
          commit: execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(),
          datasetSha256: createHash("sha256").update(raw).digest("hex"),
          model: profile.model,
          provider: profile.provider,
          embeddingIdentity: identity,
          loadMs,
          latencyMs: {
            median: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
          },
          rssMb: Math.round(process.memoryUsage().rss / 1_000_000),
          selectedLimit: PRODUCTION_MEMORY_LIMIT,
          memories: dataset.memories.length,
          queries: dataset.queries.length,
          usage,
          runs: runs.map(({ outcomes: _outcomes, ...summary }) => summary),
        };
        await writeFile(path.join(output, "round.json"), `${JSON.stringify(round, null, 2)}\n`);
        await writeFile(path.join(output, "outcomes.json"), `${JSON.stringify(runs, null, 2)}\n`);
        await writeFile(
          path.join(output, "candidates.json"),
          `${JSON.stringify(Object.fromEntries(candidates), null, 2)}\n`,
        );
        expect(usage.requests).toBeGreaterThan(0);
      } finally {
        await runtime?.close();
        await repository.close();
        await rm(stateRoot, { recursive: true, force: true });
      }
    },
    15 * 60 * 1000,
  );
});
