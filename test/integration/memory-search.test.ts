import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_MEMORY_ATTRIBUTES,
  DurableMemoryService,
  type MemoryCategory,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import { type GatewayV2Snapshot, gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import { type Embedder, HybridMemoryProvider } from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionMemorySearch } from "../../apps/agent-service/src/production-memory-search.ts";
import { ProductionOwnerRuleWriter } from "../../apps/agent-service/src/production-owner-rules.ts";
import type { MailEmbeddingContext } from "../../apps/agent-service/src/production-run-memory.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-memory-search");
const AGENT_ID = createAgentId("agent-memory-search");
const THREAD_ID = createThreadId("thread-memory-search");
const GENERATION_ID = createMemoryGenerationId("generation-memory-search");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOW = "2026-11-26T01:00:00.000Z";
const TOPICS = [["过敏", "皮肤痒"], ["入管局"], ["京都"]];

function topicVector(text: string): Float32Array {
  const hits = TOPICS.map((words) => (words.some((word) => text.includes(word)) ? 1 : 0));
  return new Float32Array([...hits, hits.some(Boolean) ? 0 : 1]);
}

const embedder: Embedder = {
  model: "fixture-embedding",
  dimensions: TOPICS.length + 1,
  embedQuery: async (text) => topicVector(text),
  embedDocument: async (text) => topicVector(text),
};

type Snapshot = Extract<GatewayV2Snapshot, { type: "memory.search.snapshot" }>;

describe("[ADR-0286] phone memory search: one hybrid search over remembered facts and rules", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-memory-search-"));
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
      .run(THREAD_ID, OWNER_ID, AGENT_ID, NOW, NOW);
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (
          id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
          policy_version, status, attempt_count, requested_at
        ) VALUES ('checkpoint-search', ?, ?, ?, ?, 1, 1, 'memory-policy-v1', 'completed', 1, ?)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID, NOW);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES (?, 'checkpoint-search', ?, ?, ?, 'completed', 'model-fixture', 'memory-policy-v1', NULL)`,
      )
      .run(GENERATION_ID, OWNER_ID, AGENT_ID, THREAD_ID);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => NOW,
    });
    closers.push(() => repository.close());
    const protector = createReferenceAdapterSet().payloadProtector;
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const read = async (ref: string) => {
      const payload = await payloads.get(ref as never);
      if (!payload) return undefined;
      return new TextDecoder().decode(await protector.unprotect({ ...scope, payload }));
    };
    const provider = new HybridMemoryProvider({
      index: repository.memoryIndex(),
      embedder,
      embeddableClassifications: ["public", "private", "sensitive"],
      minimumSimilarity: 0.3,
      now: () => NOW,
    });
    const memory = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider,
      content: { readText: async (ref) => (await read(ref)) ?? "" },
      workerId: "memory-search-worker",
      now: () => NOW,
    });
    const rules = new ProductionOwnerRuleWriter({
      configuration: scope,
      rules: repository.ownerRules(),
      reviews: repository.ruleReviews(),
      memory,
      memories: repository.productMemoryState(),
      book: repository.memoryBook(),
      threads: repository.threadRepository(),
      payloads,
      protector,
      clock: { now: () => NOW },
    });
    const embeddingContexts: MailEmbeddingContext[] = [];
    const search = new ProductionMemorySearch({
      ...scope,
      provider,
      state: repository.productMemoryState(),
      rules,
      readText: (record) => read(record.contentRef),
      embedOutsideRun: (context, operation) => {
        embeddingContexts.push(context);
        return operation();
      },
      requestTimeoutMs: 5_000,
      clock: { now: () => NOW },
    });
    const remember = async (id: string, text: string, category: MemoryCategory = "preference") => {
      const contentRef = `payload-${id}`;
      await payloads.put(
        await protector.protect({
          ...scope,
          ref: contentRef as never,
          contentType: "text/plain",
          dataClassification: "private",
          plaintext: new TextEncoder().encode(text),
          createdAt: NOW,
        }),
      );
      await memory.applyProposal(
        {
          decision: "create",
          memory: {
            id: createMemoryId(id),
            ...scope,
            contentRef: contentRef as never,
            dataClassification: "private",
            sourceThreadId: THREAD_ID,
            sourceRefs: [`message-${id}`],
            inference: false,
            confidencePermille: 1000,
            policyVersion: "memory-policy-v1",
            attributes: { ...DEFAULT_MEMORY_ATTRIBUTES, category, validTo: null },
          },
        },
        GENERATION_ID,
      );
    };
    const ask = async (query: string) => {
      const snapshot = await search.query({
        schemaVersion: "gateway.v2",
        messageId: "message-search",
        correlationId: "correlation-search",
        causationId: null,
        dataClassification: "private",
        risk: "low",
        authorizationRef: null,
        scope,
        authority: { deploymentId: "deployment", authorityEpoch: 1, fencingToken: 1 },
        actor: { actorType: "owner", actorId: OWNER_ID },
        kind: "query",
        type: "memory.search.read",
        payload: { query },
      } as never);
      gatewayV2MessageSchema.parse(JSON.parse(JSON.stringify(snapshot)));
      return (snapshot as Snapshot).payload;
    };
    return { repository, memory, remember, ask, embeddingContexts };
  }

  it("finds a fact by meaning, not by the exact words, and tags rule hits with their rule", async () => {
    const f = await fixture();
    await f.remember("memory-peanut", "我吃花生会过敏，起疹子");
    await f.remember("memory-immigration", "入管局的邮件以后必须通知我", "rule");
    await f.remember("memory-kyoto", "周六去京都看红叶");
    await f.memory.runProjectionBatch(10);
    expect(
      await f.repository.ownerRules().create({
        ...scope,
        ruleId: "owner:immigration",
        parameters: {
          type: "mail_must_notify",
          summary: "日本入管局相关的邮件一律提醒",
          params: { senderDomains: ["isa.go.jp"] },
        },
        source: "chat:thread-memory-search",
        sourceMemoryId: "memory-immigration",
        now: NOW,
      }),
    ).toBe("created");

    const allergy = await f.ask("皮肤痒");
    expect(allergy.results).toEqual([
      {
        kind: "memory",
        memoryId: "memory-peanut",
        ruleId: null,
        text: "我吃花生会过敏，起疹子",
        category: "preference",
        tentative: false,
        updatedAt: NOW,
      },
    ]);
    expect(f.embeddingContexts).toHaveLength(1);

    const rule = await f.ask("入管局");
    expect(rule.results.map(({ kind, memoryId, ruleId }) => ({ kind, memoryId, ruleId }))).toEqual([
      { kind: "rule", memoryId: "memory-immigration", ruleId: "owner:immigration" },
    ]);
  });

  it("returns nothing for a query unrelated to every memory and rule", async () => {
    const f = await fixture();
    await f.remember("memory-peanut", "我吃花生会过敏，起疹子");
    await f.remember("memory-immigration", "入管局的邮件以后必须通知我", "rule");
    await f.memory.runProjectionBatch(10);

    const unrelated = await f.ask("钢琴课");
    expect(unrelated).toMatchObject({ query: "钢琴课", results: [] });
  });

  it("returns an empty list without searching when the query is only whitespace", async () => {
    const f = await fixture();
    await f.remember("memory-peanut", "我吃花生会过敏，起疹子");
    await f.memory.runProjectionBatch(10);

    expect((await f.ask("   ")).results).toEqual([]);
    expect(f.embeddingContexts).toEqual([]);
  });
});
