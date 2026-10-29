import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  AI_GATEWAY_BASE_URL,
  type Embedder,
  GatewayEmbedder,
  gatewayEmbeddingUsage,
  HybridMemoryProvider,
  QWEN3_EMBEDDING_8B_DIMENSIONS,
  QWEN3_EMBEDDING_8B_MODEL,
  QWEN3_MEMORY_MINIMUM_SIMILARITY,
  QWEN3_MEMORY_QUERY_INSTRUCTION,
} from "@himawari-agent/memory-engine";
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

interface LiveEnvironment {
  readonly HIMAWARI_MEMORY_EVAL_LIVE?: string;
  readonly HIMAWARI_MEMORY_EVAL_OUTPUT?: string;
  readonly HIMAWARI_MEMORY_EVAL_COST_LIMIT_MICROS?: string;
  readonly HIMAWARI_MEMORY_EVAL_THRESHOLDS?: string;
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
const DATASET = path.resolve("evals/memory-retrieval/dataset.json");
const SELECTED_LIMIT = 5;
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

  embed(text: string): Promise<Float32Array> {
    let vector = this.#cache.get(text);
    if (!vector) {
      vector = this.#inner.embed(text);
      this.#cache.set(text, vector);
    }
    return vector;
  }
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
      const costLimitMicros = Number(environment.HIMAWARI_MEMORY_EVAL_COST_LIMIT_MICROS);
      expect(costLimitMicros).toBeGreaterThan(0);
      const thresholds = (
        environment.HIMAWARI_MEMORY_EVAL_THRESHOLDS ?? `0,${QWEN3_MEMORY_MINIMUM_SIMILARITY}`
      )
        .split(",")
        .map(Number);
      const key = environment.AI_GATEWAY_API_KEY?.trim();
      const usage = { requests: 0, inputTokens: 0, costMicros: 0 };
      const gateway = new GatewayEmbedder({
        baseUrl: AI_GATEWAY_BASE_URL,
        model: QWEN3_EMBEDDING_8B_MODEL,
        dimensions: QWEN3_EMBEDDING_8B_DIMENSIONS,
        apiKey: async () => (key && key.length > 0 ? key : PROXY_INJECTED_KEY),
      });
      gateway.bindBoundary(async (_request, send) => {
        if (usage.costMicros >= costLimitMicros)
          throw new Error(`MEMORY_EVAL_COST_LIMIT_REACHED ${usage.costMicros}`);
        const response = await send();
        const settled = gatewayEmbeddingUsage(
          response,
          QWEN3_EMBEDDING_8B_MODEL,
          QWEN3_EMBEDDING_8B_DIMENSIONS,
        );
        usage.requests += 1;
        usage.inputTokens += settled.inputTokens;
        usage.costMicros += settled.reportedCostMicros ?? 0;
        return response;
      }, 60_000);
      const embedder = new CachedEmbedder(gateway);
      const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-memory-retrieval-eval-"));
      const repository = await repositoryFor(dataset, stateRoot);
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
              index: repository.memoryIndex(),
              embedder,
              embeddableClassifications: ["public", "private"],
              queryInstruction: QWEN3_MEMORY_QUERY_INSTRUCTION,
              minimumSimilarity,
              now: () => dataset.today,
              timeZone: "Asia/Tokyo",
            }),
            content,
            workerId: "memory-retrieval-eval",
            now: () => dataset.today,
            maximumProjectionAttempts: 1,
            projectionLeaseMs: 60_000,
          });
        const ingest = service(QWEN3_MEMORY_MINIMUM_SIMILARITY);
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
              policy: { limit: SELECTED_LIMIT, allowedClassifications: ["public", "private"] },
            });
            outcomes.push({
              query,
              returned: found.map(({ memory, score }) => ({ id: memory.id, score })),
            });
          }
          runs.push({
            minimumSimilarity,
            production: minimumSimilarity === QWEN3_MEMORY_MINIMUM_SIMILARITY,
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
          model: QWEN3_EMBEDDING_8B_MODEL,
          selectedLimit: SELECTED_LIMIT,
          memories: dataset.memories.length,
          queries: dataset.queries.length,
          usage,
          runs: runs.map(({ outcomes: _outcomes, ...summary }) => summary),
        };
        await writeFile(path.join(output, "round.json"), `${JSON.stringify(round, null, 2)}\n`);
        await writeFile(path.join(output, "outcomes.json"), `${JSON.stringify(runs, null, 2)}\n`);
        expect(usage.requests).toBeGreaterThan(0);
      } finally {
        await repository.close();
        await rm(stateRoot, { recursive: true, force: true });
      }
    },
    15 * 60 * 1000,
  );
});
