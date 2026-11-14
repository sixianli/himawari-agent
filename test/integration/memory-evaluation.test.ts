import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DurableMemoryService,
  embeddingQueryText,
  type MemoryCategory,
  type MemoryTimeScope,
  QWEN3_EMBEDDING_8B_PROFILE,
} from "@himawari-agent/application";
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
  MemoryEpisodeService,
  requestedTimeScope,
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
  readonly supersedes?: string;
}

interface DatasetQuestion {
  readonly id: string;
  readonly ability: string;
  readonly query: string;
  readonly relevant: readonly string[];
  readonly stale: readonly string[];
  readonly phase?: number;
}

interface DatasetEpisode {
  readonly id: string;
  readonly day: string;
  readonly text: string;
}

interface Dataset {
  readonly now: string;
  readonly memories: readonly DatasetMemory[];
  readonly questions: readonly DatasetQuestion[];
  readonly episodes: readonly DatasetEpisode[];
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
const TIME_ZONE = "Asia/Tokyo";
const PHASE_ONE_QUESTIONS = dataset.questions.filter(({ phase }) => phase === undefined);
const PHASE_TWO_QUESTIONS = dataset.questions.filter(({ phase }) => phase === 2);
const ABILITIES = [...new Set(PHASE_ONE_QUESTIONS.map(({ ability }) => ability))];
const PHASE_TWO_ABILITIES = [...new Set(PHASE_TWO_QUESTIONS.map(({ ability }) => ability))];
const PRESENT_SCOPE = Object.freeze({ includeHistory: false, from: null, to: null });
const MODEL_SCOPES = JSON.parse(
  readFileSync(path.join(FIXTURE_ROOT, "model-time-scopes.json"), "utf8"),
) as {
  readonly now: string;
  readonly timeZone: string;
  readonly scopes: Readonly<
    Record<string, { from?: string; to?: string; includeHistory?: boolean } | null>
  >;
};

function modelScope(question: DatasetQuestion): MemoryTimeScope | undefined {
  const asked = MODEL_SCOPES.scopes[question.id];
  return asked
    ? requestedTimeScope({ ...asked, includeHistory: asked.includeHistory === true }, TIME_ZONE)
    : undefined;
}

function float32(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const fraction = half & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function requiredTexts(questions: readonly DatasetQuestion[], episodes: boolean): string[] {
  return [
    ...dataset.memories.map(({ text }) => text),
    ...questions.flatMap(({ query }) => [
      query,
      embeddingQueryText(QWEN3_EMBEDDING_8B_PROFILE, query),
    ]),
    ...(episodes ? dataset.episodes.map(({ day, text }) => `${day}\n${text}`) : []),
  ];
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
  instructed = false;

  embedQuery(query: string): Promise<Float32Array> {
    return this.embed(
      this.instructed ? embeddingQueryText(QWEN3_EMBEDDING_8B_PROFILE, query) : query,
    );
  }

  embedDocument(text: string): Promise<Float32Array> {
    return this.embed(text);
  }

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

function score(
  rankings: ReadonlyMap<string, readonly string[]>,
  questionSet: readonly DatasetQuestion[] = PHASE_ONE_QUESTIONS,
): Record<string, AbilityScore> {
  return Object.fromEntries(
    [...new Set(questionSet.map(({ ability }) => ability))].map((ability) => {
      const questions = questionSet.filter((question) => question.ability === ability);
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

  async function prepare(
    dimensions: number,
    vectors: ReadonlyMap<string, Float32Array> | null,
    options: { readonly supersession: boolean; readonly episodes: boolean },
  ) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-memory-evaluation-"));
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
    const embedder = new EvaluationEmbedder(dimensions, vectors);
    const texts = new Map(dataset.memories.map((memory) => [`payload-${memory.id}`, memory.text]));
    let clock = dataset.now;
    const instructed =
      vectors !== null &&
      (options.episodes ? PHASE_TWO_QUESTIONS : PHASE_ONE_QUESTIONS).every(({ query }) =>
        vectors.has(embeddingQueryText(QWEN3_EMBEDDING_8B_PROFILE, query)),
      );
    embedder.instructed = instructed;
    const provider = new HybridMemoryProvider({
      index: repository.memoryIndex(),
      embedder,
      embeddableClassifications: ["public", "private"],
      now: () => dataset.now,
      timeZone: TIME_ZONE,
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
            policyVersion: "memory-capture:v3",
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
          ...(options.supersession && memory.supersedes
            ? { supersedes: createMemoryId(memory.supersedes) }
            : {}),
        },
        GENERATION_ID,
      );
    }
    clock = dataset.now;
    while ((await service.runProjectionBatch(100)).length > 0);
    const episodeIds = new Map<string, string>();
    const episodes = options.episodes
      ? new MemoryEpisodeService({
          store: repository.memoryEpisodes(),
          threads: repository.threadRepository(),
          readText: async ({ ref }) => texts.get(ref),
          storeText: async (input) => {
            const connection = openQualifiedDatabase(databasePath);
            try {
              connection
                .prepare(
                  `INSERT OR IGNORE INTO payloads (
                    ref, owner_id, agent_id, classification, storage_kind, ciphertext,
                    content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at,
                    content_type
                  ) VALUES (?, ?, ?, ?, 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
                    'active', ?, 'text/plain')`,
                )
                .run(
                  input.ref,
                  input.ownerId,
                  input.agentId,
                  input.dataClassification,
                  `sha256:${input.ref}`,
                  input.createdAt,
                );
            } finally {
              connection.close();
            }
            texts.set(input.ref, input.text);
          },
          embedder,
          timeZone: TIME_ZONE,
          now: () => dataset.now,
        })
      : null;
    if (episodes)
      for (const [index, episode] of dataset.episodes.entries()) {
        const at = `${episode.day}T03:00:00.000Z`;
        const saved = await episodes.summarize(
          {
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            threadId: THREAD_ID,
            day: episode.day,
            firstSequence: index + 1,
            lastSequence: index + 1,
            startedAt: at,
            endedAt: at,
            dataClassification: "private",
            lines: [{ role: "owner", text: episode.text, committedAt: at }],
          },
          async () => episode.text,
        );
        episodeIds.set(saved.id, episode.id);
      }
    return { repository, embedder, provider, episodes, episodeIds, instructed };
  }

  async function evaluate(
    dimensions: number,
    vectors: ReadonlyMap<string, Float32Array> | null,
    scopeFor: (question: DatasetQuestion) => MemoryTimeScope | undefined = modelScope,
  ) {
    const current = await prepare(dimensions, vectors, { supersession: true, episodes: false });
    const phaseOne = await prepare(dimensions, vectors, { supersession: false, episodes: false });
    try {
      const memoryVectors = await Promise.all(
        dataset.memories.map(async (memory) => ({
          id: memory.id,
          vector: await current.embedder.embed(memory.text),
        })),
      );
      const engine = new Map<string, readonly string[]>();
      const previous = new Map<string, readonly string[]>();
      const baseline = new Map<string, readonly string[]>();
      for (const question of PHASE_ONE_QUESTIONS) {
        const search = (resource: typeof current, scope?: MemoryTimeScope) =>
          resource.provider
            .search({
              ownerId: OWNER_ID,
              agentId: AGENT_ID,
              query: question.query,
              limit: TOP_K,
              ...(scope ? { scope } : {}),
            })
            .then((hits) => hits.map(({ productMemoryId }) => productMemoryId as string));
        engine.set(question.id, await search(current, scopeFor(question)));
        previous.set(question.id, await search(phaseOne, PRESENT_SCOPE));
        const query = await current.embedder.embed(question.query);
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
        queryInstruction: current.instructed,
        dimensions,
        engine: score(engine),
        phaseOne: score(previous),
        baseline: score(baseline),
        rankings: Object.fromEntries(
          PHASE_ONE_QUESTIONS.map(({ id }) => [
            id,
            { engine: engine.get(id), phaseOne: previous.get(id), baseline: baseline.get(id) },
          ]),
        ),
      };
    } finally {
      await current.repository.close();
      await phaseOne.repository.close();
    }
  }

  async function evaluatePhaseTwo(
    dimensions: number,
    vectors: ReadonlyMap<string, Float32Array> | null,
    scopeFor: (question: DatasetQuestion) => MemoryTimeScope | undefined = modelScope,
  ) {
    const current = await prepare(dimensions, vectors, { supersession: true, episodes: true });
    const phaseOne = await prepare(dimensions, vectors, { supersession: false, episodes: false });
    try {
      const engine = new Map<string, readonly string[]>();
      const previous = new Map<string, readonly string[]>();
      for (const question of PHASE_TWO_QUESTIONS) {
        if (question.ability === "episode") {
          const hits = await current.episodes?.search({
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            query: question.query,
            scope: scopeFor(question) ?? null,
            allowedClassifications: ["public", "private"],
            limit: TOP_K,
          });
          engine.set(
            question.id,
            (hits ?? []).map(({ episode }) => current.episodeIds.get(episode.id) ?? episode.id),
          );
          previous.set(question.id, []);
          continue;
        }
        const search = (resource: typeof current, scope?: MemoryTimeScope) =>
          resource.provider
            .search({
              ownerId: OWNER_ID,
              agentId: AGENT_ID,
              query: question.query,
              limit: TOP_K,
              ...(scope ? { scope } : {}),
            })
            .then((hits) => hits.map(({ productMemoryId }) => productMemoryId as string));
        engine.set(question.id, await search(current, scopeFor(question)));
        previous.set(question.id, await search(phaseOne, PRESENT_SCOPE));
      }
      return {
        mode: vectors ? "qwen3-embedding-8b" : "term-hash",
        queryInstruction: current.instructed,
        dimensions,
        engine: score(engine, PHASE_TWO_QUESTIONS),
        phaseOne: score(previous, PHASE_TWO_QUESTIONS),
        rankings: Object.fromEntries(
          PHASE_TWO_QUESTIONS.map(({ id }) => [
            id,
            { engine: engine.get(id), phaseOne: previous.get(id) },
          ]),
        ),
      };
    } finally {
      await current.repository.close();
      await phaseOne.repository.close();
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

  function completeVectors(dimensions: number, texts: readonly string[]) {
    const vectors = cachedVectors(dimensions);
    return vectors && texts.every((text) => vectors.has(text)) ? vectors : null;
  }

  it("covers the labelled abilities of both phases", () => {
    expect([...ABILITIES].sort()).toEqual([
      "abstention",
      "extraction",
      "knowledge_update",
      "multi_session",
      "temporal",
    ]);
    expect([...PHASE_TWO_ABILITIES].sort()).toEqual(["episode", "history", "time_window"]);
    expect([MODEL_SCOPES.now, MODEL_SCOPES.timeZone]).toEqual([dataset.now, TIME_ZONE]);
    expect(dataset.memories.length).toBeGreaterThanOrEqual(150);
    expect(PHASE_ONE_QUESTIONS.length).toBeGreaterThanOrEqual(100);
    expect(PHASE_TWO_QUESTIONS.length).toBeGreaterThanOrEqual(30);
    const memories = new Set(dataset.memories.map(({ id }) => id));
    const episodes = new Set(dataset.episodes.map(({ id }) => id));
    for (const question of dataset.questions)
      for (const id of [...question.relevant, ...question.stale])
        expect(memories.has(id) || episodes.has(id), `${question.id} ${id}`).toBe(true);
  });

  it("does not fall below the Mem0 baseline in any ability and corrections stop stale answers", async () => {
    const results = [];
    for (const dimensions of [4096, 1024]) {
      const vectors = completeVectors(dimensions, requiredTexts(PHASE_ONE_QUESTIONS, false));
      if (vectors) results.push(await evaluate(dimensions, vectors));
    }
    if (results.length === 0) results.push(await evaluate(HASH_DIMENSIONS, null));
    for (const result of results) {
      report[`${result.mode}-${result.dimensions}`] = result;
      assertNotBelowBaseline(result);
      const engine = result.engine["knowledge_update"];
      const previous = result.phaseOne["knowledge_update"];
      expect(engine?.staleFree ?? 0).toBeGreaterThanOrEqual((previous?.staleFree ?? 0) + 0.1);
      expect(engine?.recallAt5 ?? 0).toBeGreaterThanOrEqual(previous?.recallAt5 ?? 0);
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
  }, 120_000);

  it("answers history, time-window and past-conversation questions that phase one could not", async () => {
    const results = [];
    for (const dimensions of [4096, 1024]) {
      const vectors = completeVectors(dimensions, requiredTexts(PHASE_TWO_QUESTIONS, true));
      if (vectors) results.push(await evaluatePhaseTwo(dimensions, vectors));
    }
    report["phaseTwoRealEmbeddings"] = results.length > 0;
    if (results.length === 0) results.push(await evaluatePhaseTwo(HASH_DIMENSIONS, null));
    for (const result of results) {
      report[`phase-two-${result.mode}-${result.dimensions}`] = result;
      const label = `${result.mode}/${result.dimensions}`;
      const window = result.engine["time_window"];
      const windowBefore = result.phaseOne["time_window"];
      expect(window?.recallAt5 ?? 0, `${label} time_window`).toBeGreaterThanOrEqual(
        (windowBefore?.recallAt5 ?? 0) + 0.3,
      );
      expect(window?.staleFree ?? 0, `${label} time_window stale`).toBeGreaterThanOrEqual(
        windowBefore?.staleFree ?? 0,
      );
      expect(result.engine["history"]?.recallAt5 ?? 0, `${label} history`).toBeGreaterThanOrEqual(
        result.phaseOne["history"]?.recallAt5 ?? 0,
      );
      expect(result.engine["episode"]?.recallAt5 ?? 0, `${label} episode`).toBeGreaterThanOrEqual(
        0.75,
      );
    }
    const scoped = await evaluatePhaseTwo(HASH_DIMENSIONS, null);
    const unscoped = await evaluatePhaseTwo(HASH_DIMENSIONS, null, () => undefined);
    report["phase-two-without-model-time-scope"] = unscoped.engine;
    expect(unscoped.engine["time_window"]?.recallAt5 ?? 0).toBeLessThan(
      (scoped.engine["time_window"]?.recallAt5 ?? 0) - 0.3,
    );
    expect(unscoped.engine["history"]?.recallAt5 ?? 0).toBeLessThan(
      scoped.engine["history"]?.recallAt5 ?? 0,
    );
  }, 180_000);
});
