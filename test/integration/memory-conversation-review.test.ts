import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ApplicationPortError,
  DurableMemoryService,
  type MemoryProviderProjectionPort,
  type ProductMemoryAttributes,
  type ProductMemoryRecord,
  type RuntimeRequest,
} from "@himawari-agent/application";
import {
  createAgentId,
  createMemoryGenerationId,
  createMemoryId,
  createOwnerId,
  createRunId,
  createThreadId,
} from "@himawari-agent/domain";
import { undoConversationReview } from "@himawari-agent/memory-engine";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryCaptureCall } from "../../apps/agent-service/src/production-memory-capture.ts";
import {
  type ConversationReviewSettings,
  DEFAULT_CONVERSATION_REVIEW_SETTINGS,
  ProductionMemoryConversationReview,
} from "../../apps/agent-service/src/production-memory-conversation-review.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-conversation-review");
const AGENT_ID = createAgentId("agent-conversation-review");
const THREAD_ID = createThreadId("thread-conversation-review");
const SEED_GENERATION = createMemoryGenerationId("generation-conversation-review-seed");
const OLD_DAY = "2026-11-03T01:00:00.000Z";
const TALK_DAY = "2026-11-10T01:00:00.000Z";
const REVIEW_TIME = "2026-11-11T01:00:00.000Z";
const TIME_ZONE = "Asia/Tokyo";
const tag = (kind: string, value: string) =>
  [...createHash("sha256").update(`${kind}\0${value}`).digest("hex").slice(0, 8)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");

class SilentProvider implements MemoryProviderProjectionPort {
  async upsert(input: { readonly memory: ProductMemoryRecord }) {
    return `provider-${input.memory.id}`;
  }
  async delete() {}
  async search() {
    return [];
  }
  async clearScope() {}
}

type Line = {
  readonly role: "owner" | "agent";
  readonly text: string;
  readonly classification?: "private" | "restricted";
};

type Seed = {
  readonly id: string;
  readonly text: string;
  readonly at: string;
  readonly attributes?: Partial<ProductMemoryAttributes>;
};

const memoryItem = (overrides: Record<string, unknown>) => ({
  messageId: "message-2",
  kind: "decision",
  decision: "create",
  existingMemoryId: null,
  text: "主人下周三改去京都出差",
  classification: "private",
  topic: null,
  confidence: 950,
  inference: false,
  explicit: false,
  pattern: false,
  alsoSeenIn: [],
  category: "event",
  subCategory: null,
  importance: 600,
  entities: ["京都"],
  people: [],
  personLinks: [],
  validFrom: null,
  dueAt: null,
  repeat: "none",
  quote: "大阪那边取消了，改成去京都",
  stance: null,
  ...overrides,
});

const output = (...items: Record<string, unknown>[]) =>
  JSON.stringify({ memories: items.map(memoryItem) });

describe("[DREAM] daily conversation review", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup(input: {
    readonly lines: readonly Line[];
    readonly seeds?: readonly Seed[];
    readonly outputs: readonly (string | Error)[];
    readonly settings?: Partial<ConversationReviewSettings>;
    readonly onGenerate?: (memory: DurableMemoryService) => Promise<void>;
    readonly failAssertActiveAt?: number;
  }) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-conversation-review-"));
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
      .run(THREAD_ID, OWNER_ID, AGENT_ID, OLD_DAY, OLD_DAY);
    database
      .prepare(
        `INSERT INTO thread_checkpoint_jobs (
          id, generation_id, owner_id, agent_id, thread_id, revision, source_watermark,
          policy_version, status, attempt_count, requested_at
        ) VALUES ('checkpoint-conversation-review-seed', ?, ?, ?, ?, 1, 1,
          'memory-policy-seed', 'completed', 1, ?)`,
      )
      .run(SEED_GENERATION, OWNER_ID, AGENT_ID, THREAD_ID, OLD_DAY);
    database
      .prepare(
        `INSERT INTO memory_generations (
          id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
          model_descriptor_ref, policy_version, output_ref
        ) VALUES (?, 'checkpoint-conversation-review-seed', ?, ?, ?, 'completed',
          'model-memory-fixture', 'memory-policy-seed', NULL)`,
      )
      .run(SEED_GENERATION, OWNER_ID, AGENT_ID, THREAD_ID);
    database.close();
    const clock = { value: OLD_DAY };
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.value,
    });
    const adapters = createReferenceAdapterSet();
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const protect = async (
      ref: string,
      text: string,
      classification: "private" | "restricted" = "private",
    ) =>
      payloads.put(
        await adapters.payloadProtector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref,
          dataClassification: classification,
          contentType: "text/plain",
          plaintext: new TextEncoder().encode(text),
          createdAt: clock.value,
        }),
      );
    const readText = async (ref: string) => {
      const payload = await payloads.get(ref);
      if (!payload) throw new Error(`missing ${ref}`);
      return new TextDecoder().decode(await adapters.payloadProtector.unprotect({ payload }));
    };
    const memory = new DurableMemoryService({
      state: repository.productMemoryState(),
      jobs: repository.memoryProjectionJobs(),
      provider: new SilentProvider(),
      content: { readText },
      workerId: "conversation-review-test",
      now: () => clock.value,
    });
    for (const seed of input.seeds ?? []) {
      clock.value = seed.at;
      await protect(`payload-${seed.id}`, seed.text);
      await memory.applyProposal(
        {
          decision: "create",
          memory: {
            id: createMemoryId(seed.id),
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            contentRef: `payload-${seed.id}`,
            dataClassification: "private",
            sourceThreadId: THREAD_ID,
            sourceRefs: [`source-${seed.id}`],
            inference: false,
            confidencePermille: 950,
            policyVersion: "memory-policy-seed",
            attributes: {
              category: "event",
              importancePermille: 600,
              entities: [],
              validFrom: null,
              validTo: null,
              supersededBy: null,
              evidenceVerified: true,
              ...seed.attributes,
            },
          },
        },
        SEED_GENERATION,
      );
    }
    clock.value = TALK_DAY;
    const rows = openQualifiedDatabase(databasePath);
    for (const [index, line] of input.lines.entries()) {
      const sequence = index + 1;
      const at = new Date(Date.parse(TALK_DAY) + sequence * 60_000).toISOString();
      const ref = `payload-message-${sequence}`;
      await protect(ref, line.text, line.classification ?? "private");
      rows
        .prepare(
          `INSERT INTO thread_messages (
            id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
            classification, committed_at
          ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          `message-${sequence}`,
          OWNER_ID,
          AGENT_ID,
          THREAD_ID,
          sequence,
          line.role,
          ref,
          line.classification ?? "private",
          at,
        );
    }
    rows.close();
    await protect("payload-episode-1", "主人聊了出差计划。");
    await repository.memoryEpisodes().upsert({
      id: "episode:day_summary:thread-conversation-review:1",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      day: "2026-11-10",
      source: "day_summary",
      contentRef: "payload-episode-1",
      dataClassification: "private",
      firstSequence: 1,
      lastSequence: input.lines.length,
      startedAt: TALK_DAY,
      endedAt: TALK_DAY,
      createdAt: "2026-11-10T15:00:00.000Z",
      terms: [],
      embedding: null,
    });
    clock.value = REVIEW_TIME;
    const prompts: string[] = [];
    const calls: MemoryCaptureCall[] = [];
    const failures: unknown[] = [];
    const outputs = [...input.outputs];
    let activeChecks = 0;
    const review = new ProductionMemoryConversationReview({
      settings: () => ({ ...DEFAULT_CONVERSATION_REVIEW_SETTINGS, ...input.settings }),
      episodes: repository.memoryEpisodes(),
      store: repository.memoryConversationReviews(),
      threads: repository.threadRepository(),
      state: repository.productMemoryState(),
      search: async (request, _query, limit) =>
        (await repository.productMemoryState().listActive(request.ownerId, request.agentId))
          .toSorted((left, right) => left.id.localeCompare(right.id))
          .slice(0, limit)
          .map(({ id }) => ({ productMemoryId: id })),
      generations: repository.threadDistillationState(),
      product: memory,
      approvals: repository.sensitiveMemoryApprovals(),
      reminders: repository.memoryReminders(),
      book: repository.memoryBook(),
      ledger: repository.decisionLedger(),
      timeZone: TIME_ZONE,
      payloads,
      protector: adapters.payloadProtector,
      clock: { now: () => clock.value },
      assertActive: async () => {
        activeChecks += 1;
        if (activeChecks === input.failAssertActiveAt) throw new Error("AUTHORITY_LOST");
      },
      externalTag: async () => tag,
      generate: async (_request, prompt, onAdmitted, call) => {
        prompts.push(prompt);
        calls.push(call);
        onAdmitted();
        await input.onGenerate?.(memory);
        const next = outputs.shift() ?? '{"memories":[]}';
        if (next instanceof Error) throw next;
        return next;
      },
      onFailure: (error) => failures.push(error),
    });
    const request = {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: createRunId("run-conversation-review"),
      threadId: THREAD_ID,
      modelRef: "primary",
      dataClassification: "private",
    } as unknown as RuntimeRequest;
    const read = (id: string) => repository.productMemoryState().read(createMemoryId(id));
    const active = async () =>
      Promise.all(
        (await repository.productMemoryState().listActive(OWNER_ID, AGENT_ID)).map(
          async (record) => ({ record, text: await readText(record.contentRef) }),
        ),
      );
    const undo = (reviewId: string) =>
      undoConversationReview(
        {
          store: repository.memoryConversationReviews(),
          state: repository.productMemoryState(),
          memory,
          generationFor: async (memoryId) =>
            (await repository.memoryProjectionJobs().listByMemory(memoryId)).at(-1)?.generationId,
          now: () => clock.value,
        },
        reviewId,
      );
    return {
      review,
      request,
      repository,
      memory,
      prompts,
      calls,
      failures,
      read,
      active,
      undo,
      clock,
    };
  }

  const PLAN_CHANGE: readonly Line[] = [
    { role: "owner", text: "下周三我要去大阪出差，帮我想想带什么。" },
    { role: "agent", text: "好的，大阪出差可以带上充电器和雨伞。" },
    { role: "owner", text: "大阪那边取消了，改成去京都，时间不变。" },
  ];
  const OSAKA: Seed = { id: "osaka", text: "主人下周三去大阪出差", at: OLD_DAY };
  const SUPERSEDE = memoryItem({
    messageId: "message-3",
    decision: "supersede",
    existingMemoryId: "osaka",
  });

  it("replaces a plan the owner changed later in the conversation, and undoes the whole batch", async () => {
    const resource = await setup({
      lines: PLAN_CHANGE,
      seeds: [OSAKA],
      outputs: [JSON.stringify({ memories: [SUPERSEDE] })],
    });
    const [result] = await resource.review.runDue(resource.request);
    expect(resource.failures).toEqual([]);
    expect(result?.changes.map(({ action }) => action).sort()).toEqual(["created", "superseded"]);
    const kyoto = (await resource.active()).find(({ text }) => text.includes("京都"));
    expect(kyoto?.record.attributes?.tentative ?? false).toBe(false);
    expect((await resource.read("osaka"))?.attributes?.supersededBy).toBe(kyoto?.record.id);
    expect(resource.calls[0]?.maxOutputTokens).toBe(1024);

    const reviewId = result?.reviewId ?? "";
    await resource.undo(reviewId);
    expect((await resource.read("osaka"))?.attributes?.supersededBy ?? null).toBeNull();
    expect((await resource.read(kyoto?.record.id ?? ""))?.status).toBe("archived");
    await expect(resource.undo(reviewId)).rejects.toThrow("Conversation review undone");
  });

  it("does not read the same conversation twice and keeps the prompt bytes for the same data", async () => {
    const first = await setup({ lines: PLAN_CHANGE, seeds: [OSAKA], outputs: ['{"memories":[]}'] });
    await first.review.runDue(first.request);
    await first.review.runDue(first.request);
    expect(first.prompts).toHaveLength(1);
    const second = await setup({
      lines: PLAN_CHANGE,
      seeds: [OSAKA],
      outputs: ['{"memories":[]}'],
    });
    await second.review.runDue(second.request);
    expect(second.prompts[0]).toBe(first.prompts[0]);
    expect(first.prompts[0]?.endsWith("今天是 2026-11-11（主人所在时区）。")).toBe(true);
  });

  it("reuses the saved model answer when writing failed, instead of calling the model again", async () => {
    const resource = await setup({
      lines: PLAN_CHANGE,
      seeds: [OSAKA],
      outputs: [JSON.stringify({ memories: [SUPERSEDE] })],
      failAssertActiveAt: 3,
    });
    await expect(resource.review.runDue(resource.request)).rejects.toThrow("AUTHORITY_LOST");
    const [retried] = await resource.review.runDue(resource.request);
    expect(resource.prompts).toHaveLength(1);
    expect(retried?.changes.map(({ action }) => action).sort()).toEqual(["created", "superseded"]);
  });

  it("records a habit only when another day supports it", async () => {
    const lines: Line[] = [{ role: "owner", text: "今天早上又去公园晨跑了五公里，感觉很好。" }];
    const habit = {
      messageId: "message-1",
      kind: "durable_fact",
      text: "主人有早上晨跑的习惯",
      category: "preference",
      quote: "今天早上又去公园晨跑了五公里",
      pattern: true,
    };
    const supported = await setup({
      lines,
      seeds: [{ id: "run-before", text: "主人早上去公园晨跑", at: OLD_DAY }],
      outputs: [output({ ...habit, alsoSeenIn: ["run-before"] })],
    });
    const [kept] = await supported.review.runDue(supported.request);
    expect(kept?.changes.map(({ action }) => action)).toEqual(["created"]);

    const single = await setup({
      lines,
      outputs: [output({ ...habit, alsoSeenIn: ["message-1"] })],
    });
    const [dropped] = await single.review.runDue(single.request);
    expect(dropped?.changes).toEqual([]);
    expect(dropped?.skipped.pattern_single_day).toBe(1);
  });

  it("REVERSE: keeps nothing the owner did not say word for word, or that only Himawari said", async () => {
    const resource = await setup({
      lines: PLAN_CHANGE,
      outputs: [
        output(
          { messageId: "message-3", quote: "主人说取消了大阪改去京都" },
          { messageId: "message-2", text: "主人出差要带充电器", quote: "大阪出差可以带上充电器" },
        ),
      ],
    });
    const [result] = await resource.review.runDue(resource.request);
    expect(result?.changes).toEqual([]);
    expect(result?.skipped.unknown_message).toBe(1);
    expect((await resource.active()).map(({ text }) => text)).toEqual([]);
  });

  it("REVERSE: skips sensitive and inferred health facts without asking the owner", async () => {
    const lines: Line[] = [
      { role: "owner", text: "最近总是失眠，昨天只睡了三个小时，银行卡密码是 Abc12345 别忘了。" },
    ];
    const resource = await setup({
      lines,
      outputs: [
        output(
          {
            messageId: "message-1",
            text: "主人可能有睡眠障碍",
            category: "health",
            inference: true,
            confidence: 600,
            quote: "最近总是失眠，昨天只睡了三个小时",
          },
          {
            messageId: "message-1",
            text: "主人的银行卡密码是 Abc12345",
            classification: "sensitive",
            topic: "finance",
            category: "finance",
            quote: "银行卡密码是 Abc12345 别忘了",
          },
        ),
      ],
    });
    const [result] = await resource.review.runDue(resource.request);
    expect(result?.changes).toEqual([]);
    expect(result?.skipped.sensitive).toBe(1);
    expect(result?.skipped.inferred_private_topic).toBe(1);
    expect(
      await resource.repository.sensitiveMemoryApprovals().listPending(OWNER_ID, null),
    ).toEqual([]);
  });

  it("REVERSE: holds a replacement whose old memory is newer than what the owner said", async () => {
    const resource = await setup({
      lines: PLAN_CHANGE,
      seeds: [{ ...OSAKA, attributes: { validFrom: "2026-11-20" } }],
      outputs: [JSON.stringify({ memories: [SUPERSEDE] })],
    });
    const [result] = await resource.review.runDue(resource.request);
    expect(result?.changes.map(({ action }) => action)).toEqual(["created"]);
    expect((await resource.read("osaka"))?.attributes?.supersededBy ?? null).toBeNull();
    const kyoto = (await resource.active()).find(({ text }) => text.includes("京都"));
    expect(kyoto?.record.attributes?.tentative).toBe(true);
  });

  it("REVERSE: leaves a memory alone when the owner edited it during the review", async () => {
    const resource = await setup({
      lines: PLAN_CHANGE,
      seeds: [OSAKA],
      outputs: [JSON.stringify({ memories: [SUPERSEDE] })],
      onGenerate: async (memory) => {
        const current = await memory.revise({
          memoryId: createMemoryId("osaka"),
          expectedRevision: 1,
          generationId: SEED_GENERATION,
          attributes: { importancePermille: 900 },
        });
        expect(current.revision).toBe(2);
      },
    });
    const [result] = await resource.review.runDue(resource.request);
    expect(result?.changes).toEqual([]);
    expect((await resource.read("osaka"))?.attributes?.supersededBy ?? null).toBeNull();
  });

  it("REVERSE: refuses to undo a batch after the owner changed one of its memories", async () => {
    const resource = await setup({
      lines: PLAN_CHANGE,
      seeds: [OSAKA],
      outputs: [JSON.stringify({ memories: [SUPERSEDE] })],
    });
    const [result] = await resource.review.runDue(resource.request);
    const created = result?.changes.find(({ action }) => action === "created");
    const current = await resource.read(created?.memoryId ?? "");
    await resource.memory.revise({
      memoryId: createMemoryId(created?.memoryId ?? ""),
      expectedRevision: current?.revision ?? 0,
      generationId: SEED_GENERATION,
      attributes: { importancePermille: 900 },
    });
    const error = await resource.undo(result?.reviewId ?? "").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationPortError);
    expect((error as Error).message).toBe("MEMORY_CHANGED_AFTER_REVIEW");
    expect((await resource.read("osaka"))?.attributes?.supersededBy).toBe(created?.memoryId);
  });

  it("REVERSE: never shows a restricted message to the model", async () => {
    const resource = await setup({
      lines: [
        {
          role: "owner",
          text: "我的护照号是 E12345678，下周出国用。",
          classification: "restricted",
        },
        { role: "owner", text: "下周三我要去大阪出差，帮我想想带什么。" },
      ],
      outputs: ['{"memories":[]}'],
    });
    await resource.review.runDue(resource.request);
    expect(resource.prompts[0]).not.toContain("E12345678");
    expect(resource.prompts[0]).toContain("大阪出差");
  });

  it("REVERSE: stops at the daily limit of new memories and of conversations", async () => {
    const resource = await setup({
      lines: PLAN_CHANGE,
      outputs: [
        output(
          { messageId: "message-1", text: "主人下周三要出差", quote: "下周三我要去大阪出差" },
          { messageId: "message-3" },
        ),
      ],
      settings: { maximumNewMemoriesPerDay: 1 },
    });
    const [result] = await resource.review.runDue(resource.request);
    expect(result?.changes).toHaveLength(1);
    expect(result?.skipped.daily_limit).toBe(1);

    const closed = await setup({
      lines: PLAN_CHANGE,
      outputs: [output({ messageId: "message-3" })],
      settings: { maximumSegmentsPerDay: 0 },
    });
    expect(await closed.review.runDue(closed.request)).toEqual([]);
    expect(closed.prompts).toEqual([]);
  });

  it("REVERSE: does nothing when the review is switched off", async () => {
    const resource = await setup({
      lines: PLAN_CHANGE,
      outputs: [output({ messageId: "message-3" })],
      settings: { enabled: false },
    });
    expect(await resource.review.runDue(resource.request)).toEqual([]);
    expect(resource.prompts).toEqual([]);
  });
});
