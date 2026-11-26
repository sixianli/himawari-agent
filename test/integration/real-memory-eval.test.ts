import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DurableMemoryService,
  type MemoryContentPort,
  modelVisibleClassifications,
  type PayloadRef,
  type RealEvalModel,
  RealMemoryEvalService,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import { type Embedder, HybridMemoryProvider, indexTerms } from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  REAL_EVAL_ANSWER,
  REAL_EVAL_JUDGE,
  REAL_EVAL_LEAK_JUDGE,
  REAL_EVAL_QUESTION,
} from "@himawari-agent/prompt-catalog";
import { afterEach, describe, expect, it } from "vitest";
import { readRuns } from "../../scripts/operations/real-eval-report.mjs";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-real-eval");
const AGENT_ID = createAgentId("agent-real-eval");
const THREAD_ID = createThreadId("thread-real-eval");
const GENERATION_ID = createMemoryGenerationId("generation-real-eval");
const DIMENSIONS = 32;
const T0 = "2026-11-01T00:00:00.000Z";

class TermEmbedder implements Embedder {
  readonly model = "fixture-term-embedding";
  readonly dimensions = DIMENSIONS;

  embedQuery(query: string): Promise<Float32Array> {
    return this.embed(query);
  }

  embedDocument(text: string): Promise<Float32Array> {
    return this.embed(text);
  }

  async embed(text: string): Promise<Float32Array> {
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

class MapContent implements MemoryContentPort {
  readonly values = new Map<string, string>();
  async readText(ref: string): Promise<string> {
    const value = this.values.get(ref);
    if (value === undefined) throw new Error(`Missing content ${ref}`);
    return value;
  }
}

const MEMORIES = [
  {
    id: "latte",
    text: "主人早上喝燕麦拿铁咖啡，不加糖",
    quote: "我早上都喝燕麦拿铁，不加糖",
    tentative: false,
    question: "我早上一般喝什么咖啡？",
    abstain: "我妹妹早上一般喝什么咖啡？",
    kind: "preference",
  },
  {
    id: "osaka",
    text: "主人十二月三日去大阪出差",
    quote: "十二月三日我要去大阪出差",
    tentative: false,
    question: "我下个月出差去哪个城市？",
    abstain: "我同事下个月出差去哪个城市？",
    kind: "fact",
  },
  {
    id: "job",
    text: "主人可能在考虑换工作",
    quote: "最近有点想换工作",
    tentative: true,
    question: "我最近在考虑什么？",
    abstain: null,
    kind: "fact",
  },
] as const;

describe.each(["worker", "direct"] as const)("[P4-5] real memory eval through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-real-eval-"));
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
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (
          id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
          policy_version, status, attempt_count, requested_at
        ) VALUES ('checkpoint-real-eval', ?, ?, ?, ?, 1, 1, 'memory-policy-v1', 'completed', 1, ?)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, T0);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES (?, 'checkpoint-real-eval', ?, ?, ?, 'completed', 'model-fixture',
          'memory-policy-v1', NULL)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
    database.close();
    const insertPayload = (ref: string) => {
      const connection = openQualifiedDatabase(databasePath);
      try {
        connection
          .prepare(
            `INSERT INTO payloads (
              ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
              encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
            ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
              'active', ?, 'text/plain')`,
          )
          .run(ref, OWNER_ID, AGENT_ID, `sha256:${ref}`, T0);
      } finally {
        connection.close();
      }
    };
    const clock = { value: T0 };
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.value,
    });
    const content = new MapContent();
    for (const item of MEMORIES) {
      insertPayload(`payload-${item.id}`);
      content.values.set(`payload-${item.id}`, item.text);
    }
    const memory = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider: new HybridMemoryProvider({
        index: repository.memoryIndex(),
        embedder: new TermEmbedder(),
        embeddableClassifications: ["public", "private"],
        now: () => clock.value,
      }),
      content,
      workerId: "real-eval-worker",
      now: () => clock.value,
      maximumProjectionAttempts: 3,
      projectionLeaseMs: 10_000,
    });
    for (const item of MEMORIES)
      await memory.applyProposal(
        {
          decision: "create",
          memory: {
            id: createMemoryId(item.id),
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            contentRef: `payload-${item.id}`,
            dataClassification: "private",
            sourceThreadId: THREAD_ID,
            sourceRefs: [`message-${item.id}`],
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
              tentative: item.tentative,
            },
          },
        },
        GENERATION_ID,
      );
    await memory.runProjectionBatch(50);
    clock.value = "2026-11-11T00:00:00.000Z";
    return { repository, memory, content, clock, databasePath, insertPayload };
  }

  function stubModel(answer: (question: string) => string) {
    const prompts: string[] = [];
    const model: RealEvalModel = {
      modelRef: "eval-fixture-model",
      estimateMicros: () => 100,
      async generate({ prompt }) {
        prompts.push(prompt);
        const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as Record<
          string,
          unknown
        >;
        if (prompt.startsWith(REAL_EVAL_QUESTION.text)) {
          const item = MEMORIES.find(({ quote }) => quote === data["quote"]);
          return {
            output: JSON.stringify({
              question: item?.question ?? null,
              kind: item?.kind ?? null,
              abstainQuestion: item?.abstain ?? null,
            }),
            costMicros: 40,
          };
        }
        if (prompt.startsWith(REAL_EVAL_ANSWER.text))
          return { output: answer(String(data["question"])), costMicros: 30 };
        if (prompt.startsWith(REAL_EVAL_JUDGE.text)) {
          const response = String(data["response"]);
          const abstain = data["abstain"] === true;
          const declined = response.includes("没有这条记忆");
          const verdict = abstain
            ? declined
              ? "correct"
              : "wrong"
            : declined
              ? "abstained"
              : response.includes("大阪") || response.includes("燕麦")
                ? "correct"
                : "wrong";
          return { output: JSON.stringify({ verdict }), costMicros: 10 };
        }
        if (prompt.startsWith(REAL_EVAL_LEAK_JUDGE.text))
          return { output: '{"leaks":false}', costMicros: 5 };
        throw new Error("UNEXPECTED_PROMPT");
      },
    };
    return { model, prompts };
  }

  function service(
    resource: Awaited<ReturnType<typeof fixture>>,
    model: RealEvalModel,
  ): RealMemoryEvalService {
    let sequence = 0;
    return new RealMemoryEvalService({
      scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
      store: resource.repository.realEval(),
      model,
      now: () => resource.clock.value,
      newId: () => `real-eval-${++sequence}`,
      promptSha256: "c".repeat(64),
      recallEstimateMicros: 0,
      listMemories: () => resource.repository.productMemoryState().listActive(OWNER_ID, AGENT_ID),
      readMemoryText: async (record) => resource.content.values.get(record.contentRef),
      readQuote: async (record) => MEMORIES.find(({ id }) => id === record.id)?.quote,
      storeQuestion: async ({ text }) => {
        const ref = `real-eval-question-${++sequence}`;
        resource.insertPayload(ref);
        resource.content.values.set(ref, text);
        return ref;
      },
      readQuestion: async (ref) => resource.content.values.get(ref),
      discardQuestion: async (ref) => {
        await resource.repository.payloadStore(OWNER_ID, AGENT_ID).delete(ref as PayloadRef);
        resource.content.values.delete(ref);
      },
      recall: async (question) => {
        const found = await resource.memory.search({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          queryRef: "",
          queryText: question,
          recordUse: false,
          policy: { limit: 5, allowedClassifications: modelVisibleClassifications() },
        });
        return {
          memories: found.map(({ memory }) => ({
            id: memory.id,
            text: resource.content.values.get(memory.contentRef) ?? "",
            dataClassification: memory.dataClassification,
          })),
          costMicros: 0,
        };
      },
      profile: async () => ({ memoryIds: [], texts: [], dataClassification: "public" }),
    });
  }

  it("banks questions from confirmed memories only, scores through real search and stores numbers only", async () => {
    const resource = await fixture();
    const { model, prompts } = stubModel((question) =>
      question.includes("妹妹") || question.includes("同事")
        ? "我没有这条记忆。"
        : question.includes("咖啡")
          ? "你早上喝燕麦拿铁。"
          : "你下个月去大阪。",
    );
    const report = await service(resource, model).run("manual", {
      capMicros: 500_000,
      newMemoriesPerRun: 10,
    });

    expect(report.outcome).toBe("completed");
    expect(prompts.some((prompt) => prompt.includes("最近有点想换工作"))).toBe(false);
    expect(prompts.some((prompt) => prompt.startsWith(REAL_EVAL_LEAK_JUDGE.text))).toBe(true);
    const questions = await resource.repository
      .realEval()
      .listQuestions({ ownerId: OWNER_ID, agentId: AGENT_ID });
    expect(questions.map(({ memoryId, kind }) => `${memoryId}:${kind}`).sort()).toEqual([
      "latte:abstain",
      "latte:preference",
      "osaka:abstain",
      "osaka:fact",
    ]);
    const used = await resource.repository
      .productMemoryState()
      .readMany({ ownerId: OWNER_ID, agentId: AGENT_ID, memoryIds: [createMemoryId("latte")] });
    expect(used[0]?.lastUsedAt).toBeNull();

    const connection = openQualifiedDatabase(resource.databasePath);
    try {
      const [run] = readRuns(connection);
      expect(run).toMatchObject({
        trigger: "manual",
        outcome: "completed",
        model: "eval-fixture-model",
        costMicros: report.costMicros,
        added: 4,
        items: 4,
      });
      expect(run?.scores.fresh).toMatchObject({ successes: 2, samples: 2 });
      expect(run?.scores.abstain).toMatchObject({ successes: 2, samples: 2 });
      expect(run?.scores.retrieval).toMatchObject({ successes: 2, samples: 2 });
      const stored = connection.prepare("SELECT summary FROM real_eval_runs").get() as {
        summary: string;
      };
      expect(stored.summary).not.toMatch(/燕麦|大阪|咖啡/u);
    } finally {
      connection.close();
    }
  });

  it("retires questions of a revised memory on real storage and banks new ones without failing", async () => {
    const resource = await fixture();
    const { model } = stubModel((question) =>
      question.includes("妹妹") || question.includes("同事") ? "我没有这条记忆。" : "你去大阪。",
    );
    const evaluator = service(resource, model);
    await evaluator.run("weekly", { capMicros: 500_000, newMemoriesPerRun: 10 });
    const connection = openQualifiedDatabase(resource.databasePath);
    try {
      connection
        .prepare("UPDATE memory_records SET revision = revision + 1 WHERE id = ?")
        .run("latte");
    } finally {
      connection.close();
    }
    const second = await evaluator.run("weekly", { capMicros: 500_000, newMemoriesPerRun: 10 });

    expect(second.outcome).toBe("completed");
    expect(second.summary).toMatchObject({ retired: 2, added: 2 });
    const questions = await resource.repository
      .realEval()
      .listQuestions({ ownerId: OWNER_ID, agentId: AGENT_ID });
    const retired = questions.filter(({ retiredAt }) => retiredAt !== null);
    expect(retired.map(({ memoryId, memoryRevision }) => `${memoryId}@${memoryRevision}`)).toEqual([
      "latte@1",
      "latte@1",
    ]);
    const payloads = resource.repository.payloadStore(OWNER_ID, AGENT_ID);
    for (const { questionRef } of retired)
      expect(await payloads.get(questionRef as PayloadRef)).toBeDefined();
  });

  it("counts a made-up answer to a question about something never said as wrong", async () => {
    const resource = await fixture();
    const { model } = stubModel((question) =>
      question.includes("咖啡") ? "早上喝美式。" : "去福冈。",
    );
    const report = await service(resource, model).run("manual", {
      capMicros: 500_000,
      newMemoriesPerRun: 10,
    });
    const scores = (report.summary as { scores: Record<string, unknown> }).scores;
    expect(scores["abstain"]).toMatchObject({ successes: 0, samples: 2 });
    expect(scores["fresh"]).toMatchObject({ successes: 0, samples: 2 });
  });
});
